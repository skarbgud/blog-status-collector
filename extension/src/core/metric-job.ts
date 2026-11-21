// 지표 수집 계획과 실행. Java collector/metric/MetricCollectJob을 옮겼다.
// - 같은 API를 쓰는 지표는 한 번의 요청으로 함께 받는다(requestKey).
// - 시계열은 15일 창으로 거슬러 올라가고(주간은 한 번), 하루·주·월 단위는 이미 받은 날짜를 건너뛴다(force 아니면).
// - 게시글별 지표는 순위에 나온 게시글마다 부르므로 순위를 받은 뒤 맨 마지막에 계획한다.
// - 한 요청이 실패해도 나머지는 계속한다. 로그인 만료는 그대로 멈추고, 요청 상한에 닿으면 멈춘 뒤 다음에 이어 받는다.
import { addDays, isoDayOfWeek, previousMonthStart } from './dates.js';
import { MetricParseError, parseMetric, type MetricRow } from './metric-parser.js';
import { BudgetExceededError, HttpStatusError } from './naver.js';
import { SERIES_WINDOW_DAYS, isSeries, isValue, requestKey, type MetricSpec } from './specs.js';

/** 지표 저장소. 런타임은 SQLite, 테스트는 메모리 구현을 쓴다. */
export interface MetricStore {
  /** 그 지표가 이미 저장된(빈 표시 포함) 날짜들 */
  datesWith(metric: string, from: string, to: string): Promise<Set<string>>;
  /** 그 지표·날짜에 저장된 행 구분값들 */
  keysWith(metric: string, date: string): Promise<Set<string>>;
  /** 기간 안의 조회수·공감·댓글 순위에 나온 게시글 번호(오름차순) */
  postIds(from: string, to: string): Promise<string[]>;
  /** rows의 날짜들(rowKey가 있으면 그 행 구분만) 기존 행을 지우고 넣는다. 빈 표시를 뺀 행 수를 돌려준다 */
  replace(metric: string, rows: MetricRow[], rowKey: string | null): Promise<number>;
  /** 그 지표·날짜의 행을 지운다(집계 전 잠정값 정리) */
  clear(metric: string, date: string): Promise<number>;
}

/** 통계 API GET. 200이 아니면 HttpStatusError, 로그인 만료·상한·차단은 각자의 오류를 던진다. */
export interface StatGetter {
  get(path: string, params: Record<string, string>, label: string): Promise<string>;
}

export interface MetricPlan {
  specs: readonly MetricSpec[];
  from: string;
  to: string;
  force: boolean;
  /** 오늘(KST). 이 날짜 이후의 시계열 행은 버린다 */
  today: string;
}

export interface MetricResult {
  saved: Record<string, number>;
  failures: number;
  budgetStopped: boolean;
}

export interface JobLog {
  (level: 'info' | 'warn', message: string): void;
}

interface Unit {
  startDate: string;
  requested: string;
  /** 게시글 번호 또는 두 자리 시간. 행 구분으로도 쓴다 */
  postId: string | null;
  specs: MetricSpec[];
  /** 게시글을 조회할 수 없을 때 표시를 남길 정보 지표 */
  marker: MetricSpec | null;
}

export const UNAVAILABLE_PAYLOAD = '{"unavailable":true}';

export class MetricJob {
  constructor(
    private readonly store: MetricStore,
    private readonly log: JobLog = () => {},
  ) {}

