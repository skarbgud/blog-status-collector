// 오늘 유입(집계 중) 보기. 네이버는 오늘 값을 실시간으로 바꾸므로 확정 표(referrer_daily 등)에는 넣지 않고,
// 마지막으로 받은 한 벌만 settings의 today_referer(JSON)에 둔다. 내일이 되면 날짜가 달라져 화면에 안 쓰이고,
// 그날 값은 평소 수집이 확정값으로 받는다.
// 요청: 로그인 확인 1 + 유입 합계 1 + 검색 유입처 수(검색어) + 검색 아닌 유입처 수(상세 URL). 하루 상한이 있으면 지킨다.
// run_log에는 요청 수만 남기고 outcome을 비워 둔다(팝업의 "마지막 수집 결과"를 덮지 않게).
import { DEFAULT_DAILY_CAP, S, hasCap } from './collector.js';
import { BudgetExceededError, SessionExpiredError, USER_INFO_PATH, kstDate, parseBlogId, type StatClient } from './naver.js';
import { fetchRefererDay, type RefererRow, type RefererUrlRow, type SearchQueryRow } from './referer.js';
import { getSetting, setSetting, type Sql } from './sql.js';

export const TODAY_KEY = 'today_referer';
/** 이보다 최근에 받았으면 다시 부르지 않고 저장된 값을 쓴다(버튼 연타·화면 전환마다 요청이 나가지 않게). */
export const TODAY_MIN_INTERVAL_MS = 60_000;

export interface TodaySnapshot {
  date: string;
  fetchedAt: string;
  rows: RefererRow[];
  queries: SearchQueryRow[];
  /** 검색 아닌 유입처의 상세 URL. 일부 유입처를 못 받았으면 받은 만큼만 있고 urlsComplete=false */
  urls: RefererUrlRow[];
  urlsComplete: boolean;
}

export async function readToday(sql: Sql): Promise<TodaySnapshot | null> {
  const raw = await getSetting(sql, TODAY_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as TodaySnapshot;
    return s && typeof s.date === 'string' && Array.isArray(s.rows) ? s : null;
  } catch {
    return null;
  }
}

/** 오늘 남은 요청 수(하루 상한이 없으면 무한대). 수집 회차 밖에서 부르는 요청(오늘 유입, 사용시간)도 이 상한을 지킨다. */
export async function remainingToday(sql: Sql, today: string): Promise<number> {
  const cap = Number((await getSetting(sql, S.dailyCap)) ?? DEFAULT_DAILY_CAP);
  if (!hasCap(cap)) return Number.POSITIVE_INFINITY;
  const used = Number((await sql.query('SELECT COALESCE(SUM(requests), 0) AS n FROM run_log WHERE kst_date = ?', [today]))[0]?.n ?? 0);
  return cap - used;
}

export interface TodayDeps {
  sql: Sql;
  makeClient(maxRequests: number): StatClient;
  now?: Date;
  log?: (level: 'info' | 'warn', message: string) => void;
}

/** 오늘 유입을 네이버에서 받아 저장한다. 1분 안에 받았으면 요청 없이 저장된 값을 돌려준다. */
export async function refreshToday(deps: TodayDeps): Promise<TodaySnapshot> {
  const { sql } = deps;
  const now = deps.now ?? new Date();
  const today = kstDate(0, now);
  const log = deps.log ?? (() => {});
  const prev = await readToday(sql);
  if (prev && prev.date === today && now.getTime() - Date.parse(prev.fetchedAt) < TODAY_MIN_INTERVAL_MS) return prev;

  const remaining = await remainingToday(sql, today);
  if (remaining <= 0) throw new BudgetExceededError('오늘 요청 상한을 다 써서 오늘 유입을 받을 수 없어요.');

  const client = deps.makeClient(remaining);
  const startedAt = now.toISOString();
  try {
    const info = await client.request(USER_INFO_PATH, {}, '로그인 확인');
    const blogId = info.status === 200 ? parseBlogId(info.body) : null;
    if (!blogId) throw new SessionExpiredError('네이버에 로그인한 뒤 다시 눌러 주세요.');
    const bound = await getSetting(sql, S.blogId);
    if (bound !== null && bound !== blogId) throw new Error('처음 수집한 블로그와 다른 계정으로 로그인돼 있어요. 원래 계정으로 로그인해 주세요.');

    const day = await fetchRefererDay(client, today, 100, log, true, true);
    const snap: TodaySnapshot = {
      date: today, fetchedAt: (deps.now ?? new Date()).toISOString(), rows: day.rows, queries: day.queries,
      urls: day.urls ?? [], urlsComplete: day.urls !== undefined,
    };
    await setSetting(sql, TODAY_KEY, JSON.stringify(snap));
    log('info', '[오늘] 유입처 ' + snap.rows.length + '곳, 검색어 ' + snap.queries.length + '개, 상세 URL ' + snap.urls.length + '개');
    return snap;
  } finally {
    await sql.query('INSERT INTO run_log (kst_date, trigger, started_at, finished_at, requests) VALUES (?, ?, ?, ?, ?)',
      [today, 'today', startedAt, new Date().toISOString(), client.requestsUsed]);
  }
}
