// 수집 회차 하나. "로그인돼 있으면 수집한다" 정책의 본체이고, 오프스크린 문서가 트리거마다 부른다.
// 요청을 보내기 전에 로컬에서 판단할 수 있는 것은 모두 먼저 판단한다(요청 0회로 끝나는 경우):
//   04:00 KST 전 / 오늘 이미 끝남 / 하루 상한 소진 / 최근 로그인 실패(6시간 안) / 다른 계정에 묶임(로그인 확인 후)
// 그다음 user-info로 로그인과 블로그 ID를 확인하고, 어제까지 30일 범위에서 빠진 것만 받는다.
//   1) 유입경로·검색어·상세 URL: 받지 않은 날짜(최신순)
//      상세 URL만 없는 날짜(가져온 H2 데이터, URL 수집 전에 받은 날)는 저장된 유입처 목록으로 URL만 보충한다
//   2) 지표 시계열: 처음이면 30일(15일 창 2번), 이후에는 어제를 포함한 창 1번(늦게 확정된 값도 덮어쓴다)
//   3) 나머지 지표: 받지 않은 날짜·시간대·게시글(MetricJob)
// "지금 수집"(refetchDays)은 여기에 더해 최근 N일(기본 어제 하루)을 이미 있어도 다시 받아 날짜 단위로 덮어쓴다.
// 행 단위 upsert가 아니라 날짜 단위 교체인 이유: 네이버가 다시 집계해 사라진 유입처·검색어 행이 남지 않게 하려고.
// 다시 받을 때 집계 전 빈 값이 오면 확정된 기존 값은 지우지 않는다(keepOnPending).
import { addDays } from './dates.js';
import { MetricJob, type JobLog, type MetricPlan, type StatGetter } from './metric-job.js';
import { RefererParseError, fetchRefererDay, fetchRefererUrls, type RefererRow } from './referer.js';
import {
  BudgetExceededError, ClientBlockedError, HttpStatusError, SessionExpiredError, USER_INFO_PATH,
  buildQuery, kstDate, kstHour, parseBlogId, type StatClient,
} from './naver.js';
import { ALL, isSeries, type MetricSpec } from './specs.js';
import { deleteSetting, getSetting, setSetting, type Sql } from './sql.js';
import { SqlMetricStore, SqlRefererStore } from './store.js';

/** 하루 요청 상한. 0 이하면 상한 없음(기본, 2026-11-21 사용자 결정). 요청 사이 1~2초와 401/403 중단은 그대로다. */
export const DEFAULT_DAILY_CAP = 0;
export const hasCap = (cap: number) => Number.isFinite(cap) && cap > 0;
export const RANGE_DAYS = 30;
/** 네이버가 어제분(순방문자·시간대)을 확정하는 시각. 2026-11-21 02:36엔 0, 03:20대엔 확정돼 있었다. */
export const READY_HOUR_KST = 4;
export const LOGIN_RETRY_MS = 6 * 3600_000;
export const RAW_KEEP_DAYS = 14;
/** "지금 수집"이 다시 받는 기본 일수(어제 하루)와 옵션 페이지에서 고를 수 있는 최대 일수. */
export const REFETCH_DEFAULT_DAYS = 1;
export const REFETCH_MAX_DAYS = 7;

export const S = {
  blogId: 'blog_id',
  dailyCap: 'daily_cap',
  completeDate: 'complete_date',
  /** 마지막으로 끝난 회차 뒤에 남은 할 일 수("KST날짜|개수"). 같은 실패만 남았으면 그날은 다시 돌지 않는다 */
  missingAfter: 'missing_after',
  loginFailedAt: 'login_failed_at',
  otherAccount: 'other_account_seen_at',
} as const;

