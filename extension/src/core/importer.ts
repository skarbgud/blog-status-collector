// 기존 Java(H2) 데이터 가져오기. Java `./gradlew exportJson`이 만든 JSON(format blogstat-export, version 1)을 읽는다.
// 확장이 이미 가진 것은 건드리지 않는다:
//   - 유입경로·검색어는 날짜 단위: 확장에 그 날짜 유입경로가 있으면 그 날짜는 통째로 건너뛴다.
//   - 지표는 (지표, 날짜) 단위: 확장에 그 지표·날짜 행이 하나라도 있으면 건너뛴다.
// 그래서 여러 번 가져와도 결과가 같고(멱등), 확장이 새로 받은 값이 옛 값으로 덮이지 않는다.
import { isDate } from './dates.js';
import { REFERER_UNIT } from './store.js';
import type { Sql, Stmt } from './sql.js';

export const EXPORT_FORMAT = 'blogstat-export';
export const EXPORT_VERSION = 1;

interface RefRow { statDate: string; referrerName: string; searchEngine: boolean; visits: number; ratio: number; collectedAt: string }
interface QueryRow { statDate: string; referrerName: string; searchQuery: string; visits: number; ratio: number; collectedAt: string }
interface MetricRowIn { statDate: string; metric: string; rowKey: string; payload: string; collectedAt: string }
export interface ExportFile {
  format: string; version: number; exportedAt?: string;
  referrerDaily: RefRow[]; searchQueryDaily: QueryRow[]; metricRows: MetricRowIn[];
}

export interface ImportResult {
  referrerDays: number; referrerRows: number; queryRows: number;
  metricGroups: number; metricRows: number;
  skippedReferrerDays: number; skippedMetricGroups: number;
}

export class ImportError extends Error {}

/** 형식과 값 하나하나를 검사한다(잘못된 파일이 DB를 망치지 않게). */
export function validateExport(data: unknown): ExportFile {
  const d = data as Partial<ExportFile> | null;
  if (!d || typeof d !== 'object' || d.format !== EXPORT_FORMAT) throw new ImportError('blogstat 내보내기 파일이 아닙니다.');
  if (d.version !== EXPORT_VERSION) throw new ImportError('지원하지 않는 내보내기 버전입니다: ' + d.version);
  if (!Array.isArray(d.referrerDaily) || !Array.isArray(d.searchQueryDaily) || !Array.isArray(d.metricRows)) {
    throw new ImportError('내보내기 파일에 표가 빠져 있습니다.');
  }
  const bad = (what: string, i: number) => new ImportError(what + ' ' + (i + 1) + '번째 행 형식이 잘못됐습니다.');
  const str = (v: unknown) => typeof v === 'string';
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  d.referrerDaily.forEach((r, i) => {
    if (!isDate(r?.statDate) || !str(r.referrerName) || typeof r.searchEngine !== 'boolean' || !num(r.visits) || !num(r.ratio)) throw bad('유입경로', i);
  });
  d.searchQueryDaily.forEach((r, i) => {
    if (!isDate(r?.statDate) || !str(r.referrerName) || !str(r.searchQuery) || !num(r.visits) || !num(r.ratio)) throw bad('검색어', i);
  });
  d.metricRows.forEach((r, i) => {
    if (!isDate(r?.statDate) || !str(r.metric) || !str(r.rowKey) || !str(r.payload)) throw bad('지표', i);
    try {
      JSON.parse(r.payload);
    } catch {
      throw bad('지표', i);
    }
  });
  return d as ExportFile;
}

export async function importExport(sql: Sql, raw: unknown, now = new Date().toISOString()): Promise<ImportResult> {
  const data = validateExport(raw);
  const result: ImportResult = {
    referrerDays: 0, referrerRows: 0, queryRows: 0, metricGroups: 0, metricRows: 0, skippedReferrerDays: 0, skippedMetricGroups: 0,
  };

  // 유입경로·검색어: 날짜별
  const haveRef = new Set((await sql.query('SELECT DISTINCT stat_date FROM referrer_daily')).map((r) => String(r.stat_date)));
  const refByDate = group(data.referrerDaily, (r) => r.statDate);
  const qByDate = group(data.searchQueryDaily, (r) => r.statDate);
  for (const date of new Set([...refByDate.keys(), ...qByDate.keys()])) {
    if (haveRef.has(date)) {
      result.skippedReferrerDays++;
      continue;
    }
    const stmts: Stmt[] = [{ sql: 'DELETE FROM search_query_daily WHERE stat_date = ?', bind: [date] }];
    for (const r of refByDate.get(date) ?? []) {
      stmts.push({
        sql: 'INSERT INTO referrer_daily (stat_date, referrer_name, search_engine, visits, ratio, collected_at) VALUES (?, ?, ?, ?, ?, ?)',
        bind: [r.statDate, r.referrerName, r.searchEngine ? 1 : 0, r.visits, r.ratio, r.collectedAt ?? now],
      });
    }
    for (const q of qByDate.get(date) ?? []) {
      stmts.push({
        sql: 'INSERT INTO search_query_daily (stat_date, referrer_name, search_query, visits, ratio, collected_at) VALUES (?, ?, ?, ?, ?, ?)',
        bind: [q.statDate, q.referrerName, q.searchQuery, q.visits, q.ratio, q.collectedAt ?? now],
      });
    }
    if (refByDate.has(date)) {
      stmts.push({
        sql: `INSERT INTO collection_state (unit_key, stat_date, status, attempts, last_error, updated_at)
              VALUES (?, ?, 'OK', 0, 'imported', ?) ON CONFLICT(unit_key, stat_date) DO NOTHING`,
        bind: [REFERER_UNIT, date, now],
      });
    }
    await sql.tx(stmts);
    result.referrerDays++;
    result.referrerRows += refByDate.get(date)?.length ?? 0;
    result.queryRows += qByDate.get(date)?.length ?? 0;
  }

  // 지표: (지표, 날짜)별. 한 트랜잭션에 너무 많이 넣지 않도록 묶음을 나눈다.
  const haveMetric = new Set((await sql.query('SELECT DISTINCT metric, stat_date FROM metric_row'))
    .map((r) => r.metric + '@' + r.stat_date));
  const mGroups = group(data.metricRows, (r) => r.metric + '@' + r.statDate);
  let batch: Stmt[] = [];
  for (const [k, rows] of mGroups) {
    if (haveMetric.has(k)) {
      result.skippedMetricGroups++;
      continue;
    }
    for (const r of rows) {
      batch.push({
        sql: 'INSERT INTO metric_row (metric, stat_date, row_key, payload, collected_at) VALUES (?, ?, ?, ?, ?)',
        bind: [r.metric, r.statDate, r.rowKey, r.payload, r.collectedAt ?? now],
      });
    }
    result.metricGroups++;
    result.metricRows += rows.length;
    if (batch.length >= 2000) {
      await sql.tx(batch);
      batch = [];
    }
  }
  if (batch.length > 0) await sql.tx(batch);
  return result;
}

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}
