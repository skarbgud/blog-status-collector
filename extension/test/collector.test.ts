// 수집 회차: 요청 없이 끝나는 경우(04:00 전, 오늘 끝남, 상한, 로그인 실패 대기), 로그인·계정 확인,
// 도중 만료, 상한에서 멈춘 뒤 다음 날 이어 받기. 실제 StatClient에 가짜 fetch를 꽂아 요청을 센다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, type NodeSql } from './node-sql.js';
import { RANGE_DAYS, S, runCollection, type CollectorDeps } from '../src/core/collector.js';
import { StatClient } from '../src/core/naver.js';
import { getSetting, setSetting } from '../src/core/sql.js';
import { SqlMetricStore } from '../src/core/store.js';
import { gaps } from '../src/core/collector.js';

const NOW = new Date('2026-11-21T01:00:00Z'); // KST 11/21 10:00 → 어제 11/20, 범위 10/22~11/20
const later = (h: number, base = NOW) => new Date(base.getTime() + h * 3600_000);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const refererBody = (date: string) => ({
  statusCode: 200, result: { statDataList: [
    { dataId: 'refererTotal', data: { rows: { date: [date], cv: [3], referrerSearchEngine: ['0'], referrerDomain: ['사이트E'], cv_p: [100] } } },
    { dataId: 'refererTotalCount', data: { value: 3 } },
    { dataId: 'dashboard', data: { value: { isToday: false } } },
  ] },
});

interface Server {
  urls: URL[]; userInfo: () => Response; failAt?: number; failWith?: () => Response;
  /** 상세 URL 요청에 정상 응답(기본은 404) */
  urlOk?: boolean;
}
const urlBody = (date: string) => ({
  statusCode: 200, result: { statDataList: [{ dataId: 'refererDetail', data: { rows: {
    date: [date], referrerUrl: ['https://example.com/a'], cv: [3], cv_p: [100] } } }] },
});

function server(over: Partial<Server> = {}): Server {
  return { urls: [], userInfo: () => json({ baUserKey: 'secret', blogId: 'me' }), ...over };
}

function deps(sql: NodeSql, srv: Server, extra: Partial<CollectorDeps> = {}): CollectorDeps {
  return {
    sql, trigger: 'test', now: NOW,
    makeClient: (max) => new StatClient({
      maxRequests: max, random: () => 0, sleep: async () => {},
      fetchFn: async (url) => {
        srv.urls.push(url);
        if (srv.failAt !== undefined && srv.urls.length >= srv.failAt) return srv.failWith!();
        if (url.pathname === '/api/blog/user-info') return srv.userInfo();
        if (url.pathname === '/api/blog/daily/referer/total') return json(refererBody(url.searchParams.get('startDate')!));
        if (srv.urlOk && url.pathname === '/api/blog/daily/referer/total/detail') return json(urlBody(url.searchParams.get('startDate')!));
        return new Response(null, { status: 404 }); // 지표는 이 테스트의 관심사가 아니다(실패로 세고 계속)
      },
    }),
    ...extra,
  };
}

const refererDates = (srv: Server) => srv.urls.filter((u) => u.pathname === '/api/blog/daily/referer/total').map((u) => u.searchParams.get('startDate'));
const count = async (sql: NodeSql, q: string) => Number((await sql.query(q))[0]?.n);

test('04:00 KST 전에는 요청하지 않는다', async () => {
  const sql = await memoryDb();
  const srv = server();
  const r = await runCollection(deps(sql, srv, { now: new Date('2026-11-20T18:30:00Z'), manual: true })); // KST 03:30
  assert.equal(r.outcome, 'waiting');
  assert.equal(srv.urls.length, 0);
  assert.equal(await count(sql, 'SELECT COUNT(*) AS n FROM run_log'), 0);
});

