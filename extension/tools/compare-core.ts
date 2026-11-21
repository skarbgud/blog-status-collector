// 병행 운영 비교(4단계)의 계산부. 확장 DB와 Java 내보내기 JSON을 같은 날짜끼리 행 단위로 비교한다.
// Java에서 가져온 행(collected_at이 Java 것과 같음)은 복사본이라 비교에서 빼고, 양쪽이 각자 받은 행만 센다.
// 결과에는 개수와 위치(지표·날짜)만 담고 값은 담지 않는다.
import type { Sql } from '../src/core/sql.js';
import { validateExport, type ExportFile } from '../src/core/importer.js';

export interface GroupDiff { table: string; group: string; problem: string }
export interface CompareReport {
  range: { from: string; to: string };
  compared: { referrerDays: number; queryDays: number; metricGroups: number };
  copied: { referrerDays: number; metricGroups: number };
  onlyExtension: number;
  onlyJava: number;
  diffs: GroupDiff[];
}

const EPS = 1e-9;

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

type Keyed = Map<string, unknown>;

function compareSets(ext: Keyed, java: Keyed): string | null {
  const missing = [...java.keys()].filter((k) => !ext.has(k)).length;
  const extra = [...ext.keys()].filter((k) => !java.has(k)).length;
  const changed = [...ext.keys()].filter((k) => java.has(k) && !same(ext.get(k), java.get(k))).length;
  if (missing + extra + changed === 0) return null;
  return '확장에 없음 ' + missing + ', Java에 없음 ' + extra + ', 값 다름 ' + changed;
}

export async function compare(sql: Sql, raw: unknown, from = '0000-01-01', to = '9999-12-31'): Promise<CompareReport> {
  const java: ExportFile = validateExport(raw);
  const inRange = (d: string) => d >= from && d <= to;
  const report: CompareReport = {
    range: { from, to }, compared: { referrerDays: 0, queryDays: 0, metricGroups: 0 },
    copied: { referrerDays: 0, metricGroups: 0 }, onlyExtension: 0, onlyJava: 0, diffs: [],
  };

  // 유입경로·검색어: 날짜 단위
  const extRef = await sql.query('SELECT stat_date, referrer_name, search_engine, visits, ratio, collected_at FROM referrer_daily WHERE stat_date BETWEEN ? AND ?', [from, to]);
  const extQ = await sql.query('SELECT stat_date, referrer_name, search_query, visits, ratio FROM search_query_daily WHERE stat_date BETWEEN ? AND ?', [from, to]);
  const javaRefDates = new Set(java.referrerDaily.filter((r) => inRange(r.statDate)).map((r) => r.statDate));
  const extRefDates = new Set(extRef.map((r) => String(r.stat_date)));
  const javaCollected = new Map(java.referrerDaily.map((r) => [r.statDate + '\u0000' + r.referrerName, r.collectedAt]));
  for (const d of extRefDates) if (!javaRefDates.has(d)) report.onlyExtension++;
  for (const d of javaRefDates) {
    if (!extRefDates.has(d)) { report.onlyJava++; continue; }
    const extRows = extRef.filter((r) => r.stat_date === d);
    if (extRows.every((r) => javaCollected.get(d + '\u0000' + r.referrer_name) === r.collected_at)) {
      report.copied.referrerDays++;
      continue;
    }
    report.compared.referrerDays++;
    const p = compareSets(
      new Map(extRows.map((r) => [String(r.referrer_name), [Number(r.search_engine) === 1, Number(r.visits), Number(r.ratio)]])),
      new Map(java.referrerDaily.filter((r) => r.statDate === d).map((r) => [r.referrerName, [r.searchEngine, r.visits, r.ratio]])));
    if (p) report.diffs.push({ table: 'referrer_daily', group: d, problem: p });
    report.compared.queryDays++;
    const q = compareSets(
      new Map(extQ.filter((r) => r.stat_date === d).map((r) => [r.referrer_name + '\u0000' + r.search_query, [Number(r.visits), Number(r.ratio)]])),
      new Map(java.searchQueryDaily.filter((r) => r.statDate === d).map((r) => [r.referrerName + '\u0000' + r.searchQuery, [r.visits, r.ratio]])));
    if (q) report.diffs.push({ table: 'search_query_daily', group: d, problem: q });
  }

  // 지표: (지표, 날짜) 단위. 빈 표시(_empty)도 행으로 비교한다.
  const extM = await sql.query('SELECT metric, stat_date, row_key, payload, collected_at FROM metric_row WHERE stat_date BETWEEN ? AND ?', [from, to]);
  const group = <T>(rows: T[], key: (r: T) => string) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    return m;
  };
  const extG = group(extM, (r) => r.metric + '@' + r.stat_date);
  const javaG = group(java.metricRows.filter((r) => inRange(r.statDate)), (r) => r.metric + '@' + r.statDate);
  for (const k of extG.keys()) if (!javaG.has(k)) report.onlyExtension++;
  for (const [k, jrows] of javaG) {
    const erows = extG.get(k);
    if (!erows) { report.onlyJava++; continue; }
    const jc = new Map(jrows.map((r) => [r.rowKey, r.collectedAt]));
    if (erows.every((r) => jc.get(String(r.row_key)) === r.collected_at)) { report.copied.metricGroups++; continue; }
    report.compared.metricGroups++;
    const p = compareSets(
      new Map(erows.map((r) => [String(r.row_key), JSON.parse(String(r.payload))])),
      new Map(jrows.map((r) => [r.rowKey, JSON.parse(r.payload)])));
    if (p) report.diffs.push({ table: 'metric_row', group: k, problem: p });
  }
  return report;
}
