// 검색어 변화 계산. Java dashboard/KeywordTrends를 옮겼다(순수 함수).
//
// 기간(기준일 = 검색어가 저장된 가장 최근 날짜):
//   이번 주 = 기준일 포함 최근 7일, 지난주 = 그 앞 7일, 과거 = 이번 주 앞 lookbackDays일(지난주 포함).
// 규칙:
//   - 새로 뜬 검색어: 이번 주에 들어왔고, 과거 lookbackDays일 동안 한 번도 없던 검색어.
//   - 상승: 이번 주 방문 > 지난주 방문, 그리고 새로 뜬 검색어가 아님.
//   - 하락: 이번 주 방문 < 지난주 방문(이번 주 0회 포함).
//   - 띄어쓰기와 대소문자만 다른 검색어는 같은 검색어로 본다. 표시는 가장 많이 들어온 표기로 한다.
import { addDays } from './dates.js';

export const WINDOW_DAYS = 7;

export interface TrendRow { date: string; query: string; visits: number }
export interface Change { query: string; thisWeek: number; lastWeek: number; delta: number }
export interface NewQuery { query: string; visits: number; firstSeen: string; days: number }
export interface TrendReport {
  thisFrom: string; thisTo: string; lastFrom: string; lastTo: string;
  historyFrom: string; historyDays: number;
  rising: Change[]; falling: Change[]; fresh: NewQuery[];
}

export const historyFrom = (anchor: string, lookbackDays: number) => addDays(anchor, -(WINDOW_DAYS - 1 + lookbackDays));

/** Java의 \s(ASCII 공백만)와 같게 맞춘다. */
export const trendKey = (query: string) => query.replace(/[ \t\n\x0B\f\r]+/g, '').toLowerCase();

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Acc { spellings: Map<string, number>; thisDates: Set<string>; thisWeek: number; lastWeek: number; seenBefore: boolean }

/** 가장 많이 들어온 표기. 같으면 사전순 앞의 것. */
function display(acc: Acc): string {
  let best: [string, number] | null = null;
  for (const [q, n] of acc.spellings) {
    if (!best || n > best[1] || (n === best[1] && q < best[0])) best = [q, n];
  }
  return best![0];
}

export function computeTrends(rows: TrendRow[], anchor: string, lookbackDays: number, limit: number): TrendReport {
  const thisFrom = addDays(anchor, -(WINDOW_DAYS - 1));
  const lastTo = addDays(thisFrom, -1);
  const lastFrom = addDays(lastTo, -(WINDOW_DAYS - 1));
  const hFrom = historyFrom(anchor, lookbackDays);

  const byKey = new Map<string, Acc>();
  const historyDates = new Set<string>();
  for (const r of rows) {
    if (r.date < hFrom || r.date > anchor || r.visits <= 0) continue;
    const k = trendKey(r.query);
    let acc = byKey.get(k);
    if (!acc) byKey.set(k, (acc = { spellings: new Map(), thisDates: new Set(), thisWeek: 0, lastWeek: 0, seenBefore: false }));
    acc.spellings.set(r.query, (acc.spellings.get(r.query) ?? 0) + r.visits);
    if (r.date >= thisFrom) {
      acc.thisWeek += r.visits;
      acc.thisDates.add(r.date);
    } else {
      historyDates.add(r.date);
      acc.seenBefore = true;
      if (r.date >= lastFrom) acc.lastWeek += r.visits;
    }
  }

  const rising: Change[] = [];
  const falling: Change[] = [];
  const fresh: NewQuery[] = [];
  for (const acc of byKey.values()) {
    const shown = display(acc);
    if (acc.thisWeek > 0 && !acc.seenBefore) {
      const dates = [...acc.thisDates].sort();
      fresh.push({ query: shown, visits: acc.thisWeek, firstSeen: dates[0]!, days: dates.length });
      continue;
    }
    const delta = acc.thisWeek - acc.lastWeek;
    if (delta > 0) rising.push({ query: shown, thisWeek: acc.thisWeek, lastWeek: acc.lastWeek, delta });
    else if (delta < 0) falling.push({ query: shown, thisWeek: acc.thisWeek, lastWeek: acc.lastWeek, delta });
  }
  rising.sort((a, b) => b.delta - a.delta || b.thisWeek - a.thisWeek || cmp(a.query, b.query));
  falling.sort((a, b) => a.delta - b.delta || b.lastWeek - a.lastWeek || cmp(a.query, b.query));
  fresh.sort((a, b) => b.visits - a.visits || cmp(b.firstSeen, a.firstSeen) || cmp(a.query, b.query));

  return {
    thisFrom, thisTo: anchor, lastFrom, lastTo, historyFrom: hFrom, historyDays: historyDates.size,
    rising: rising.slice(0, limit), falling: falling.slice(0, limit), fresh: fresh.slice(0, limit),
  };
}
