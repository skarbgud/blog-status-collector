// SQLite 저장소: 교체 저장(멱등), 게시글 범위 교체, 집계 전 정리, 표시 행 정리, 유입경로 날짜 교체.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './node-sql.js';
import { SqlMetricStore, SqlRefererStore } from '../src/core/store.js';
import { migrate, SCHEMA_VERSION } from '../src/core/schema.js';
import { getSetting } from '../src/core/sql.js';
import { UNAVAILABLE_PAYLOAD } from '../src/core/metric-job.js';
import type { MetricRow } from '../src/core/metric-parser.js';

const row = (metric: string, statDate: string, rowKey: string, payload = '{"v":1}'): MetricRow => ({ metric, statDate, rowKey, payload });

test('스키마: 버전이 기록되고 다시 돌려도 그대로', async () => {
  const sql = await memoryDb();
  assert.equal(await getSetting(sql, 'schema_version'), String(SCHEMA_VERSION));
  await migrate(sql);
  assert.equal(await getSetting(sql, 'schema_version'), String(SCHEMA_VERSION));
});

test('지표: 같은 날짜를 다시 저장하면 교체되고 다른 날짜는 남는다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  assert.equal(await store.replace('DEMO', [row('DEMO', '2026-11-19', 'a'), row('DEMO', '2026-11-20', 'a'), row('DEMO', '2026-11-20', 'b')], null), 3);
  assert.equal(await store.replace('DEMO', [row('DEMO', '2026-11-20', 'c')], null), 1);
  assert.deepEqual([...await store.keysWith('DEMO', '2026-11-20')], ['c']);
  assert.deepEqual([...await store.keysWith('DEMO', '2026-11-19')], ['a']);
  assert.deepEqual([...await store.datesWith('DEMO', '2026-11-01', '2026-11-30')].sort(), ['2026-11-19', '2026-11-20']);
  assert.deepEqual([...await store.datesWith('DEMO', '2026-11-20', '2026-11-30')], ['2026-11-20']);
});

test('지표: 빈 표시(_empty)는 저장하지만 행 수에 세지 않는다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  assert.equal(await store.replace('COUNTRY', [row('COUNTRY', '2026-11-20', '_empty', '{}')], null), 0);
  assert.deepEqual([...await store.datesWith('COUNTRY', '2026-11-20', '2026-11-20')], ['2026-11-20']);
});

test('지표: 게시글 범위 교체는 다른 게시글 행을 지우지 않는다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  await store.replace('ARTICLE_CV', [row('ARTICLE_CV', '2026-11-20', '111')], '111');
  await store.replace('ARTICLE_CV', [row('ARTICLE_CV', '2026-11-20', '222')], '222');
  await store.replace('ARTICLE_CV', [row('ARTICLE_CV', '2026-11-20', '111', '{"v":2}')], '111');
  assert.deepEqual([...await store.keysWith('ARTICLE_CV', '2026-11-20')].sort(), ['111', '222']);
});

test('지표: 다른 지표의 행이 섞이면 거부하고 아무것도 바꾸지 않는다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  await assert.rejects(store.replace('DEMO', [row('DEMO', '2026-11-20', 'a'), row('HOUR', '2026-11-20', 'b')], null));
  assert.equal((await store.keysWith('DEMO', '2026-11-20')).size, 0);
});

test('지표: 트랜잭션 도중 실패하면 앞서 지운 행도 되살아난다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  await store.replace('DEMO', [row('DEMO', '2026-11-20', 'a')], null);
  // 같은 키가 두 번 들어가 INSERT가 실패한다
  await assert.rejects(store.replace('DEMO', [row('DEMO', '2026-11-20', 'x'), row('DEMO', '2026-11-20', 'x')], null));
  assert.deepEqual([...await store.keysWith('DEMO', '2026-11-20')], ['a']);
});

test('지표: clear는 그 지표·날짜만 지운다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  await store.replace('HOUR', [row('HOUR', '2026-11-20', '00'), row('HOUR', '2026-11-19', '00')], null);
  assert.equal(await store.clear('HOUR', '2026-11-20'), 1);
  assert.deepEqual([...await store.datesWith('HOUR', '2026-11-01', '2026-11-30')], ['2026-11-19']);
});

