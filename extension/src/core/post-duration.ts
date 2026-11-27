// 게시글별 사용시간(크리에이터 어드바이저 content-summary, 2026-11-27).
// 응답: { data: [{ date, cv, averageDuration(초), likeCount }] }. interval=day만 받는다:
// 사용시간 합계는 조회수 × 평균의 합이라 더할 수 있어서, 주·월 합계는 일 값을 더해 정확히 구한다(주·월 API를 따로 부르지 않음).
// 글 목록은 이미 받는 날짜별 조회수 순위(RANK_POST)를 쓴다. 조회가 없는 날은 사용시간도 0이라 순위에 나온 (글, 날짜)만 받으면 된다.
// 저장: metric_row(metric=POST_DURATION, row_key=게시글 번호, payload={cv, averageDuration, likeCount}).
// 크리에이터 어드바이저가 거절(401/403/로그인 페이지)하면 이 단계만 멈추고 다음 회차에 다시 한다(통계 로그인 실패로 보지 않음).
import { addDays } from './dates.js';
import { CREATOR_SUMMARY_PATH, ClientBlockedError, HttpStatusError, SessionExpiredError } from './naver.js';
import type { JobLog, StatGetter } from './metric-job.js';
import type { Sql, Stmt } from './sql.js';

export const POST_DURATION = 'POST_DURATION';
/** 한 번에 묻는 날짜 수. 화면이 쓰는 기본 창(15일)으로 확인했다. */
export const DURATION_WINDOW = 15;
const POST_ID = /\/(\d{6,})\/?$/;

export interface DurationWindow { postId: string; from: string; to: string }
export interface DurationDay { date: string; cv: number; averageDuration: number; likeCount: number }

export class DurationParseError extends Error {}

/** 순위 payload의 uri(…/블로그ID/게시글번호)에서 게시글 번호. */
export function postIdOf(uri: unknown): string | null {
  const m = POST_ID.exec(String(uri ?? ''));
  return m ? m[1]! : null;
}

/**
 * 받을 창. [from, to] 안에서 순위에 조회수 > 0으로 나온 (글, 날짜) 중 사용시간이 없는 날짜를 글마다 모아 15일 창으로 묶는다.
 * refetchFrom이 있으면 그 날짜부터는 있어도 다시 받는다("지금 수집"의 다시 받기).
 */
export async function planDurations(sql: Sql, from: string, to: string, refetchFrom: string | null = null): Promise<DurationWindow[]> {
  const rank = await sql.query(
    "SELECT stat_date, payload FROM metric_row WHERE metric = 'RANK_POST' AND row_key <> '_empty' AND stat_date BETWEEN ? AND ?", [from, to]);
  const have = new Set((await sql.query(
    'SELECT stat_date, row_key FROM metric_row WHERE metric = ? AND stat_date BETWEEN ? AND ?', [POST_DURATION, from, to]))
    .map((r) => r.row_key + '|' + r.stat_date));
  const need = new Map<string, Set<string>>();
  for (const r of rank) {
    let v: { uri?: unknown; cv?: unknown };
    try { v = JSON.parse(String(r.payload)); } catch { continue; }
    const id = postIdOf(v.uri);
    const date = String(r.stat_date);
    if (!id || !(Number(v.cv) > 0)) continue;
    if (have.has(id + '|' + date) && !(refetchFrom !== null && date >= refetchFrom)) continue;
    let s = need.get(id);
    if (!s) need.set(id, (s = new Set()));
    s.add(date);
  }
  const windows: DurationWindow[] = [];
  for (const id of [...need.keys()].sort()) {
    const dates = [...need.get(id)!].sort();
    let i = 0;
    while (i < dates.length) {
      const start = dates[i]!;
      const limit = addDays(start, DURATION_WINDOW - 1);
      let end = start;
      while (i < dates.length && dates[i]! <= limit) end = dates[i++]!;
      windows.push({ postId: id, from: start, to: end });
    }
  }
  return windows;
}

