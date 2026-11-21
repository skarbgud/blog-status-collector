// 유입경로와 검색어. Java RefererParser·RefererSource·ReferrerDailyService.mergeQueries를 옮겼다.
// 하루에 1(유입 합계) + 검색 유입처 수만큼 요청한다.
import { isDate } from './dates.js';
import { HttpStatusError } from './naver.js';
import type { JobLog, StatGetter } from './metric-job.js';

export const REFERER_PATH = '/api/blog/daily/referer/total';
export const REFERER_DETAIL_PATH = '/api/blog/daily/referer/total/detail';

export interface RefererRow { date: string; referrer: string; searchEngine: boolean; visits: number; ratio: number }
export interface SearchQueryRow { date: string; referrer: string; query: string; visits: number; ratio: number }
export interface RefererDay {
  date: string;
  rows: RefererRow[];
  /** API가 알려준 합계(refererTotalCount). 없으면 -1 */
  totalCount: number;
  /** 집계 중인 오늘 데이터. 저장하지 않는다 */
  today: boolean;
  queries: SearchQueryRow[];
}

export class RefererParseError extends Error {}

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asText = (v: Json) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? '' : String(v));
const asNumber = (v: Json) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const asInt = (v: Json) => Math.trunc(asNumber(v));

function root(json: string, what: string): Record<string, Json>[] {
  let r: Json;
  try {
    r = JSON.parse(json);
  } catch {
    throw new RefererParseError(what + ' JSON 파싱 실패');
  }
  if (!isObject(r) || asInt(r.statusCode) !== 200) {
    throw new RefererParseError(what + ' statusCode가 200이 아님');
  }
  const result = r.result;
  const list = isObject(result) ? result.statDataList : undefined;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

const find = (list: Record<string, Json>[], dataId: string) => list.find((b) => asText(b.dataId) === dataId);

function column(rows: Json, name: string): Json[] {
  const col = isObject(rows) ? rows[name] : undefined;
  if (!Array.isArray(col)) throw new RefererParseError('rows.' + name + ' 컬럼이 없거나 배열이 아님');
  return col;
}

function date(v: Json): string {
  const text = asText(v);
  if (!isDate(text)) throw new RefererParseError('날짜 형식 오류: ' + text);
  return text;
}

/** 유입 합계 응답. 행 합계 == refererTotalCount, 날짜 일치를 검증한다. */
export function parseReferer(json: string, requested: string): RefererDay {
  const list = root(json, '유입 API');
  const total = find(list, 'refererTotal');
  if (!total) throw new RefererParseError('응답에 refererTotal 블록이 없음');
  const rows = isObject(total.data) ? total.data.rows : undefined;
  const dates = column(rows, 'date');
  const domains = column(rows, 'referrerDomain');
  const engines = column(rows, 'referrerSearchEngine');
  const visits = column(rows, 'cv');
  const ratios = column(rows, 'cv_p');
  const size = dates.length;
  if ([domains, engines, visits, ratios].some((c) => c.length !== size)) {
    throw new RefererParseError('컬럼 배열 길이가 서로 다름');
  }
  const result: RefererRow[] = [];
  for (let i = 0; i < size; i++) {
    const d = date(dates[i]);
    if (d !== requested) throw new RefererParseError('요청 날짜(' + requested + ')와 응답 날짜(' + d + ')가 다름');
    result.push({
      date: d, referrer: asText(domains[i]), searchEngine: asText(engines[i]) === '1',
      visits: asInt(visits[i]), ratio: asNumber(ratios[i]),
    });
  }
  const countNode = find(list, 'refererTotalCount');
  const countValue = isObject(countNode?.data) ? countNode.data.value : undefined;
  const totalCount = typeof countValue === 'number' ? Math.trunc(countValue) : -1;
  const sum = result.reduce((a, r) => a + r.visits, 0);
  if (totalCount >= 0 && sum !== totalCount) {
    throw new RefererParseError('유입 합계 불일치: 행 합계 ' + sum + ' != refererTotalCount ' + totalCount);
  }
  const dash = find(list, 'dashboard');
  const dashValue = isObject(dash?.data) ? dash.data.value : undefined;
  const isToday = isObject(dashValue) ? dashValue.isToday : undefined;
  const today = isToday === true || isToday === 'true' || (typeof isToday === 'number' && isToday !== 0);
  return { date: requested, rows: result, totalCount, today, queries: [] };
}

/** 검색 유입처 하나의 검색어. 합계 검증은 호출한 쪽이 유입처 방문수와 비교해 경고만 한다(size 상한). */
export function parseQueries(json: string, requested: string, referrer: string): SearchQueryRow[] {
  const list = root(json, '검색어 API');
  const detail = find(list, 'refererDetail');
  if (!detail) throw new RefererParseError('검색어 응답에 refererDetail 블록이 없음');
  const rows = isObject(detail.data) ? detail.data.rows : undefined;
  const dates = column(rows, 'date');
  const queries = column(rows, 'searchQuery');
  const visits = column(rows, 'cv');
  const ratios = column(rows, 'cv_p');
  const size = dates.length;
  if ([queries, visits, ratios].some((c) => c.length !== size)) {
    throw new RefererParseError('검색어 컬럼 배열 길이가 서로 다름');
  }
  const result: SearchQueryRow[] = [];
  for (let i = 0; i < size; i++) {
    const d = date(dates[i]);
    if (d !== requested) throw new RefererParseError('요청 날짜(' + requested + ')와 검색어 응답 날짜(' + d + ')가 다름');
    const q = queries[i];
    const query = (q === null || q === undefined ? '' : asText(q)).trim();
    if (query === '') continue; // 비어 있는 검색어는 목록에 보여줄 수 없다
    result.push({ date: d, referrer, query, visits: asInt(visits[i]), ratio: asNumber(ratios[i]) });
  }
  return result;
}

/** 같은 (유입처, 검색어)가 한 날짜에 두 번 오면 방문수와 비율을 합친다(처음 나온 순서 유지). */
export function mergeQueries(rows: SearchQueryRow[]): SearchQueryRow[] {
  const merged = new Map<string, SearchQueryRow>();
  for (const r of rows) {
    const key = r.referrer + '\u0000' + r.query;
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, visits: prev.visits + r.visits, ratio: prev.ratio + r.ratio } : { ...r });
  }
  return [...merged.values()];
}