test('지표: 순위 uri에서 게시글 번호를 뽑아 정렬한다(기간 밖·다른 지표 제외)', async () => {
  const store = new SqlMetricStore(await memoryDb());
  const p = (id: string) => JSON.stringify({ title: 't', uri: 'https://blog.naver.com/someone/' + id });
  await store.replace('RANK_POST', [row('RANK_POST', '2026-11-20', 'r001', p('224')), row('RANK_POST', '2026-11-20', 'r002', p('1001'))], null);
  await store.replace('RANK_LIKE', [row('RANK_LIKE', '2026-11-19', 'r001', JSON.stringify({ uri: 'http://blog.naver.com/someone/224' }))], null);
  await store.replace('RANK_COMMENT', [row('RANK_COMMENT', '2026-10-01', 'r001', p('999'))], null);
  await store.replace('RANK_SUBJECT', [row('RANK_SUBJECT', '2026-11-20', 'r001', p('555'))], null);
  assert.deepEqual(await store.postIds('2026-11-01', '2026-11-30'), ['1001', '224']);
});

test('지표: 시계열 게시글 지표의 조회 불가 표시만 지운다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  await store.replace('ARTICLE_CV', [row('ARTICLE_CV', '2026-11-20', '111', UNAVAILABLE_PAYLOAD)], '111');
  await store.replace('ARTICLE_INFO', [row('ARTICLE_INFO', '2026-11-20', '111', UNAVAILABLE_PAYLOAD)], '111');
  assert.equal(await store.repairMarkers(), 1);
  assert.equal((await store.keysWith('ARTICLE_CV', '2026-11-20')).size, 0);
  assert.deepEqual([...await store.keysWith('ARTICLE_INFO', '2026-11-20')], ['111']);
});

const day = (date: string, today = false) => ({
  date, today, totalCount: 3,
  rows: [
    { date, referrer: '검색B', searchEngine: true, visits: 2, ratio: 66.7 },
    { date, referrer: '사이트E', searchEngine: false, visits: 1, ratio: 33.3 },
  ],
  queries: [
    { date, referrer: '검색B', query: '하나', visits: 1, ratio: 50 },
    { date, referrer: '검색B', query: '하나', visits: 1, ratio: 50 },
  ],
});

test('유입경로: 같은 검색어는 합치고, 다시 저장하면 그 날짜만 교체한다', async () => {
  const sql = await memoryDb();
  const store = new SqlRefererStore(sql);
  assert.equal(await store.save(day('2026-11-20')), true);
  assert.equal(await store.save(day('2026-11-19')), true);
  assert.equal(await store.save(day('2026-11-20')), true);
  const q = (await sql.query('SELECT stat_date, search_query, visits, ratio FROM search_query_daily ORDER BY stat_date')).map((r) => ({ ...r }));
  assert.deepEqual(q, [
    { stat_date: '2026-11-19', search_query: '하나', visits: 2, ratio: 100 },
    { stat_date: '2026-11-20', search_query: '하나', visits: 2, ratio: 100 },
  ]);
  assert.equal((await sql.query('SELECT * FROM referrer_daily')).length, 4);
  assert.deepEqual([...await store.datesWith('2026-11-01', '2026-11-30')].sort(), ['2026-11-19', '2026-11-20']);
});

test('유입경로: 오늘 데이터는 저장하지 않는다', async () => {
  const sql = await memoryDb();
  const store = new SqlRefererStore(sql);
  assert.equal(await store.save(day('2026-11-21', true)), false);
  assert.equal((await sql.query('SELECT * FROM referrer_daily')).length, 0);
  assert.equal((await store.datesWith('2026-11-01', '2026-11-30')).size, 0);
});

test('유입경로: 유입이 0건인 날도 받은 날로 기록돼 다시 부르지 않는다', async () => {
  const store = new SqlRefererStore(await memoryDb());
  await store.save({ date: '2026-11-18', today: false, totalCount: 0, rows: [], queries: [] });
  assert.deepEqual([...await store.datesWith('2026-11-18', '2026-11-18')], ['2026-11-18']);
});