  async execute(http: StatGetter, plan: MetricPlan): Promise<MetricResult> {
    const result: MetricResult = { saved: {}, failures: 0, budgetStopped: false };
    try {
      for (const unit of await this.plainUnits(plan)) await this.fetch(http, unit, plan, result);
      for (const unit of await this.hourUnits(plan)) await this.fetch(http, unit, plan, result);
      // 게시글 번호는 위에서 받은 순위에서 나오므로 그 뒤에 계획한다.
      for (const unit of await this.postUnits(plan)) await this.fetch(http, unit, plan, result);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        this.log('info', '[예산] ' + e.message);
        result.budgetStopped = true;
        return result;
      }
      throw e;
    }
    return result;
  }

  /** 이번 계획이 보낼 요청 수 어림(게시글별은 지금 저장된 순위 기준). */
  async estimateRequests(plan: MetricPlan): Promise<number> {
    return (await this.plainUnits(plan)).length + (await this.hourUnits(plan)).length + (await this.postUnits(plan)).length;
  }

  private async fetch(http: StatGetter, unit: Unit, plan: MetricPlan, result: MetricResult): Promise<void> {
    const first = unit.specs[0]!;
    const label = first.id + (unit.specs.length > 1 ? '+' + (unit.specs.length - 1) : '') + ' ' + unit.startDate
      + (unit.postId !== null ? ' 글 ' + unit.postId : '');
    let body: string;
    try {
      body = await http.get(first.path, unitParams(first, unit.startDate, unit.postId), label);
    } catch (e) {
      if (!(e instanceof HttpStatusError)) throw e;
      if (first.perPost && e.status === 400) {
        await this.markUnavailable(unit);
        return;
      }
      result.failures++;
      this.log('warn', '[경고] ' + label + ' 수집 실패, 건너뜁니다: ' + e.message);
      return;
    }
    for (const spec of unit.specs) {
      try {
        const rows = parseMetric(body, spec, unit.requested, plan.today, unit.postId);
        if (rows.length === 0 && !isSeries(spec) && !isValue(spec)) {
          // 네이버가 아직 집계하지 않은 날. 저장하지 않고(다음에 다시 받는다), 앞서 저장된 잠정값은 지운다.
          await this.store.clear(spec.id, unit.requested);
          this.log('info', '[집계 전] ' + spec.id + ' ' + unit.requested + ' 아직 확정되지 않아 저장하지 않습니다.');
          continue;
        }
        const n = await this.store.replace(spec.id, rows, unit.postId);
        result.saved[spec.id] = (result.saved[spec.id] ?? 0) + n;
      } catch (e) {
        if (!(e instanceof MetricParseError)) throw e;
        result.failures++;
        this.log('warn', '[경고] ' + spec.id + ' ' + unit.startDate + ' 응답을 읽지 못해 건너뜁니다: ' + e.message);
      }
    }
  }

  /**
   * 게시글 요청이 HTTP 400이면 삭제·비공개 글로 보고 실패로 세지 않고 "조회 불가" 표시를 정보 지표에 남긴다.
   * 수집한 날짜(to)로 저장되므로 그 날은 다시 부르지 않고 다음 날 한 번 다시 확인한다.
   * 시계열 지표에 남기면 값 없는 가짜 행이 되어 그 글이 조회수 0인 글로 보이므로 정보 지표에만 남긴다.
   */
  private async markUnavailable(unit: Unit): Promise<void> {
    const spec = unit.marker!;
    await this.store.replace(spec.id, [{
      statDate: unit.requested, metric: spec.id, rowKey: unit.postId!, payload: UNAVAILABLE_PAYLOAD,
    }], unit.postId);
    this.log('info', '[건너뜀] 글 ' + unit.postId + ' 조회 불가(HTTP 400, 삭제·비공개로 추정). 내일 다시 확인합니다.');
  }

  // ---- 계획 ----

  /** 게시글과 무관한 요청: 시계열 → 하루 단위(최신 날짜부터) → 주 단위 → 월 단위. */
  private async plainUnits(plan: MetricPlan): Promise<Unit[]> {
    const series: Unit[] = [];
    const byDate = new Map<string, Map<string, MetricSpec[]>>();
    const weekly: Unit[] = [];
    const values: Unit[] = [];
    const seriesGroups = new Map<string, MetricSpec[]>();

    for (const spec of plan.specs) {
      if (spec.perPost || spec.perHour) continue;
      if (isSeries(spec)) {
        push(seriesGroups, requestKey(spec), spec);
      } else if (isValue(spec) && spec.timeDim === 'MONTH') {
        const month = previousMonthStart(plan.to);
        if (await this.needs(spec, month, month, plan)) values.push(unit(month, month, [spec]));
      } else if (spec.timeDim === 'WEEK') {
        for (const week of weekStarts(plan)) {
          if (await this.needs(spec, week, week, plan)) weekly.push(unit(week, week, [spec]));
        }
      } else {
        const have = plan.force ? new Set<string>() : await this.store.datesWith(spec.id, plan.from, plan.to);
        for (let d = plan.to; d >= plan.from; d = addDays(d, -1)) {
          if (have.has(d)) continue;
          let groups = byDate.get(d);
          if (!groups) byDate.set(d, (groups = new Map()));
          push(groups, requestKey(spec), spec);
        }
      }
    }
    for (const group of seriesGroups.values()) {
      for (const start of seriesStarts(group[0]!, plan)) series.push(unit(start, start, group));
    }
    const days: Unit[] = [];
    for (const date of [...byDate.keys()].sort().reverse()) {
      for (const group of byDate.get(date)!.values()) days.push(unit(date, date, group));
    }
    return [...series, ...days, ...weekly, ...values];
  }

  /** 시간대(0~23시)마다 시계열 창 수만큼. 이미 받은 시간대는 건너뛴다(force 아니면). */
  private async hourUnits(plan: MetricPlan): Promise<Unit[]> {
    const specs = plan.specs.filter((s) => s.perHour);
    if (specs.length === 0) return [];
    const series = specs[0]!;
    const have = plan.force ? new Set<string>() : await this.store.keysWith(series.id, plan.to);
    const units: Unit[] = [];
    for (let h = 0; h < 24; h++) {
      const hour = String(h).padStart(2, '0'); // hour=5처럼 보내면 0~9시가 모두 0으로 온다
      if (have.has(hour)) continue;
      for (const start of seriesStarts(series, plan)) {
        units.push({ startDate: start, requested: plan.to, postId: hour, specs: [...specs], marker: null });
      }
    }
    return units;
  }

  /** 순위에 나온 게시글마다 시계열 창 수만큼. 이미 받은 게시글은 건너뛴다(force 아니면). */
  private async postUnits(plan: MetricPlan): Promise<Unit[]> {
    const specs = plan.specs.filter((s) => s.perPost);
    if (specs.length === 0) return [];
    const series = specs.find(isSeries) ?? specs[0]!;
    const marker = specs.find(isValue) ?? specs[0]!;
    // 시계열이든 정보든(조회 불가 표시 포함) 그 날짜에 하나라도 저장돼 있으면 이미 받은 게시글이다.
    const have = new Set<string>();
    if (!plan.force) {
      for (const s of specs) for (const k of await this.store.keysWith(s.id, plan.to)) have.add(k);
    }
    const units: Unit[] = [];
    for (const post of await this.store.postIds(plan.from, plan.to)) {
      if (have.has(post)) continue;
      let firstWindow = true;
      for (const start of seriesStarts(series, plan)) {
        // 게시글마다 요청 한 번에 시계열과 정보를 함께 읽으므로 첫 창에만 정보 지표를 붙인다.
        const forWindow = firstWindow ? [...specs] : specs.filter(isSeries);
        units.push({ startDate: start, requested: plan.to, postId: post, specs: forWindow, marker });
        firstWindow = false;
      }
    }
    return units;
  }

  private async needs(spec: MetricSpec, checkFrom: string, date: string, plan: MetricPlan): Promise<boolean> {
    if (plan.force) return true;
    return !(await this.store.datesWith(spec.id, checkFrom, date)).has(date);
  }
}

