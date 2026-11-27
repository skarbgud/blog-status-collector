// 게시글별 사용시간(크리에이터 어드바이저): 받을 구간 계획, 응답 파싱, 받기(거절·실패), 조회 합계(일·주·월·게시글).
// 블로그 ID·게시글 번호는 가짜 값이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, type NodeSql } from './node-sql.js';
import { DashboardQuery } from '../src/core/dashboard-query.js';
import { CREATOR_SUMMARY_PATH, HttpStatusError, SessionExpiredError, buildQuery, statUrl } from '../src/core/naver.js';
import {
  POST_DURATION, durationParams, fetchDurations, parseDurations, planDurations, postIdOf, type DurationWindow,
} from '../src/core/post-duration.js';
import type { StatGetter } from '../src/core/metric-job.js';

const BLOG = 'myblog';
const A = '224000000101';
const B = '224000000102';
const uri = (id: string) => 'http://blog.naver.com/' + BLOG + '/' + id;

async function rank(sql: NodeSql, date: string, id: string, cv: number) {
  await sql.query('INSERT INTO metric_row (metric, stat_date, row_key, payload, collected_at) VALUES (?, ?, ?, ?, ?)',
    ['RANK_POST', date, 'r' + id.slice(-3), JSON.stringify({ uri: uri(id), cv, title: '제목 ' + id.slice(-1) }), 'x']);
}
async function duration(sql: NodeSql, date: string, id: string, cv: number, avg: number) {
  await sql.query('INSERT INTO metric_row (metric, stat_date, row_key, payload, collected_at) VALUES (?, ?, ?, ?, ?)',
    [POST_DURATION, date, id, JSON.stringify({ cv, averageDuration: avg, likeCount: 0 }), 'x']);
}

test('사용시간 요청: 크리에이터 어드바이저 주소로, 화면과 같은 파라미터 순서', () => {
  const url = statUrl(CREATOR_SUMMARY_PATH, durationParams(BLOG, { postId: A, from: '2026-11-12', to: '2026-11-26' }));
  assert.equal(url.origin, 'https://creator-advisor.naver.com');
  assert.equal(url.search, '?' + buildQuery({
    channelId: BLOG, contentId: uri(A), endDate: '2026-11-26', interval: 'day', service: 'naver_blog', startDate: '2026-11-12', statType: 'visit',
  }));
  assert.equal(statUrl('/api/blog/user-info').origin, 'https://blog.stat.naver.com', '통계 경로는 그대로');
  assert.throws(() => statUrl('/api/v6/other'), /허용 목록/);
  assert.equal(postIdOf(uri(A)), A);
  assert.equal(postIdOf('http://blog.naver.com/' + BLOG), null);
});

test('사용시간 계획: 순위에 조회 > 0으로 나온 날 중 없는 날만, 글마다 15일 창으로', async () => {
  const sql = await memoryDb();
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-10', '2026-11-20']) await rank(sql, d, A, 3);
  await rank(sql, '2026-11-05', B, 0); // 조회 0은 받지 않음
  await rank(sql, '2026-11-06', B, 2);
  await duration(sql, '2026-11-02', A, 1, 10); // 이미 받음
  const w = await planDurations(sql, '2026-11-01', '2026-11-30');
  assert.deepEqual(w, [
    { postId: A, from: '2026-11-01', to: '2026-11-10' }, // 11/01·11/10은 15일 안
    { postId: A, from: '2026-11-20', to: '2026-11-20' },
    { postId: B, from: '2026-11-06', to: '2026-11-06' },
  ]);
  // 다시 받기: 그 날짜부터는 있어도 받는다
  await duration(sql, '2026-11-20', A, 3, 10);
  const again = await planDurations(sql, '2026-11-01', '2026-11-30', '2026-11-20');
  assert.ok(again.some((x) => x.postId === A && x.from === '2026-11-20'));
});

test('사용시간 파싱: 창 밖 날짜·이상한 값은 버리고, 음수·없음은 0', () => {
  const w: DurationWindow = { postId: A, from: '2026-11-14', to: '2026-11-15' };
  const body = JSON.stringify({ data: [
    { date: '2026-11-13', cv: 9, averageDuration: 9 },
    { date: '2026-11-14', cv: 60, averageDuration: 162.95, likeCount: 58 },
    { date: '2026-11-15', cv: 4, averageDuration: null },
    { date: 'bad', cv: 1 },
  ] });
  assert.deepEqual(parseDurations(body, w), [
    { date: '2026-11-14', cv: 60, averageDuration: 162.95, likeCount: 58 },
    { date: '2026-11-15', cv: 4, averageDuration: 0, likeCount: 0 },
  ]);
  assert.throws(() => parseDurations('{"data":{}}', w), /data 배열/);
});

