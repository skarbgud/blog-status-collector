// "지금 수집" = 빠진 것 채우기 + 최근 N일 다시 받아 덮어쓰기. 덮어쓸 때 집계 전 빈 값이 오면 기존 값을 지키는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, type NodeSql } from './node-sql.js';
import { S, estimateRound, planRound, runCollection, type CollectorDeps } from '../src/core/collector.js';
import { MetricJob, type MetricPlan, type StatGetter } from '../src/core/metric-job.js';
import { StatClient } from '../src/core/naver.js';
import { ALL } from '../src/core/specs.js';
import { getSetting, setSetting } from '../src/core/sql.js';
import { SqlMetricStore } from '../src/core/store.js';

const NOW = new Date('2026-11-21T01:00:00Z'); // KST 11/21 10:00 → 어제 11/20
const TODAY = '2026-11-21';
const YESTERDAY = '2026-11-20';
const later = (h: number) => new Date(NOW.getTime() + h * 3600_000);
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const refererBody = (date: string, cv: number) => ({
  statusCode: 200, result: { statDataList: [
    { dataId: 'refererTotal', data: { rows: { date: [date], cv: [cv], referrerSearchEngine: ['0'], referrerDomain: ['사이트E'], cv_p: [100] } } },
    { dataId: 'refererTotalCount', data: { value: cv } },
    { dataId: 'dashboard', data: { value: { isToday: false } } },
  ] },
});

/** 유입경로는 받을 때마다 방문수가 늘어나게(덮어썼는지 보이도록), 지표는 404(이 테스트의 관심사가 아님). */
function server() {
  const urls: URL[] = [];
  let calls = 0;
  return {
    urls,
    referer: () => urls.filter((u) => u.pathname === '/api/blog/daily/referer/total').map((u) => u.searchParams.get('startDate')),
    deps(sql: NodeSql, extra: Partial<CollectorDeps> = {}): CollectorDeps {
      return {
        sql, trigger: 'test', now: NOW,
        makeClient: (max) => new StatClient({
          maxRequests: max, random: () => 0, sleep: async () => {},
          fetchFn: async (url) => {
            urls.push(url);
            if (url.pathname === '/api/blog/user-info') return json({ blogId: 'me' });
            if (url.pathname === '/api/blog/daily/referer/total') return json(refererBody(url.searchParams.get('startDate')!, 3 + calls++));
            return new Response(null, { status: 404 });
          },
        }),
        ...extra,
      };
    },
  };
}

const visits = async (sql: NodeSql, date: string) =>
  Number((await sql.query('SELECT visits FROM referrer_daily WHERE stat_date = ?', [date]))[0]?.visits);

/** 첫 30일 보충(유입경로 30 + 지표 수백 회)이 기본 상한 300에 걸리지 않게 넉넉히 둔다. */
async function db(): Promise<NodeSql> {
  const sql = await memoryDb();
  await setSetting(sql, S.dailyCap, '5000');
  return sql;
}

test('지금 수집(어제 다시 받기): 이미 있는 어제를 다시 받아 덮어쓰고, 다른 날짜는 건드리지 않는다', async () => {
  const sql = await db();
  const srv = server();
  assert.equal((await runCollection(srv.deps(sql))).outcome, 'done'); // 자동: 30일 채움
  assert.equal(srv.referer().length, 30);
  const before20 = await visits(sql, YESTERDAY);
  const before19 = await visits(sql, '2026-11-19');

  // 자동은 같은 날 다시 돌면 요청 0회(오늘 끝남)
  srv.urls.length = 0;
  assert.equal((await runCollection(srv.deps(sql, { now: later(1) }))).outcome, 'up-to-date');
  assert.equal(srv.urls.length, 0);

  // 사람이 누름: 어제 하루만 다시 받아 교체
  const r = await runCollection(srv.deps(sql, { now: later(1), manual: true, refetchDays: 1 }));
  assert.equal(r.outcome, 'done');
  assert.match(r.message, /어제는 다시 받아 덮어썼습니다/);
  assert.deepEqual(srv.referer(), [YESTERDAY]);
  assert.notEqual(await visits(sql, YESTERDAY), before20, '어제 값이 새 값으로 바뀜');
  assert.equal(await visits(sql, '2026-11-19'), before19, '그제는 그대로');
  assert.equal(Number((await sql.query('SELECT COUNT(*) AS n FROM referrer_daily WHERE stat_date = ?', [YESTERDAY]))[0]?.n), 1,
    '날짜 단위 교체라 행이 늘지 않음');
});