export function refererParams(date: string): Record<string, string> {
  return { timeDimension: 'DATE', additionalTimeDimension: 'WEEK', startDate: date, exclude: 'weekAndMonthAnalysis' };
}

export function detailParams(date: string, referrer: string, size: number): Record<string, string> {
  return {
    timeDimension: 'DATE', additionalTimeDimension: 'WEEK', startDate: date, searchEngine: '1',
    refererDomain: referrer, size: String(size), exclude: '',
  };
}

/**
 * 하루치 유입경로 + 검색 유입처별 검색어. 오늘 데이터면 검색어를 받지 않는다.
 * 한 유입처의 검색어를 못 받아도 그 날의 나머지는 살린다. 로그인 만료·상한은 그대로 멈춘다.
 */
export async function fetchRefererDay(http: StatGetter, date: string, querySize = 100,
  log: JobLog = () => {}): Promise<RefererDay> {
  const day = parseReferer(await http.get(REFERER_PATH, refererParams(date), date), date);
  if (day.today) return day;
  const all: SearchQueryRow[] = [];
  for (const row of day.rows) {
    if (!row.searchEngine) continue;
    const label = date + ' ' + row.referrer + ' 검색어';
    try {
      const queries = parseQueries(await http.get(REFERER_DETAIL_PATH, detailParams(date, row.referrer, querySize), label),
        date, row.referrer);
      const sum = queries.reduce((a, q) => a + q.visits, 0);
      if (sum !== row.visits) {
        log('warn', '[경고] ' + label + ' 합계 ' + sum + ' != 유입처 방문수 ' + row.visits + ' (상한 size=' + querySize + ')');
      }
      all.push(...queries);
    } catch (e) {
      if (!(e instanceof HttpStatusError) && !(e instanceof RefererParseError)) throw e;
      log('warn', '[경고] ' + label + ' 수집 실패, 이 유입처의 검색어는 건너뜁니다: ' + e.message);
    }
  }
  return { ...day, queries: all };
}
