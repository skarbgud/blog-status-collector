// 오늘 유입(집계 중) 보기: 네이버에서 받아 한 벌만 저장, 화면용 응답(today-details), 요청 간격·계정·기록 규칙.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, type NodeSql } from './node-sql.js';
import { DashboardQuery } from '../src/core/dashboard-query.js';
import { StatClient } from '../src/core/naver.js';
import { getSetting, setSetting } from '../src/core/sql.js';
import { readStatus } from '../src/core/status.js';
import { TODAY_KEY, readToday, refreshToday, type TodayDeps } from '../src/core/today.js';

const NOW = new Date('2026-11-27T03:00:00Z'); // KST 11/27 12:00
const TODAY = '2026-11-27';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 오늘 유입: 사이트E(검색 아님) 3회, 네이버 통합검색(검색) 2회. URL·검색어는 가짜 값 */
function server(blogId = 'me') {
  const urls: URL[] = [];
  return {
    urls,
    deps(sql: NodeSql, now = NOW): TodayDeps {
      return {
        sql, now,
        makeClient: (max) => new StatClient({
          maxRequests: max, random: () => 0, sleep: async () => {},
          fetchFn: async (url) => {
            urls.push(url);
            const date = url.searchParams.get('startDate')!;
            if (url.pathname === '/api/blog/user-info') return json({ blogId });
            if (url.pathname === '/api/blog/daily/referer/total') {
              return json({ statusCode: 200, result: { statDataList: [
                { dataId: 'refererTotal', data: { rows: { date: [date, date], cv: [3, 2], referrerSearchEngine: ['0', '1'],
                  referrerDomain: ['사이트E', '네이버 통합검색_모바일'], cv_p: [60, 40] } } },
                { dataId: 'refererTotalCount', data: { value: 5 } },
                { dataId: 'dashboard', data: { value: { isToday: true } } },
              ] } });
            }
            if (url.pathname === '/api/blog/daily/referer/total/detail') {
              const rows = url.searchParams.get('searchEngine') === '1'
                ? { date: [date], cv: [2], cv_p: [100], searchQuery: ['검색어 하나'] }
                : { date: [date, date], cv: [2, 1], cv_p: [66.7, 33.3], referrerUrl: ['https://example.com/a', 'https://m.blog.naver.com/FeedList.naver'] };
              return json({ statusCode: 200, result: { statDataList: [{ dataId: 'refererDetail', data: { rows } }] } });
            }
            return new Response(null, { status: 404 });
          },
        }),
      };
    },
  };
}

async function db(): Promise<NodeSql> {
  const sql = await memoryDb();
  await setSetting(sql, 'blog_id', 'me');
  return sql;
}

test('오늘 유입: 받은 값을 한 벌만 저장하고, 확정 표에는 넣지 않는다', async () => {
  const sql = await db();
  const srv = server();
  const snap = await refreshToday(srv.deps(sql));
  assert.equal(snap.date, TODAY);
  assert.equal(snap.rows.length, 2);
  assert.equal(snap.queries.length, 1);
  assert.equal(snap.urls.length, 2);
  assert.equal(snap.urlsComplete, true);
  assert.equal(srv.urls.length, 4, '로그인 확인 + 합계 + 검색어 1 + 상세 URL 1');
  for (const t of ['referrer_daily', 'search_query_daily', 'referrer_url_daily']) {
    assert.equal(Number((await sql.query('SELECT COUNT(*) AS n FROM ' + t))[0]?.n), 0, t + '는 비어 있어야 함');
  }
});

test('오늘 유입: 화면용 응답은 referrer-details와 같은 모양이다', async () => {
  const sql = await db();
  await refreshToday(server().deps(sql));
  const r = await new DashboardQuery(sql, () => TODAY).handle('today-details', {}, null);
  assert.equal(r.status, 200);
  const body = r.body as { available: boolean; from: string; to: string; total: number; fetchedAt: string;
    referrers: { name: string; searchEngine: boolean; visits: number; days: number; detailDays: number; details: { kind: string; text: string }[] }[] };
  assert.equal(body.available, true);
  assert.equal(body.from, TODAY);
  assert.equal(body.to, TODAY);
  assert.equal(body.total, 5);
  assert.deepEqual(body.referrers.map((x) => [x.name, x.searchEngine, x.visits, x.details.length, x.days, x.detailDays]),
    [['사이트E', false, 3, 2, 1, 1], ['네이버 통합검색_모바일', true, 2, 1, 1, 1]]);
  assert.equal(body.referrers[1]!.details[0]!.kind, 'query');
});

test('오늘 유입: 1분 안에 다시 부르면 네이버에 요청하지 않는다', async () => {
  const sql = await db();
  const srv = server();
  await refreshToday(srv.deps(sql));
  const n = srv.urls.length;
  await refreshToday(srv.deps(sql, new Date(NOW.getTime() + 30_000)));
  assert.equal(srv.urls.length, n);
  await refreshToday(srv.deps(sql, new Date(NOW.getTime() + 61_000)));
  assert.ok(srv.urls.length > n, '1분 지나면 다시 받음');
});

test('오늘 유입: 다른 계정이면 받지 않고, 저장된 값도 바꾸지 않는다', async () => {
  const sql = await db();
  await assert.rejects(refreshToday(server('other').deps(sql)), /다른 계정/);
  assert.equal(await getSetting(sql, TODAY_KEY), null);
});

test('오늘 유입: 요청 수는 오늘 사용량에 들어가지만 팝업의 마지막 수집 결과는 덮지 않는다', async () => {
  const sql = await db();
  await refreshToday(server().deps(sql));
  const st = await readStatus(sql, TODAY);
  assert.equal(st.todayRequests, 4);
  assert.equal(st.lastRun, null);
});

test('오늘 유입: 날짜가 지난 값은 보여 주지 않는다(내일은 available=false)', async () => {
  const sql = await db();
  await refreshToday(server().deps(sql));
  assert.ok(await readToday(sql));
  const r = await new DashboardQuery(sql, () => '2026-11-28').handle('today-details', {}, null);
  assert.deepEqual(r.body, { available: false, date: '2026-11-28' });
  const p = await new DashboardQuery(sql, () => '2026-11-28').handle('today-places', {}, null);
  assert.deepEqual(p.body, []);
});