export type Outcome =
  | 'done'            // 받을 것을 다 받음
  | 'partial'         // 집계 전 값이 있어 다음 확인 때 다시 받음
  | 'up-to-date'      // 오늘 끝났고 새 할 일이 없음(요청 0회)
  | 'waiting'         // 04:00 KST 전(요청 0회)
  | 'cap-reached'     // 하루 상한(요청 0회 또는 도중 멈춤). 내일 이어서
  | 'login-required'  // 로그인 안 됨·만료
  | 'login-backoff'   // 최근 로그인 실패라 잠시 쉼(요청 0회)
  | 'other-account'   // 처음 묶인 블로그와 다른 계정
  | 'error';          // 네트워크 등. 다음 확인 때 다시

export interface RunReport {
  outcome: Outcome;
  message: string;
  requests: number;
  saved: Record<string, number>;
  failures: number;
}

export interface CollectorDeps {
  sql: Sql;
  /** 회차 요청 상한으로 클라이언트를 만든다(하루 상한에서 오늘 쓴 만큼 뺀 값). */
  makeClient(maxRequests: number): StatClient;
  now?: Date;
  log?: JobLog;
  trigger: string;
  /** 사용자가 "지금 수집"을 누름: 오늘 끝남·로그인 실패 대기를 무시한다(시각·상한은 지킨다). */
  manual?: boolean;
  /** 0보다 크면 어제부터 거슬러 이 일수만큼은 이미 받았어도 다시 받아 덮어쓴다(1~REFETCH_MAX_DAYS). */
  refetchDays?: number;
}

export async function runCollection(deps: CollectorDeps): Promise<RunReport> {
  const { sql } = deps;
  const now = deps.now ?? new Date();
  const log: JobLog = deps.log ?? (() => {});
  const today = kstDate(0, now);
  const iso = now.toISOString();
  const report: RunReport = { outcome: 'done', message: '', requests: 0, saved: {}, failures: 0 };
  const finish = (outcome: Outcome, message: string) => {
    report.outcome = outcome;
    report.message = message;
    log('info', '[' + outcome + '] ' + message);
    return report;
  };

  // ---- 요청 없이 판단 ----
  if (kstHour(now) < READY_HOUR_KST) {
    return finish('waiting', '네이버가 어제 통계를 확정하는 04:00 이후에 받습니다.');
  }
  // 오늘 끝났어도 새 할 일(새 수집 기능, 보충할 날짜)이 생겼으면 다시 돈다. 로컬 계산만 하므로 요청 0회다.
  // 지난 회차 뒤 남은 개수와 같으면 같은 실패만 남은 것이라 그날은 쉰다(API 변경 시 30분마다 재요청 폭주 방지).
  if (!deps.manual && (await getSetting(sql, S.completeDate)) === today) {
    const missing = await missingWork(sql, today);
    if (missing === 0) return finish('up-to-date', '오늘 받을 것은 모두 받았습니다.');
    if ((await getSetting(sql, S.missingAfter)) === today + '|' + missing) {
      return finish('up-to-date', '오늘 받을 것은 받았습니다. 실패한 ' + missing + '건은 내일 다시 받습니다.');
    }
  }
  const failedAt = await getSetting(sql, S.loginFailedAt);
  if (!deps.manual && failedAt && now.getTime() - Date.parse(failedAt) < LOGIN_RETRY_MS) {
    return finish('login-backoff', '최근 로그인 확인에 실패해 잠시 쉽니다. 네이버에 로그인한 뒤 "지금 수집"을 누르세요.');
  }
  const cap = Number((await getSetting(sql, S.dailyCap)) ?? DEFAULT_DAILY_CAP);
  const usedToday = Number((await sql.query('SELECT COALESCE(SUM(requests), 0) AS n FROM run_log WHERE kst_date = ?', [today]))[0]?.n ?? 0);
  const remaining = hasCap(cap) ? cap - usedToday : Number.POSITIVE_INFINITY;
  if (remaining <= 0) {
    return finish('cap-reached', '오늘 요청 상한(' + cap + '회)을 다 썼습니다. 내일 이어서 받습니다.');
  }

  // ---- 요청하는 회차 ----
  const runId = Number((await sql.query(
    'INSERT INTO run_log (kst_date, trigger, started_at) VALUES (?, ?, ?) RETURNING id', [today, deps.trigger, iso]))[0]?.id);
  const client = deps.makeClient(remaining);
  try {
    await collect(deps, client, today, log, report, finish);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      await setSetting(sql, S.loginFailedAt, iso);
      finish('login-required', '네이버 로그인이 필요합니다. 로그인하면 다음 확인 때(30분 안) 이어서 받습니다.');
    } else if (e instanceof BudgetExceededError) {
      finish('cap-reached', '오늘 요청 상한(' + cap + '회)에 닿아 멈췄습니다. 내일 이어서 받습니다.');
    } else if (e instanceof ClientBlockedError) {
      finish('error', '네트워크 문제로 멈췄습니다. 다음 확인 때 다시 시도합니다. (' + e.message + ')');
    } else {
      finish('error', '수집 중 오류: ' + (e instanceof Error ? e.message : String(e)));
    }
  } finally {
    report.requests = client.requestsUsed;
    await sql.query('UPDATE run_log SET finished_at = ?, requests = ?, outcome = ?, message = ? WHERE id = ?',
      [new Date().toISOString(), report.requests, report.outcome, report.message, runId]);
    await sql.query('DELETE FROM raw_response WHERE fetched_at < ?', [addDays(today, -RAW_KEEP_DAYS)]);
  }
  return report;
}