export function durationParams(blogId: string, w: DurationWindow): Record<string, string> {
  // 화면이 보내는 순서와 값
  return {
    channelId: blogId, contentId: 'http://blog.naver.com/' + blogId + '/' + w.postId, endDate: w.to,
    interval: 'day', service: 'naver_blog', startDate: w.from, statType: 'visit',
  };
}

export function parseDurations(json: string, w: DurationWindow): DurationDay[] {
  let r: unknown;
  try { r = JSON.parse(json); } catch { throw new DurationParseError('사용시간 응답 JSON 파싱 실패'); }
  const data = (r as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new DurationParseError('사용시간 응답에 data 배열이 없음');
  const out: DurationDay[] = [];
  for (const d of data) {
    const date = String((d as { date?: unknown })?.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < w.from || date > w.to) continue;
    const num = (k: string) => { const n = Number((d as Record<string, unknown>)[k]); return Number.isFinite(n) && n > 0 ? n : 0; };
    out.push({ date, cv: Math.round(num('cv')), averageDuration: num('averageDuration'), likeCount: Math.round(num('likeCount')) });
  }
  return out;
}

/** 창 하나의 결과를 저장한다: 그 글의 그 구간 행을 지우고 다시 넣는다(멱등). 조회 0인 날도 받은 날로 남긴다. */
export function durationStmts(w: DurationWindow, days: DurationDay[], now: string): Stmt[] {
  const stmts: Stmt[] = [{
    sql: 'DELETE FROM metric_row WHERE metric = ? AND row_key = ? AND stat_date BETWEEN ? AND ?',
    bind: [POST_DURATION, w.postId, w.from, w.to],
  }];
  for (const d of days) {
    stmts.push({
      sql: 'INSERT INTO metric_row (metric, stat_date, row_key, payload, collected_at) VALUES (?, ?, ?, ?, ?)',
      bind: [POST_DURATION, d.date, w.postId, JSON.stringify({ cv: d.cv, averageDuration: d.averageDuration, likeCount: d.likeCount }), now],
    });
  }
  return stmts;
}

export interface DurationResult { windows: number; saved: number; failures: number; stopped: string | null }

/**
 * 계획한 창을 받는다(동시 수는 StatClient가 정한다). 한 창이 실패해도 나머지는 받는다.
 * 크리에이터 어드바이저가 로그인을 거절하면 남은 창은 건너뛰고 stopped에 이유를 남긴다(다음 회차에 다시).
 */
export async function fetchDurations(http: StatGetter, sql: Sql, blogId: string, windows: DurationWindow[],
  log: JobLog = () => {}, poolLimit = 6): Promise<DurationResult> {
  const result: DurationResult = { windows: windows.length, saved: 0, failures: 0, stopped: null };
  let next = 0;
  const worker = async () => {
    while (next < windows.length && result.stopped === null) {
      const w = windows[next++]!;
      const label = '사용시간 ' + w.postId + ' ' + w.from + '~' + w.to;
      try {
        const days = parseDurations(await http.get(CREATOR_SUMMARY_PATH, durationParams(blogId, w), label), w);
        await sql.tx(durationStmts(w, days, new Date().toISOString()));
        result.saved += days.length;
      } catch (e) {
        if (e instanceof SessionExpiredError || e instanceof ClientBlockedError) {
          result.stopped ??= '크리에이터 어드바이저가 요청을 거절했습니다(' + e.message + '). 크롬에서 크리에이터 어드바이저(creator-advisor.naver.com)를 한 번 열어 로그인·약관을 확인해 주세요.';
          return;
        }
        if (!(e instanceof HttpStatusError) && !(e instanceof DurationParseError)) throw e;
        result.failures++;
        log('warn', '[경고] ' + label + ' 수집 실패, 다음 회차에 다시 받습니다: ' + e.message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(poolLimit, windows.length)) }, worker));
  if (result.stopped) log('warn', '[사용시간] ' + result.stopped);
  return result;
}