test('사용시간 받기: 저장(멱등), 한 구간 실패는 건너뛰고, 로그인 거절이면 이 단계만 멈춘다', async () => {
  const sql = await memoryDb();
  const windows: DurationWindow[] = [
    { postId: A, from: '2026-11-14', to: '2026-11-15' },
    { postId: B, from: '2026-11-14', to: '2026-11-14' },
  ];
  const ok: StatGetter = {
    async get(_path, params) {
      if (params.contentId!.endsWith(B)) throw new HttpStatusError(500, 'x');
      return JSON.stringify({ data: [{ date: '2026-11-14', cv: 2, averageDuration: 30 }, { date: '2026-11-15', cv: 0, averageDuration: 0 }] });
    },
  };
  const r = await fetchDurations(ok, sql, BLOG, windows, () => {}, 1);
  assert.deepEqual([r.saved, r.failures, r.stopped], [2, 1, null]);
  await fetchDurations(ok, sql, BLOG, windows, () => {}, 1);
  assert.equal(Number((await sql.query('SELECT COUNT(*) AS n FROM metric_row WHERE metric = ?', [POST_DURATION]))[0]?.n), 2, '다시 받아도 행 수 같음');

  let calls = 0;
  const refused: StatGetter = { async get() { calls++; throw new SessionExpiredError('HTTP 401'); } };
  const s = await fetchDurations(refused, sql, BLOG, windows, () => {}, 1);
  assert.match(s.stopped ?? '', /크리에이터 어드바이저/);
  assert.equal(calls, 1, '거절 뒤 남은 구간은 부르지 않음');
});

test('사용시간 합계: 조회수 × 평균을 일·주(월요일 시작)·월·게시글로 더하고, 받은 비율을 센다', async () => {
  const sql = await memoryDb();
  // 11/30(월) ~ 12/01(화): 같은 주, 달은 둘로 나뉜다
  await rank(sql, '2026-11-30', A, 60);
  await rank(sql, '2026-11-30', B, 4);
  await rank(sql, '2026-12-01', A, 10);
  await duration(sql, '2026-11-30', A, 60, 163);
  await duration(sql, '2026-11-30', B, 4, 139);
  // 12/01 A는 아직 안 받음
  const r = await new DashboardQuery(sql, () => '2026-12-02').handle('post-duration', { from: '2026-11-30', to: '2026-12-01' }, null);
  assert.equal(r.status, 200);
  const b = r.body as {
    total: { seconds: number; views: number };
    daily: { date: string; seconds: number }[];
    weekly: { key: string; from: string; to: string; seconds: number; partial: boolean }[];
    monthly: { key: string; seconds: number; partial: boolean }[];
    posts: { postId: string; title: string; seconds: number; views: number; average: number }[];
    coverage: { need: number; have: number };
  };
  assert.equal(b.total.seconds, 60 * 163 + 4 * 139);
  assert.equal(b.total.views, 64);
  assert.deepEqual(b.daily.map((d) => [d.date, d.seconds]), [['2026-11-30', 60 * 163 + 4 * 139], ['2026-12-01', 0]]);
  // 11/30은 월요일이라 두 날이 한 주(11/30~12/06, 기간 안은 이틀뿐이라 partial)
  assert.deepEqual(b.weekly.map((w) => [w.key, w.from, w.to, w.partial, w.seconds]),
    [['2026-11-30', '2026-11-30', '2026-12-01', true, 60 * 163 + 4 * 139]]);
  assert.deepEqual(b.monthly.map((m) => [m.key, m.partial]), [['2026-11', true], ['2026-12', true]]);
  assert.deepEqual(b.posts.map((p) => [p.postId, p.title, p.seconds, p.views]), [[A, '제목 1', 60 * 163, 60], [B, '제목 2', 4 * 139, 4]]);
  assert.equal(b.posts[0]!.average, 163);
  assert.deepEqual(b.coverage, { need: 3, have: 2 });
});