async function collect(deps: CollectorDeps, client: StatClient, today: string, log: JobLog, report: RunReport,
  finish: (o: Outcome, m: string) => RunReport): Promise<void> {
  const { sql } = deps;

  // 로그인과 블로그 ID. baUserKey는 읽지 않고, 응답 원문도 저장하지 않는다.
  const info = await client.request(USER_INFO_PATH, {}, '로그인 확인');
  const blogId = info.status === 200 ? parseBlogId(info.body) : null;
  if (!blogId) {
    if (info.status !== 200) throw new HttpStatusError(info.status, '로그인 확인');
    throw new SessionExpiredError('로그인 정보 없음');
  }
  await deleteSetting(sql, S.loginFailedAt);
  const bound = await getSetting(sql, S.blogId);
  if (bound === null) {
    await setSetting(sql, S.blogId, blogId);
    log('info', '[블로그] 이 확장을 지금 로그인한 블로그에 묶었습니다.');
  } else if (bound !== blogId) {
    await setSetting(sql, S.otherAccount, new Date().toISOString());
    finish('other-account', '처음 수집한 블로그와 다른 계정으로 로그인돼 있어 받지 않습니다.');
    return;
  }

  const http = recording(client, sql);
  const round = await planRound(sql, today, deps.refetchDays ?? 0);
  const { to } = round;

  // 1) 유입경로·검색어(다시 받는 날짜는 있어도 받아 날짜 단위로 교체)
  const referers = new SqlRefererStore(sql);
  for (const d of round.refererDates) {
    try {
      const day = await fetchRefererDay(http, d, 100, log, true);
      if (await referers.save(day)) {
        report.saved.REFERER = (report.saved.REFERER ?? 0) + day.rows.length;
        if (day.urls) report.saved.REFERER_URL = (report.saved.REFERER_URL ?? 0) + day.urls.length;
        else report.failures++;
      }
    } catch (e) {
      if (!(e instanceof HttpStatusError) && !(e instanceof RefererParseError)) throw e;
      report.failures++;
      log('warn', '[경고] ' + d + ' 유입경로 수집 실패, 건너뜁니다: ' + e.message);
    }
  }

  // 1-2) 상세 URL 보충: 유입 합계는 다시 받지 않고 저장된 유입처 목록을 쓴다. 유입경로·검색어 행은 건드리지 않는다.
  for (const d of round.urlDates) {
    const urls = await fetchRefererUrls(http, d, await storedReferers(sql, d), 100, log);
    if (!urls) { report.failures++; continue; }
    await referers.saveUrls(d, urls);
    report.saved.REFERER_URL = (report.saved.REFERER_URL ?? 0) + urls.length;
  }

  // 2)·3) 지표
  const store = new SqlMetricStore(sql);
  const repaired = await store.repairMarkers();
  if (repaired > 0) log('info', '[정리] 시계열 지표에 잘못 남은 조회 불가 표시 ' + repaired + '행을 지웠습니다.');
  const job = new MetricJob(store, log);
  let pending = 0;
  for (const plan of round.plans) {
    const r = await job.execute(http, plan);
    for (const [k, v] of Object.entries(r.saved)) report.saved[k] = (report.saved[k] ?? 0) + v;
    report.failures += r.failures;
    pending += r.pending;
    if (r.budgetStopped) throw new BudgetExceededError('상한');
  }

  const failures = report.failures > 0 ? ' 실패 ' + report.failures + '건은 내일 다시 받습니다.' : '';
  if (pending > 0) {
    finish('partial', '네이버가 아직 집계하지 않은 값 ' + pending + '건은 다음 확인 때 다시 받습니다.' + failures);
    return;
  }
  await setSetting(sql, S.completeDate, today);
  await setSetting(sql, S.missingAfter, today + '|' + (await missingWork(sql, today)));
  const redone = round.refetchFrom === null ? ''
    : ' ' + (round.refetchFrom === to ? '어제' : round.refetchFrom + ' ~ ' + to) + '는 다시 받아 덮어썼습니다.';
  finish('done', '어제(' + to + ')까지 받았습니다.' + redone + failures);
}