function unit(startDate: string, requested: string, specs: MetricSpec[]): Unit {
  return { startDate, requested, postId: null, specs, marker: null };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** 시계열 startDate들. 일별은 to에서 15일씩 거슬러 from을 덮을 때까지, 주간은 마지막으로 끝난 주 한 번. */
function seriesStarts(spec: MetricSpec, plan: MetricPlan): string[] {
  if (spec.timeDim === 'WEEK') return [lastCompleteWeekStart(plan.to)];
  const starts: string[] = [];
  for (let end = plan.to; end >= plan.from; end = addDays(end, -SERIES_WINDOW_DAYS)) starts.push(end);
  return starts;
}

/** to를 포함해 끝난 마지막 주의 월요일. to가 일요일이면 그 주도 끝난 주다. */
export function lastCompleteWeekStart(to: string): string {
  const dow = isoDayOfWeek(to);
  const monday = addDays(to, -(dow - 1));
  return dow === 7 ? monday : addDays(monday, -7);
}

/** 기간과 겹치는 끝난 주들의 월요일(최신순). */
function weekStarts(plan: MetricPlan): string[] {
  const weeks: string[] = [];
  for (let w = lastCompleteWeekStart(plan.to); addDays(w, 6) >= plan.from; w = addDays(w, -7)) weeks.push(w);
  return weeks;
}

/** 요청 쿼리. 순서는 화면(그리고 Java 버전)과 같다. 시간대는 두 자리 hour, 게시글은 contentId. */
export function unitParams(spec: MetricSpec, startDate: string, postId: string | null): Record<string, string> {
  const params: Record<string, string> = { timeDimension: spec.timeDim, startDate };
  if (postId !== null) params[spec.perHour ? 'hour' : 'contentId'] = postId;
  for (const [k, v] of new URLSearchParams(spec.extraQuery.replace(/^&/, ''))) params[k] = v;
  params.exclude = '';
  return params;
}
