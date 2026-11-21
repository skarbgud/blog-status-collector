// 대시보드 조회 계층과 기존 데이터 가져오기. Java 응답과의 값 대조는 tools/parity.ts(실데이터)로 따로 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './node-sql.js';
import { DashboardQuery } from '../src/core/dashboard-query.js';
import { computeTrends, trendKey } from '../src/core/keyword-trends.js';
import { ImportError, importExport } from '../src/core/importer.js';
import { SqlMetricStore } from '../src/core/store.js';

const ref = (statDate: string, referrerName: string, searchEngine: boolean, visits: number) =>
  ({ statDate, referrerName, searchEngine, visits, ratio: 0, collectedAt: '2026-11-21T00:00:00Z' });
const qry = (statDate: string, referrerName: string, searchQuery: string, visits: number) =>
  ({ statDate, referrerName, searchQuery, visits, ratio: 0, collectedAt: '2026-11-21T00:00:00Z' });
const met = (statDate: string, metric: string, rowKey: string, payload: string) =>
  ({ statDate, metric, rowKey, payload, collectedAt: '2026-11-21T00:00:00Z' });

function exportFile() {
  return {
    format: 'blogstat-export', version: 1,
    referrerDaily: [ref('2026-11-19', '검색B', true, 4), ref('2026-11-19', '사이트E', false, 1), ref('2026-11-20', '검색B', true, 2)],
    searchQueryDaily: [qry('2026-11-19', '검색B', '하나', 3), qry('2026-11-19', '검색B', '둘', 1), qry('2026-11-20', '검색B', '둘', 2)],
    metricRows: [
      met('2026-11-20', 'VIEWS', 'all', '{"total":5}'),
      met('2026-11-20', 'COUNTRY', '_empty', '{}'),
      met('2026-10-01', 'UPPER_GROUP', 'value', '{"avg":1}'),
    ],
  };
}

async function loaded() {
  const sql = await memoryDb();
  await importExport(sql, exportFile());
  return { sql, q: new DashboardQuery(sql, () => '2026-11-21') };
}

test('가져오기: 형식이 다르면 거부하고 아무것도 넣지 않는다', async () => {
  const sql = await memoryDb();
  await assert.rejects(importExport(sql, { format: 'x' }), ImportError);
  const bad = exportFile();
  (bad.metricRows[0] as { payload: string }).payload = '{깨짐';
  await assert.rejects(importExport(sql, bad), ImportError);
  assert.equal((await sql.query('SELECT * FROM metric_row')).length, 0);
});

test('가져오기: 두 번 가져와도 같고, 확장이 가진 날짜·지표는 덮지 않는다', async () => {
  const sql = await memoryDb();
  await new SqlMetricStore(sql).replace('VIEWS', [{ statDate: '2026-11-20', metric: 'VIEWS', rowKey: 'all', payload: '{"total":9}' }], null);
  const r1 = await importExport(sql, exportFile());
  assert.equal(r1.referrerDays, 2);
  assert.equal(r1.skippedMetricGroups, 1);
  const r2 = await importExport(sql, exportFile());
  assert.equal(r2.referrerDays, 0);
  assert.equal(r2.skippedReferrerDays, 2);
  assert.equal(r2.metricGroups, 0);
  assert.equal((await sql.query("SELECT payload FROM metric_row WHERE metric = 'VIEWS'"))[0]?.payload, '{"total":9}');
  assert.equal((await sql.query('SELECT * FROM search_query_daily')).length, 3);
  // 가져온 날짜는 수집 상태에도 기록돼 다시 요청하지 않는다
  assert.equal((await sql.query("SELECT * FROM collection_state WHERE unit_key = 'REFERER'")).length, 2);
});

test('요약·일별: 기간 기본값은 마지막 저장일 기준 30일, 빈 날은 null', async () => {
  const { q } = await loaded();
  const s = await q.summary(await q.period({}));
  assert.deepEqual(s, {
    from: '2026-10-22', to: '2026-11-20', totalVisits: 7, searchVisits: 6, searchRatio: (6 * 100) / 7,
    collectedDays: 2, totalDays: 30, latestDate: '2026-11-20',
  });
  const d = await q.daily(await q.period({ from: '2026-11-18', to: '2026-11-20' }));
  assert.deepEqual(d, [
    { date: '2026-11-18', visits: null, searchVisits: null },
    { date: '2026-11-19', visits: 5, searchVisits: 4 },
    { date: '2026-11-20', visits: 2, searchVisits: 2 },
  ]);
});