test('로그인 안 됨: user-info 1회로 멈추고, 6시간 동안은 요청 0회, 수동이면 다시 확인한다', async () => {
  const sql = await memoryDb();
  const srv = server({ userInfo: () => new Response(null, { status: 401 }) });
  const r = await runCollection(deps(sql, srv));
  assert.equal(r.outcome, 'login-required');
  assert.equal(srv.urls.length, 1);
  assert.ok(await getSetting(sql, S.loginFailedAt));

  const r2 = await runCollection(deps(sql, srv, { now: later(1) }));
  assert.equal(r2.outcome, 'login-backoff');
  assert.equal(srv.urls.length, 1);

  const r3 = await runCollection(deps(sql, srv, { now: later(1), manual: true }));
  assert.equal(r3.outcome, 'login-required');
  assert.equal(srv.urls.length, 2);

  srv.userInfo = () => json({ blogId: 'me' });
  const r4 = await runCollection(deps(sql, srv, { now: later(7) }));
  assert.notEqual(r4.outcome, 'login-backoff');
  assert.equal(await getSetting(sql, S.loginFailedAt), null);
});

test('user-info에 blogId가 없으면 로그인 필요로 본다', async () => {
  const sql = await memoryDb();
  const srv = server({ userInfo: () => json({ statusCode: 401, result: null }) });
  assert.equal((await runCollection(deps(sql, srv))).outcome, 'login-required');
  assert.equal(srv.urls.length, 1);
});

test('처음 수집한 블로그와 다른 계정이면 user-info 뒤 아무것도 받지 않는다', async () => {
  const sql = await memoryDb();
  await setSetting(sql, S.blogId, 'someone-else');
  const srv = server();
  const r = await runCollection(deps(sql, srv));
  assert.equal(r.outcome, 'other-account');
  assert.equal(srv.urls.length, 1);
  assert.equal(await getSetting(sql, S.blogId), 'someone-else');
  assert.equal(await count(sql, 'SELECT COUNT(*) AS n FROM referrer_daily'), 0);
});

test('전체 회차: 블로그를 묶고, 유입경로 저장 범위(RANGE_DAYS)를 최신순으로 받고, 오늘 다시 돌면 요청 0회', async () => {
  const sql = await memoryDb();
  await setSetting(sql, S.dailyCap, '5000');
  const srv = server();
  const r = await runCollection(deps(sql, srv));
  assert.equal(r.outcome, 'done', r.message);
  assert.equal(await getSetting(sql, S.blogId), 'me');
  assert.equal(srv.urls[0]!.pathname, '/api/blog/user-info');
  const dates = refererDates(srv);
  assert.equal(dates.length, RANGE_DAYS);
  assert.equal(dates[0], '2026-11-20');
  assert.equal(dates[RANGE_DAYS - 1], '2026-08-23'); // 90일: 11/20부터 거슬러
  assert.equal(await count(sql, 'SELECT COUNT(DISTINCT stat_date) AS n FROM referrer_daily'), RANGE_DAYS);
  assert.ok(r.failures > 0, '지표는 404라 실패로 센다');
  assert.match(r.message, /실패 \d+건은 내일/);
  // 회차 기록과 원문 보관(user-info는 남기지 않는다)
  assert.equal(await count(sql, 'SELECT requests AS n FROM run_log'), srv.urls.length);
  assert.equal(await count(sql, 'SELECT COUNT(*) AS n FROM raw_response'), RANGE_DAYS);
  assert.equal(await count(sql, "SELECT COUNT(*) AS n FROM raw_response WHERE path LIKE '%user-info%' OR body LIKE '%baUserKey%'"), 0);

  // 같은 실패만 남았으면(지표 404) 그날은 다시 돌지 않는다
  const before = srv.urls.length;
  const again = await runCollection(deps(sql, srv, { now: later(2) }));
  assert.equal(again.outcome, 'up-to-date');
  assert.match(again.message, /실패한 \d+건은 내일/);
  assert.equal(srv.urls.length, before);
});

test('상한 기본값은 없음: 회차 클라이언트 상한이 무한대다', async () => {
  const sql = await memoryDb();
  const srv = server();
  const seen: number[] = [];
  const d = deps(sql, srv);
  const make = d.makeClient;
  const r = await runCollection({ ...d, makeClient: (max) => { seen.push(max); return make(max); } });
  assert.notEqual(r.outcome, 'cap-reached', r.message);
  assert.deepEqual(seen, [Number.POSITIVE_INFINITY]);
  assert.equal(refererDates(srv).length, RANGE_DAYS);
});

