// 게시글별 사용시간(크리에이터 어드바이저 content-summary, 2026-11-27). 저장하지 않고 "사용시간 합계" 탭을 열 때 바로 부른다.
// 응답: { data: [{ date, cv, averageDuration(초), likeCount }] }. interval=day|week|month(주는 월요일, 월은 1일이 date).
// 사용시간 = 조회수 × 평균 사용시간. 기간 합계는 모든 게시글의 그 값을 더하고, 게시글 합계는 그 글의 기간 값을 더한다.
// 글 목록은 이미 수집된 날짜별 조회수 순위(RANK_POST)에서 고른 기간에 조회 > 0으로 나온 글이다(조회가 없으면 사용시간도 0).
// 크리에이터 어드바이저가 거절(401/403/로그인 페이지)하면 남은 요청을 멈추고 이유를 돌려준다(통계 로그인 실패로 보지 않음).
import { addDays } from './dates.js';
import { CREATOR_SUMMARY_PATH, ClientBlockedError, HttpStatusError, SessionExpiredError } from './naver.js';
import type { JobLog, StatGetter } from './metric-job.js';
import type { Sql } from './sql.js';

export type DurationUnit = 'day' | 'week' | 'month';
export const DURATION_UNITS: DurationUnit[] = ['day', 'week', 'month'];
/** 일 단위 한 번에 묻는 날짜 수(화면이 쓰는 기본 창으로 확인). 주·월은 한 번에 받는다(13주·13개월 확인). */
export const DAY_WINDOW = 15;
const POST_ID = /\/(\d{6,})\/?$/;

export interface Window { from: string; to: string }
export interface DurationDay { date: string; cv: number; averageDuration: number; likeCount: number }

export class DurationParseError extends Error {}

/** 순위 payload의 uri(…/블로그ID/게시글번호)에서 게시글 번호. */
export function postIdOf(uri: unknown): string | null {
  const m = POST_ID.exec(String(uri ?? ''));
  return m ? m[1]! : null;
}

export function mondayOf(d: string): string {
  return addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
}

/** 요청 시작일: 주는 그 주 월요일, 월은 1일로 맞춘다(API가 그 날짜를 기간 이름으로 쓴다). */
export function alignedFrom(unit: DurationUnit, from: string): string {
  return unit === 'week' ? mondayOf(from) : unit === 'month' ? from.slice(0, 8) + '01' : from;
}

/** 요청 구간. 일은 15일씩 나누고, 주·월은 한 번. */
export function windowsFor(unit: DurationUnit, from: string, to: string): Window[] {
  const start = alignedFrom(unit, from);
  if (unit !== 'day') return [{ from: start, to }];
  const out: Window[] = [];
  for (let d = start; d <= to; d = addDays(d, DAY_WINDOW)) {
    const end = addDays(d, DAY_WINDOW - 1);
    out.push({ from: d, to: end < to ? end : to });
  }
  return out;
}

/** 고른 기간에 순위에 조회 > 0으로 나온 게시글 번호(로컬 데이터, 요청 없음). */
export async function postsInRange(sql: Sql, from: string, to: string): Promise<string[]> {
  const rows = await sql.query(
    "SELECT payload FROM metric_row WHERE metric = 'RANK_POST' AND row_key <> '_empty' AND stat_date BETWEEN ? AND ?", [from, to]);
  const ids = new Set<string>();
  for (const r of rows) {
    try {
      const v = JSON.parse(String(r.payload)) as { uri?: unknown; cv?: unknown };
      const id = postIdOf(v.uri);
      if (id && Number(v.cv) > 0) ids.add(id);
    } catch { /* 깨진 행은 건너뛴다 */ }
  }
  return [...ids].sort();
}

export function durationParams(blogId: string, postId: string, unit: DurationUnit, w: Window): Record<string, string> {
  // 화면이 보내는 순서와 값
  return {
    channelId: blogId, contentId: 'http://blog.naver.com/' + blogId + '/' + postId, endDate: w.to,
    interval: unit, service: 'naver_blog', startDate: w.from, statType: 'visit',
  };
}