test('잘못된 기간은 400과 안내 문구', async () => {
  const { q } = await loaded();
  const r = await q.handle('summary', { from: '2026-11-20', to: '2026-11-01' }, null);
  assert.equal(r.status, 400);
  assert.match((r.body as { message: string }).message, /from이 to보다/);
  assert.equal((await q.handle('summary', { from: '2025-01-01', to: '2026-11-20' }, null)).status, 400);
  assert.equal((await q.handle('summary', { from: '2026-13-01' }, null)).status, 400);
  assert.equal((await q.handle('nothing', {}, null)).status, 404);
});

test('유입처: 방문 많은 순, 비율은 기간 전체 대비', async () => {
  const { q } = await loaded();
  const r = await q.referrers(await q.period({}), 10);
  assert.deepEqual(r, [
    { name: '검색B', searchEngine: true, visits: 6, ratio: (6 * 100) / 7 },
    { name: '사이트E', searchEngine: false, visits: 1, ratio: 100 / 7 },
  ]);
});

test('검색어: 검색어별로 합치고 방문 많은 순, 같으면 가나다순, limit으로 자름', async () => {
  const { q } = await loaded();
  const r = await q.queries(await q.period({}), 1);
  assert.equal(r.distinctQueries, 2);
  assert.equal(r.totalVisits, 6);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.items, [{ query: '둘', visits: 3, days: 2, sources: ['검색B'], dates: ['2026-11-19', '2026-11-20'] }]);
});

test('지표: 빈 표시는 빼고, 월간 비교는 기간 밖이어도 최신값을 함께 보낸다', async () => {
  const { q } = await loaded();
  const v = await q.metrics(null, null);
  assert.equal(v.ready, true);
  assert.equal(v.latest, '2026-11-20');
  assert.deepEqual(v.items.map((i) => i.metric + '@' + i.date), ['VIEWS@2026-11-20', 'UPPER_GROUP@2026-10-01']);
  assert.deepEqual(v.items[0]!.values, { total: 5 });
  assert.deepEqual(v.coverage.map((c) => c.metric), ['UPPER_GROUP', 'VIEWS']);
  const empty = new DashboardQuery(await memoryDb(), () => '2026-11-21');
  assert.equal((await empty.metrics(null, null)).ready, false);
});

test('검색어 변화: 새로 뜬·상승·하락, 띄어쓰기·대소문자 무시', () => {
  const rows = [
    { date: '2026-11-20', query: '스프링 부트', visits: 3 },
    { date: '2026-11-10', query: '스프링부트', visits: 1 },
    { date: '2026-11-19', query: '새 검색어', visits: 2 },
    { date: '2026-11-11', query: '줄어든', visits: 4 },
    { date: '2026-11-18', query: '줄어든', visits: 1 },
  ];
  const t = computeTrends(rows, '2026-11-20', 28, 10);
  assert.equal(t.thisFrom, '2026-11-14');
  assert.equal(t.lastFrom, '2026-11-07');
  assert.deepEqual(t.fresh, [{ query: '새 검색어', visits: 2, firstSeen: '2026-11-19', days: 1 }]);
  assert.deepEqual(t.rising, [{ query: '스프링 부트', thisWeek: 3, lastWeek: 1, delta: 2 }]);
  assert.deepEqual(t.falling, [{ query: '줄어든', thisWeek: 1, lastWeek: 4, delta: -3 }]);
  assert.equal(t.historyDays, 2);
  assert.equal(trendKey('A b C'), 'ab c', 'Java \\s처럼 ASCII 공백만 지운다');
});

test('세션 자리: 로그인이 필요하면 EXPIRED', async () => {
  const { q } = await loaded();
  const status = { lastRun: { outcome: 'login-required', message: 'x' } } as never;
  const r = await q.handle('session', {}, status);
  assert.equal((r.body as { state: string }).state, 'EXPIRED');
  assert.equal(((await q.handle('session', {}, null)).body as { state: string }).state, 'OK');
});