export interface Round {
  from: string;
  to: string;
  /** 다시 받아 덮어쓰는 첫 날짜(없으면 null). to까지 */
  refetchFrom: string | null;
  /** 받을 유입경로 날짜(최신순): 빠진 날짜 + 다시 받는 날짜 */
  refererDates: string[];
  /** 유입경로는 있는데 상세 URL이 없는 날짜(최신순). refererDates와 겹치지 않는다 */
  urlDates: string[];
  plans: MetricPlan[];
}

/** 이번 회차에 받을 것. 수집과 예상 요청 수 계산이 같은 계획을 쓴다. */
export async function planRound(sql: Sql, today: string, refetchDays: number): Promise<Round> {
  const to = addDays(today, -1);
  const from = addDays(to, -(RANGE_DAYS - 1));
  const days = Math.min(Math.max(Math.floor(refetchDays) || 0, 0), REFETCH_MAX_DAYS);
  const refetchFrom = days > 0 ? addDays(to, -(days - 1)) : null;

  const have = await new SqlRefererStore(sql).datesWith(from, to);
  const refererDates: string[] = [];
  for (let d = to; d >= from; d = addDays(d, -1)) {
    if (have.has(d) && !(refetchFrom !== null && d >= refetchFrom)) continue;
    refererDates.push(d);
  }
  const haveUrls = await new SqlRefererStore(sql).urlDatesWith(from, to);
  const urlDates: string[] = [];
  for (let d = to; d >= from; d = addDays(d, -1)) {
    if (have.has(d) && !haveUrls.has(d) && !refererDates.includes(d)) urlDates.push(d);
  }

  const plainSeries = (s: MetricSpec) => isSeries(s) && !s.perPost && !s.perHour;
  const others = ALL.filter((s) => !plainSeries(s));
  const firstTime = (await sql.query("SELECT 1 FROM metric_row WHERE metric = 'VIEWS' LIMIT 1")).length === 0;
  // 시계열은 매번 어제를 포함한 15일 창을 받아 덮어쓴다(다시 받는 범위도 그 창 안에 있다).
  const plans: MetricPlan[] = [{ specs: ALL.filter(plainSeries), from: firstTime ? from : (refetchFrom ?? to), to, force: false, today }];
  // 다시 받기를 먼저 해서, 뒤의 "빠진 것 채우기"가 같은 날짜를 또 받지 않게 한다.
  if (refetchFrom !== null) plans.push({ specs: others, from: refetchFrom, to, force: true, today, keepOnPending: true });
  plans.push({ specs: others, from, to, force: false, today });
  return { from, to, refetchFrom, refererDates, urlDates, plans };
}