test('최근 7일 다시 받기: 어제부터 7일을 최신순으로, 빠진 날짜도 함께 채운다', async () => {
  const sql = await db();
  const srv = server();
  await runCollection(srv.deps(sql));
  // 범위 안 빠진 날짜 하나(받은 날짜는 collection_state와 referrer_daily 둘 다로 판단하므로 둘 다 지운다)
  await sql.query("DELETE FROM referrer_daily WHERE stat_date = '2026-10-25'");
  await sql.query("DELETE FROM collection_state WHERE stat_date = '2026-10-25'");
  srv.urls.length = 0;
  await runCollection(srv.deps(sql, { now: later(1), manual: true, refetchDays: 7 }));
  assert.deepEqual(srv.referer(), [
    '2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16', '2026-11-15', '2026-11-14', '2026-10-25']);
});

test('다시 받는 일수는 0이면 끄고, 최대 7일로 자른다', async () => {
  const sql = await db();
  const srv = server();
  await runCollection(srv.deps(sql));
  assert.equal((await planRound(sql, TODAY, 0)).refetchFrom, null);
  assert.deepEqual((await planRound(sql, TODAY, 0)).refererDates, []);
  const r = await planRound(sql, TODAY, 30);
  assert.equal(r.refetchFrom, '2026-11-14');
  assert.equal(r.refererDates.length, 7);
  // 다시 받기 계획(force, keepOnPending)이 채우기 계획보다 앞에 온다
  assert.deepEqual(r.plans.map((p) => [p.force, !!p.keepOnPending]), [[false, false], [true, true], [false, false]]);
});

test('상한: 오늘 상한을 다 썼으면 지금 수집도 요청 0회로 끝나고 이유를 알린다', async () => {
  const sql = await memoryDb();
  const srv = server();
  await setSetting(sql, S.dailyCap, '50');
  await runCollection(srv.deps(sql)); // 30일치를 받다가 50회에서 멈춘다
  srv.urls.length = 0;
  const r = await runCollection(srv.deps(sql, { now: later(1), manual: true, refetchDays: 1 }));
  assert.equal(r.outcome, 'cap-reached');
  assert.equal(srv.urls.length, 0);
  assert.equal(await getSetting(sql, S.completeDate), null);
});

test('예상 요청 수: 요청을 보내지 않고 계산하고, 7일이 1일보다 많다', async () => {
  const sql = await db();
  const srv = server();
  await runCollection(srv.deps(sql));
  const n = srv.urls.length;
  const one = await estimateRound(sql, TODAY, 1);
  const seven = await estimateRound(sql, TODAY, 7);
  assert.equal(srv.urls.length, n, '어림값 계산은 네트워크를 쓰지 않음');
  assert.ok(one > 2, 'user-info + 유입경로 + 지표');
  assert.ok(seven > one);
});

// ---- 지표: 덮어쓸 때 집계 전 빈 값 ----

const HOUR = ALL.find((s) => s.id === 'HOUR')!;
const zeroHour: StatGetter = {
  async get() {
    return JSON.stringify({ statusCode: 200, result: { statDataList: [
      { dataId: 'hour', data: { rows: { date: ['00', '01'], cv: [0, 0], cv_p: [0, 0] } } }] } });
  },
};
const plan = (extra: Partial<MetricPlan> = {}): MetricPlan =>
  ({ specs: [HOUR], from: YESTERDAY, to: YESTERDAY, force: true, today: TODAY, ...extra });

test('덮어쓰기(keepOnPending): 집계 전 빈 값이 오면 확정된 기존 값을 지우지 않는다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  await store.replace('HOUR', [{ metric: 'HOUR', statDate: YESTERDAY, rowKey: '12', payload: '{"cv":5}' }], null);
  const r = await new MetricJob(store).execute(zeroHour, plan({ keepOnPending: true }));
  assert.deepEqual([...await store.keysWith('HOUR', YESTERDAY)], ['12']);
  assert.equal(r.pending, 0);
});

test('덮어쓰기(keepOnPending)라도 기존 값이 없으면 집계 전으로 세어 다음에 다시 받는다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  const r = await new MetricJob(store).execute(zeroHour, plan({ keepOnPending: true }));
  assert.equal(r.pending, 1);
  assert.equal((await store.keysWith('HOUR', YESTERDAY)).size, 0);
});

test('기본(자동)은 지금처럼 집계 전이면 잠정값을 지운다', async () => {
  const store = new SqlMetricStore(await memoryDb());
  await store.replace('HOUR', [{ metric: 'HOUR', statDate: YESTERDAY, rowKey: '12', payload: '{"cv":5}' }], null);
  const r = await new MetricJob(store).execute(zeroHour, plan());
  assert.equal((await store.keysWith('HOUR', YESTERDAY)).size, 0);
  assert.equal(r.pending, 1);
});
