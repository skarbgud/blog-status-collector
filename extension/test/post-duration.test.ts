// 게시글별 사용시간(크리에이터 어드바이저, 탭을 열 때 바로 부름): 요청 주소, 구간 나누기, 글 목록, 파싱, 합계, 거절·실패.
// 블로그 ID·게시글 번호는 가짜 값이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, type NodeSql } from './node-sql.js';
import { CREATOR_SUMMARY_PATH, HttpStatusError, SessionExpiredError, buildQuery, statUrl } from '../src/core/naver.js';
import {
  alignedFrom, durationParams, fetchLiveDurations, parseDurations, postIdOf, postsInRange, windowsFor,
} from '../src/core/post-duration.js';
import type { StatGetter } from '../src/core/metric-job.js';

const BLOG = 'myblog';
const A = '224000000101';
const B = '224000000102';
const uri = (id: string) => 'http://blog.naver.com/' + BLOG + '/' + id;

async function rank(sql: NodeSql, date: string, id: string, cv: number) {
  await sql.query('INSERT INTO metric_row (metric, stat_date, row_key, payload, collected_at) VALUES (?, ?, ?, ?, ?)',
    ['RANK_POST', date, 'r' + id.slice(-3), JSON.stringify({ uri: uri(id), cv, title: '제목' }), 'x']);
}

test('사용시간 요청: 크리에이터 어드바이저 주소로, 화면과 같은 파라미터 순서', () => {
  const url = statUrl(CREATOR_SUMMARY_PATH, durationParams(BLOG, A, 'week', { from: '2026-08-24', to: '2026-11-22' }));
  assert.equal(url.origin, 'https://creator-advisor.naver.com');
  assert.equal(url.search, '?' + buildQuery({
    channelId: BLOG, contentId: uri(A), endDate: '2026-11-22', interval: 'week', service: 'naver_blog', startDate: '2026-08-24', statType: 'visit',
  }));
  assert.equal(statUrl('/api/blog/user-info').origin, 'https://blog.stat.naver.com', '통계 경로는 그대로');
  assert.throws(() => statUrl('/api/v6/other'), /허용 목록/);
  assert.equal(postIdOf(uri(A)), A);
  assert.equal(postIdOf('http://blog.naver.com/' + BLOG), null);
});

test('구간: 일은 15일씩, 주는 그 주 월요일부터, 월은 1일부터 한 번', () => {
  assert.deepEqual(windowsFor('day', '2026-11-01', '2026-11-20'),
    [{ from: '2026-11-01', to: '2026-11-15' }, { from: '2026-11-16', to: '2026-11-20' }]);
  assert.deepEqual(windowsFor('week', '2026-11-27', '2026-12-10'), [{ from: '2026-11-23', to: '2026-12-10' }]);
  assert.deepEqual(windowsFor('month', '2026-09-15', '2026-11-26'), [{ from: '2026-09-01', to: '2026-11-26' }]);
  assert.equal(alignedFrom('day', '2026-11-27'), '2026-11-27');
});

test('글 목록: 고른 기간 순위에 조회 > 0으로 나온 글만(요청 없음)', async () => {
  const sql = await memoryDb();
  await rank(sql, '2026-11-01', A, 3);
  await rank(sql, '2026-11-02', B, 0);
  await rank(sql, '2026-10-01', B, 5); // 기간 밖
  assert.deepEqual(await postsInRange(sql, '2026-11-01', '2026-11-30'), [A]);
});

test('파싱: 날짜가 이상한 줄은 버리고, 없거나 음수인 값은 0', () => {
  assert.deepEqual(parseDurations(JSON.stringify({ data: [
    { date: '2026-11-14', cv: 60, averageDuration: 162.95, likeCount: 58 },
    { date: '2026-11-15', cv: 4, averageDuration: null },
    { date: 'bad', cv: 1 },
  ] })), [
    { date: '2026-11-14', cv: 60, averageDuration: 162.95, likeCount: 58 },
    { date: '2026-11-15', cv: 4, averageDuration: 0, likeCount: 0 },
  ]);
  assert.throws(() => parseDurations('{"data":{}}'), /data 배열/);
});

test('합계: 조회수 × 평균을 기간별·게시글별로 더하고, 빈 기간도 0으로 채운다', async () => {
  const http: StatGetter = {
    async get(_path, params) {
      const rows = params.contentId!.endsWith(A)
        ? [{ date: '2026-11-01', cv: 4490, averageDuration: 178 }, { date: '2026-10-01', cv: 1, averageDuration: 999 }]
        : [{ date: '2026-11-01', cv: 4, averageDuration: 139, likeCount: 2 }, { date: '2026-12-01', cv: 9, averageDuration: 9 }];
      return JSON.stringify({ data: rows });
    },
  };
  const r = await fetchLiveDurations(http, BLOG, [A, B], 'month', '2026-11-10', '2026-12-05');
  // 요청 구간(11/01~12/05) 밖인 10월은 버리고, 11월·12월을 채운다
  assert.deepEqual(r.periods, [
    { date: '2026-11-01', seconds: 4490 * 178 + 4 * 139, views: 4494 },
    { date: '2026-12-01', seconds: 81, views: 9 },
  ]);
  assert.deepEqual(r.posts.map((p) => [p.postId, p.seconds, p.views, p.likes, p.periods]),
    [[A, 4490 * 178, 4490, 0, 1], [B, 4 * 139 + 81, 13, 2, 2]]);
  assert.deepEqual([r.requested, r.failures, r.stopped], [2, 0, null]);
});

test('실패: 한 글이 실패해도 나머지는 더하고, 로그인 거절이면 남은 요청을 멈춘다', async () => {
  const one: StatGetter = {
    async get(_path, params) {
      if (params.contentId!.endsWith(B)) throw new HttpStatusError(500, 'x');
      return JSON.stringify({ data: [{ date: '2026-11-01', cv: 2, averageDuration: 30 }] });
    },
  };
  const r = await fetchLiveDurations(one, BLOG, [A, B], 'day', '2026-11-01', '2026-11-01', () => {}, 1);
  assert.deepEqual([r.failures, r.stopped, r.posts.length, r.periods[0]!.seconds], [1, null, 1, 60]);

  let calls = 0;
  const refused: StatGetter = { async get() { calls++; throw new SessionExpiredError('HTTP 401'); } };
  const s = await fetchLiveDurations(refused, BLOG, [A, B], 'day', '2026-11-01', '2026-11-01', () => {}, 1);
  assert.match(s.stopped ?? '', /크리에이터 어드바이저/);
  assert.equal(calls, 1, '거절 뒤 남은 글은 부르지 않음');
});