test('오늘 끝났어도 새 할 일이 생기면(빠진 날짜) 자동 회차가 다시 돈다. 받을 게 없으면 요청 0회', async () => {
  const sql = await memoryDb();
  const srv = server({ urlOk: true });
  const r = await runCollection(deps(sql, srv));
  assert.equal(r.outcome, 'done', r.message);

  assert.equal(await count(sql, 'SELECT COUNT(*) AS n FROM referrer_url_daily'), RANGE_DAYS);
  const before = srv.urls.length;
  assert.equal((await runCollection(deps(sql, srv, { now: later(1) }))).outcome, 'up-to-date');
  assert.equal(srv.urls.length, before);

  // 새 버전이 새 수집 단위를 더한 것처럼: 한 날짜의 유입경로가 빠지면 다음 30분 확인에서 받는다
  await sql.query("DELETE FROM referrer_daily WHERE stat_date = '2026-11-10'");
  await sql.query("DELETE FROM collection_state WHERE stat_date = '2026-11-10'");
  const r2 = await runCollection(deps(sql, srv, { now: later(1.5) }));
  assert.equal(r2.outcome, 'done', r2.message);
  assert.deepEqual(refererDates(srv).slice(RANGE_DAYS), ['2026-11-10']);
});

test('다음 날에는 새 어제 하루만 유입경로를 받는다', async () => {
  const sql = await memoryDb();
  await setSetting(sql, S.dailyCap, '5000');
  await runCollection(deps(sql, server()));
  const srv = server();
  await runCollection(deps(sql, srv, { now: later(24) }));
  assert.deepEqual(refererDates(srv), ['2026-11-21']);
});

test('하루 상한: 상한에서 멈추고, 같은 날은 요청 0회, 다음 날 남은 날짜부터 이어 받는다', async () => {
  const sql = await memoryDb();
  await setSetting(sql, S.dailyCap, '9'); // user-info + 하루 2회(유입 합계, 검색 아닌 유입처 상세 URL) × 4일
  const srv = server();
  const r = await runCollection(deps(sql, srv));
  assert.equal(r.outcome, 'cap-reached');
  assert.equal(srv.urls.length, 9);
  // 날짜를 동시에 진행하므로 어느 날짜까지 끝났는지는 응답 순서에 달렸다. 최신 날짜부터 시작한다는 것만 본다.
  assert.equal(refererDates(srv)[0], '2026-11-20');
  const saved = (await sql.query('SELECT DISTINCT stat_date AS d FROM referrer_daily')).map((x) => String(x.d));

  const same = await runCollection(deps(sql, srv, { now: later(3), manual: true }));
  assert.equal(same.outcome, 'cap-reached');
  assert.equal(srv.urls.length, 9);

  const next = server();
  await runCollection(deps(sql, next, { now: later(24) }));
  // 새 어제(11/21)부터, 이미 저장된 날짜는 다시 받지 않는다
  const nextDates = refererDates(next);
  assert.equal(nextDates[0], '2026-11-21');
  assert.deepEqual(nextDates.filter((d) => saved.includes(d!)), []);
});

test('도중에 로그인이 만료되면 멈추고, 그때까지 받은 날짜는 남는다', async () => {
  const sql = await memoryDb();
  await setSetting(sql, S.dailyCap, '5000');
  // user-info, 11/20(합계·상세), 11/19(합계·상세), 11/18 합계에서 401
  const srv = server({ failAt: 6, failWith: () => new Response(null, { status: 401 }) });
  const r = await runCollection(deps(sql, srv));
  assert.equal(r.outcome, 'login-required');
  // 401을 받은 뒤로는 새 요청을 보내지 않는다(그때 이미 보낸 요청, 최대 동시 6개는 끝까지 간다)
  assert.ok(srv.urls.length <= 6 + 5, String(srv.urls.length));
  assert.ok(await count(sql, 'SELECT COUNT(DISTINCT stat_date) AS n FROM referrer_daily') <= 2);
  assert.equal(await getSetting(sql, S.completeDate), null);
});