/**
 * 아직 받지 않은 것의 개수(요청 없이 로컬에서 계산): 빠진 유입경로 날짜 + 상세 URL만 빠진 날짜 + 빠진 지표 단위.
 * 매번 다시 받는 시계열 창(plans[0])은 "빠진 것"이 아니라 세지 않는다.
 */
export async function missingWork(sql: Sql, today: string): Promise<number> {
  const round = await planRound(sql, today, 0);
  const job = new MetricJob(new SqlMetricStore(sql));
  let n = round.refererDates.length + round.urlDates.length;
  for (const plan of round.plans.slice(1)) n += await job.estimateRequests(plan);
  return n;
}

/**
 * 이번 회차의 예상 요청 수(user-info 포함, 재시도 제외). 게시글별은 지금 저장된 순위 기준이라 어림값이다.
 * 다시 받는 날짜가 아직 비어 있으면 "채우기" 계획에도 한 번 더 세어 실제보다 조금 많게 나올 수 있다.
 */
export async function estimateRound(sql: Sql, today: string, refetchDays: number): Promise<number> {
  const round = await planRound(sql, today, refetchDays);
  const job = new MetricJob(new SqlMetricStore(sql));
  let n = 1;
  for (const d of round.refererDates) n += 1 + (await detailCount(sql, d, true)) + (await detailCount(sql, d, false));
  for (const d of round.urlDates) n += await detailCount(sql, d, false);
  for (const plan of round.plans) n += await job.estimateRequests(plan);
  return n;
}

/**
 * 그 날짜의 상세 요청 수: 검색 유입처 수(검색어) 또는 방문이 있는 검색 아닌 유입처 수(상세 URL).
 * 아직 없는 날짜는 가장 최근 날짜의 수로 어림한다.
 */
async function detailCount(sql: Sql, date: string, search: boolean): Promise<number> {
  const q = 'SELECT COUNT(*) AS n FROM referrer_daily WHERE search_engine = ' + (search ? 1 : 0) + ' AND visits > 0 AND stat_date = ';
  const own = Number((await sql.query(q + '?', [date]))[0]?.n ?? 0);
  if (own > 0) return own;
  return Number((await sql.query(q + '(SELECT MAX(stat_date) FROM referrer_daily)'))[0]?.n ?? 0);
}

/** 저장된 그 날의 유입처 목록(상세 URL 보충용). */
async function storedReferers(sql: Sql, date: string): Promise<RefererRow[]> {
  const rows = await sql.query(
    'SELECT referrer_name, search_engine, visits, ratio FROM referrer_daily WHERE stat_date = ? ORDER BY visits DESC', [date]);
  return rows.map((r) => ({
    date, referrer: String(r.referrer_name), searchEngine: Number(r.search_engine) === 1,
    visits: Number(r.visits), ratio: Number(r.ratio),
  }));
}

/** 받은 응답 원문을 남기는 StatGetter(파서를 고친 뒤 다시 읽기용, 14일 보관). */
function recording(client: StatClient, sql: Sql): StatGetter {
  return {
    async get(path, params, label) {
      const body = await client.get(path, params, label);
      await sql.query('INSERT INTO raw_response (fetched_at, path, query, body) VALUES (?, ?, ?, ?)',
        [new Date().toISOString(), path, buildQuery(params), body]);
      return body;
    },
  };
}
