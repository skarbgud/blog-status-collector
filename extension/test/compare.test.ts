// 병행 운영 비교: 가져온 복사본은 빼고, 각자 받은 행만 비교한다. 백업 파일 바이트로 열어도 같다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportBytes, memoryDb, openSqliteFile } from './node-sql.js';
import { compare } from '../tools/compare-core.js';
import { importExport } from '../src/core/importer.js';
import { SqlMetricStore, SqlRefererStore } from '../src/core/store.js';
import { looksLikeSqlite } from '../src/core/base64.js';

const J = '2026-11-21T00:00:00Z';
const javaExport = () => ({
  format: 'blogstat-export', version: 1,
  referrerDaily: [
    { statDate: '2026-11-19', referrerName: 'a', searchEngine: false, visits: 3, ratio: 100, collectedAt: J },
    { statDate: '2026-11-20', referrerName: 'a', searchEngine: false, visits: 5, ratio: 100, collectedAt: J },
  ],
  searchQueryDaily: [],
  metricRows: [
    { statDate: '2026-11-19', metric: 'DEMO', rowKey: '20', payload: '{"m":1}', collectedAt: J },
    { statDate: '2026-11-20', metric: 'DEMO', rowKey: '20', payload: '{"m":2.0}', collectedAt: J },
    { statDate: '2026-11-20', metric: 'HOUR', rowKey: '00', payload: '{"cv":1}', collectedAt: J },
  ],
});

async function extension() {
  const sql = await memoryDb();
  // 11/19는 Java에서 가져온 복사본, 11/20은 확장이 직접 받은 것
  await importExport(sql, { ...javaExport(), referrerDaily: javaExport().referrerDaily.slice(0, 1), metricRows: javaExport().metricRows.slice(0, 1) });
  await new SqlRefererStore(sql, () => 'ext').save({ date: '2026-11-20', today: false, totalCount: 5, queries: [],
    rows: [{ date: '2026-11-20', referrer: 'a', searchEngine: false, visits: 5, ratio: 100 }] });
  const store = new SqlMetricStore(sql, () => 'ext');
  await store.replace('DEMO', [{ statDate: '2026-11-20', metric: 'DEMO', rowKey: '20', payload: '{"m":2}' }], null);
  await store.replace('HOUR', [{ statDate: '2026-11-20', metric: 'HOUR', rowKey: '00', payload: '{"cv":7}' }], null);
  return sql;
}

test('비교: 복사본은 빼고, 같은 값(2 = 2.0)은 같다고, 다른 값은 위치와 개수만', async () => {
  const r = await compare(await extension(), javaExport());
  assert.equal(r.copied.referrerDays, 1);
  assert.equal(r.copied.metricGroups, 1);
  assert.equal(r.compared.referrerDays, 1);
  assert.equal(r.compared.metricGroups, 2);
  assert.deepEqual(r.diffs, [{ table: 'metric_row', group: 'HOUR@2026-11-20', problem: '확장에 없음 0, Java에 없음 0, 값 다름 1' }]);
});

test('비교: 기간을 좁히면 그 안만, 백업 파일 바이트로 열어도 결과가 같다', async () => {
  const bytes = exportBytes(await extension());
  assert.ok(looksLikeSqlite(bytes));
  const r = await compare(await openSqliteFile(bytes), javaExport(), '2026-11-19', '2026-11-19');
  assert.equal(r.compared.metricGroups, 0);
  assert.equal(r.diffs.length, 0);
});