test('네트워크가 끊기면 오류로 멈추고 다음 확인 때 다시 한다', async () => {
  const sql = await memoryDb();
  await setSetting(sql, S.dailyCap, '5000');
  const srv = server({ failAt: 3, failWith: () => { throw new TypeError('Failed to fetch'); } });
  const r = await runCollection(deps(sql, srv));
  assert.equal(r.outcome, 'error');
  // user-info, 하루, 그리고 동시에 나간 요청(최대 6개)마다 1 + 재시도 3
  assert.ok(srv.urls.length <= 2 + 6 * 4, String(srv.urls.length));
  assert.equal(await getSetting(sql, S.completeDate), null);
});

test('두 단계: 최근 7일을 먼저 받고, 나머지는 이어서 받되 같은 요청을 두 번 보내지 않는다', async () => {
  const sql = await memoryDb();
  await setSetting(sql, S.dailyCap, '100000');
  const srv = server({ urlOk: true });
  const r = await runCollection(deps(sql, srv));
  assert.equal(r.outcome, 'done', r.message);
  const dates = refererDates(srv);
  assert.equal(dates.length, RANGE_DAYS);
  assert.equal(new Set(dates).size, RANGE_DAYS, '유입경로 날짜 중복 없음');
  assert.deepEqual([...dates.slice(0, 7)].sort().reverse(),
    ['2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16', '2026-11-15', '2026-11-14']);
  // 시계열(조회수)은 처음이라 90일을 15일 창 6번으로, 창이 겹치지 않게 받는다
  const views = srv.urls.filter((u) => u.pathname === '/api/blog/visit/cv').map((u) => u.searchParams.get('startDate'));
  assert.equal(views.length, 6);
  assert.equal(new Set(views).size, 6);
  assert.equal(views[0], '2026-11-20');
  // 더는 받지 않는 지표(시간대별 추이, 중복 검색어·사이트, 이웃 방문)는 요청하지 않는다
  const retired = ['/api/blog/user/hour/hourCv', '/api/blog/user/referer/search', '/api/blog/user/referer/site', '/api/blog/user/relationVisitCv'];
  assert.deepEqual(srv.urls.filter((u) => retired.includes(u.pathname)).map((u) => u.pathname), []);
});

test('빈 구간: 날짜 집합에서 빠진 연속 구간을 최신부터 돌려준다', () => {
  const have = new Set(['2026-11-20', '2026-11-19', '2026-11-16']);
  assert.deepEqual(gaps('2026-11-13', '2026-11-20', have), [['2026-11-17', '2026-11-18'], ['2026-11-13', '2026-11-15']]);
  assert.deepEqual(gaps('2026-11-19', '2026-11-20', have), []);
});

test('보충: 시계열이 최근 30일만 있으면 비어 있는 과거 60일을 15일 창으로 채운다', async () => {
  const sql = await memoryDb();
  await setSetting(sql, S.dailyCap, '100000');
  const rows = [];
  for (let d = new Date('2026-10-22T00:00:00Z'); d <= new Date('2026-11-20T00:00:00Z'); d = new Date(d.getTime() + 86_400_000)) {
    rows.push({ statDate: d.toISOString().slice(0, 10), metric: 'VIEWS', rowKey: 'all', payload: '{"total":1}' });
  }
  await new SqlMetricStore(sql).replace('VIEWS', rows, null);
  const srv = server({ urlOk: true });
  await runCollection(deps(sql, srv));
  const views = srv.urls.filter((u) => u.pathname === '/api/blog/visit/cv').map((u) => u.searchParams.get('startDate'));
  // 1단계 최신 창 1번 + 빈 구간(08/23~10/21)을 그 끝부터 15일씩
  assert.deepEqual(views, ['2026-11-20', '2026-10-21', '2026-10-06', '2026-09-21', '2026-09-06']);
});