export function parseDurations(json: string): DurationDay[] {
  let r: unknown;
  try { r = JSON.parse(json); } catch { throw new DurationParseError('사용시간 응답 JSON 파싱 실패'); }
  const data = (r as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new DurationParseError('사용시간 응답에 data 배열이 없음');
  const out: DurationDay[] = [];
  for (const d of data) {
    const date = String((d as { date?: unknown })?.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const num = (k: string) => { const n = Number((d as Record<string, unknown>)[k]); return Number.isFinite(n) && n > 0 ? n : 0; };
    out.push({ date, cv: Math.round(num('cv')), averageDuration: num('averageDuration'), likeCount: Math.round(num('likeCount')) });
  }
  return out;
}

export interface DurationPeriod { date: string; seconds: number; views: number }
export interface DurationPost { postId: string; seconds: number; views: number; likes: number; periods: number }
export interface LiveDurations {
  unit: DurationUnit;
  periods: DurationPeriod[];
  posts: DurationPost[];
  requested: number;
  failures: number;
  /** 크리에이터 어드바이저가 거절해 멈췄으면 이유 */
  stopped: string | null;
}

/** 게시글마다 고른 단위로 바로 받아 기간별·게시글별로 더한다. 한 요청이 실패해도 나머지는 받는다. */
export async function fetchLiveDurations(http: StatGetter, blogId: string, postIds: string[], unit: DurationUnit,
  from: string, to: string, log: JobLog = () => {}, poolLimit = 6): Promise<LiveDurations> {
  const windows = windowsFor(unit, from, to);
  const jobs = postIds.flatMap((postId) => windows.map((w) => ({ postId, w })));
  const byPeriod = new Map<string, DurationPeriod>();
  const byPost = new Map<string, DurationPost>();
  const result: LiveDurations = { unit, periods: [], posts: [], requested: jobs.length, failures: 0, stopped: null };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && result.stopped === null) {
      const { postId, w } = jobs[next++]!;
      const label = '사용시간 ' + postId + ' ' + w.from + '~' + w.to;
      try {
        const days = parseDurations(await http.get(CREATOR_SUMMARY_PATH, durationParams(blogId, postId, unit, w), label));
        for (const d of days) {
          if (d.date < w.from || d.date > w.to) continue;
          const seconds = d.cv * d.averageDuration;
          const p = byPeriod.get(d.date) ?? { date: d.date, seconds: 0, views: 0 };
          p.seconds += seconds;
          p.views += d.cv;
          byPeriod.set(d.date, p);
          const q = byPost.get(postId) ?? { postId, seconds: 0, views: 0, likes: 0, periods: 0 };
          q.seconds += seconds;
          q.views += d.cv;
          q.likes += d.likeCount;
          if (d.cv > 0) q.periods++;
          byPost.set(postId, q);
        }
      } catch (e) {
        if (e instanceof SessionExpiredError || e instanceof ClientBlockedError) {
          result.stopped ??= '크리에이터 어드바이저가 요청을 거절했어요. 크롬에서 크리에이터 어드바이저(creator-advisor.naver.com)를 한 번 열어 로그인을 확인해 주세요.';
          return;
        }
        if (!(e instanceof HttpStatusError) && !(e instanceof DurationParseError)) throw e;
        result.failures++;
        log('warn', '[경고] ' + label + ' 실패: ' + e.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(poolLimit, jobs.length)) }, worker));
  // 기간은 빈 구간도 0으로 채워 차트가 끊기지 않게 한다(일: 날마다, 주: 월요일마다, 월: 1일마다)
  const step = (d: string) => (unit === 'day' ? addDays(d, 1) : unit === 'week' ? addDays(d, 7) : nextMonth(d));
  for (let d = alignedFrom(unit, from); d <= to; d = step(d)) result.periods.push(byPeriod.get(d) ?? { date: d, seconds: 0, views: 0 });
  result.posts = [...byPost.values()].filter((p) => p.views > 0).sort((a, b) => b.seconds - a.seconds || (a.postId < b.postId ? -1 : 1));
  return result;
}

function nextMonth(d: string): string {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}
