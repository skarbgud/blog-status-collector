// 유입분석 탭: URL 풀이(describeUrl), 상세 URL 저장(스키마 V2), 조회(referrer-details, place-queries).
// URL은 모두 가짜 값이다(실제 블로그 ID·플레이스 번호가 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, NodeSql } from './node-sql.js';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describeUrl, decodeForDisplay } from '../src/core/referer-url.js';
import { REFERER_URL_UNIT, SqlRefererStore } from '../src/core/store.js';
import { DashboardQuery } from '../src/core/dashboard-query.js';
import { migrate, SCHEMA_VERSION } from '../src/core/schema.js';
import { getSetting, setSetting } from '../src/core/sql.js';
import type { RefererDay, RefererUrlRow } from '../src/core/referer.js';

const ME = 'myblog';
const PLACE = 'https://m.place.naver.com/restaurant/1234567/home?bk_query=%EA%B4%91%EC%95%88%EB%A6%AC%ED%9A%9F%EC%A7%91&n_ad_group_type=10';

// ---- describeUrl: 설계 표의 패턴마다 ----

test('URL 풀이: 이웃 새글 피드', () => {
  assert.equal(describeUrl('https://m.blog.naver.com/FeedList.naver', ME).label, '이웃 새글 피드');
});

test('URL 풀이: 내 글(PostView, /아이디/번호, 파라미터 순서·대소문자 무관)', () => {
  for (const u of [
    'https://m.blog.naver.com/PostView.naver?blogId=myblog&logNo=224000000001',
    'https://m.blog.naver.com/PostView.naver?logNo=224000000001&blogId=MyBlog',
    'https://blog.naver.com/myblog/224000000001',
  ]) {
    const d = describeUrl(u, ME);
    assert.equal(d.label, '내 글에서 이동', u);
    assert.equal(d.postNo, '224000000001');
  }
});

test('URL 풀이: 내 블로그 글 목록(카테고리·탭)', () => {
  const d = describeUrl('https://m.blog.naver.com/PostList.naver?blogId=myblog&categoryNo=3&tab=1', ME);
  assert.equal(d.label, '내 블로그 글 목록');
  assert.deepEqual(d.tags, ['카테고리 3', '탭 1']);
});

test('URL 풀이: 다른 블로그 글(추천·피드 태그)', () => {
  const a = describeUrl('https://m.blog.naver.com/PostView.naver?blogId=other1&logNo=1&recommendTrackingCode=2', ME);
  assert.equal(a.label, '다른 블로그 글');
  assert.deepEqual(a.tags, ['블로그 other1', '추천']);
  const b = describeUrl('https://blog.naver.com/other2/99?enterPage=feed', ME);
  assert.deepEqual(b.tags, ['블로그 other2', '피드']);
  assert.equal(b.postNo, undefined, '다른 블로그 글에는 내 글 번호를 붙이지 않는다');
});

test('URL 풀이: 블로그 홈 주제별 글, 이웃 관리 화면, 네이버 메인', () => {
  const t = describeUrl('https://section.blog.naver.com/ThemePost.naver?directoryNo=27', ME);
  assert.equal(t.label, '블로그 홈 주제별 글');
  assert.deepEqual(t.tags, ['주제 27']);
  assert.equal(describeUrl('https://admin.blog.naver.com/BuddyListManage.naver?blogId=other3', ME).label, 'other3의 이웃 관리 화면');
  assert.equal(describeUrl('https://admin.blog.naver.com/BuddyListManage.naver?blogId=myblog', ME).label, '내 이웃 관리 화면');
  assert.equal(describeUrl('https://m.naver.com', ME).label, '네이버 메인');
  assert.equal(describeUrl('m.naver.com/', ME).label, '네이버 메인', '스킴 없는 URL');
});

test('URL 풀이: 플레이스(탭, 검색어 디코딩, 광고 추정)', () => {
  const d = describeUrl(PLACE, ME);
  assert.equal(d.label, '플레이스 1234567 홈');
  assert.equal(d.placeQuery, '광안리횟집');
  assert.equal(d.placeId, '1234567');
  assert.deepEqual(d.tags, ['restaurant', '광고 영역(추정)']);
  const r = describeUrl('https://m.place.naver.com/place/7654321/review/visitor?n_query=%EC%B9%B4%ED%8E%98', ME);
  assert.equal(r.label, '플레이스 7654321 리뷰');
  assert.equal(r.placeQuery, '카페');
  assert.equal(describeUrl('https://m.place.naver.com/hairshop/111?query=a+b', ME).placeQuery, 'a b');
});

test('URL 풀이: 규칙 밖·깨진 URL은 분류 안 됨, 디코딩 실패는 원문', () => {
  const x = describeUrl('https://example.com/some/path?x=1', ME);
  assert.equal(x.classified, false);
  assert.equal(x.label, 'example.com/some/path');
  assert.equal(describeUrl('http://', ME).classified, false);
  assert.equal(decodeForDisplay('%EA%B4%91'), '광');
  assert.equal(decodeForDisplay('100%자연'), '100%자연');
});

test('URL 풀이: 내 블로그 ID를 모르면 내 글도 다른 블로그 글로 본다', () => {
  assert.equal(describeUrl('https://blog.naver.com/myblog/1', null).label, '다른 블로그 글');
});

// ---- 저장(스키마 V2) ----

const url = (date: string, referrer: string, u: string, visits: number): RefererUrlRow => ({ date, referrer, url: u, visits, ratio: visits });
const day = (date: string, urls?: RefererUrlRow[]): RefererDay => ({
  date, today: false, totalCount: 5,
  rows: [
    { date, referrer: '네이버 블로그_모바일', searchEngine: false, visits: 4, ratio: 80 },
    { date, referrer: '네이버 통합검색_모바일', searchEngine: true, visits: 1, ratio: 20 },
  ],
  queries: [{ date, referrer: '네이버 통합검색_모바일', query: '검색어', visits: 1, ratio: 20 }],
  urls,
});

test('저장: V1 DB를 V2로 올린다(기존 행 유지)', async () => {
  const s3 = await sqlite3InitModule();
  const sql = new NodeSql(new s3.oo1.DB(':memory:'));
  await sql.query('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await sql.query("INSERT INTO settings VALUES ('schema_version', '0')");
  await migrate(sql);
  assert.equal(await getSetting(sql, 'schema_version'), String(SCHEMA_VERSION));
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal((await sql.query('SELECT * FROM referrer_url_daily')).length, 0);
});

test('저장: 하루 저장에 URL을 함께 넣고, 같은 URL은 합치며, 두 번 저장해도 같다', async () => {
  const sql = await memoryDb();
  const store = new SqlRefererStore(sql);
  const urls = [url('2026-11-20', '네이버 블로그_모바일', 'https://m.blog.naver.com/FeedList.naver', 2),
    url('2026-11-20', '네이버 블로그_모바일', 'https://m.blog.naver.com/FeedList.naver', 1),
    url('2026-11-20', '네이버 블로그_모바일', PLACE, 1)];
  await store.save(day('2026-11-20', urls));
  await store.save(day('2026-11-20', urls));
  const rows = await sql.query('SELECT url, visits FROM referrer_url_daily ORDER BY visits DESC');
  assert.deepEqual(rows.map((r) => [r.url, r.visits]), [['https://m.blog.naver.com/FeedList.naver', 3], [PLACE, 1]]);
  assert.deepEqual([...await store.urlDatesWith('2026-11-01', '2026-11-30')], ['2026-11-20']);
});

test('저장: URL을 받지 않은 날 저장은 기존 URL 행을 건드리지 않는다', async () => {
  const sql = await memoryDb();
  const store = new SqlRefererStore(sql);
  await store.saveUrls('2026-11-20', [url('2026-11-20', 'x', 'https://m.naver.com', 1)]);
  await store.save(day('2026-11-20'));
  assert.equal((await sql.query('SELECT * FROM referrer_url_daily')).length, 1);
});

test('저장: URL 보충은 유입경로·검색어 행을 지우지 않는다', async () => {
  const sql = await memoryDb();
  const store = new SqlRefererStore(sql);
  await store.save(day('2026-11-19'));
  await store.saveUrls('2026-11-19', [url('2026-11-19', '네이버 블로그_모바일', 'https://m.naver.com', 4)]);
  await store.saveUrls('2026-11-19', [url('2026-11-19', '네이버 블로그_모바일', 'https://m.naver.com', 4)]);
  assert.equal((await sql.query('SELECT * FROM referrer_daily')).length, 2);
  assert.equal((await sql.query('SELECT * FROM search_query_daily')).length, 1);
  assert.equal((await sql.query('SELECT * FROM referrer_url_daily')).length, 1);
  assert.equal((await sql.query('SELECT * FROM collection_state WHERE unit_key = ?', [REFERER_URL_UNIT])).length, 1);
  await assert.rejects(store.saveUrls('2026-11-19', [url('2026-11-18', 'x', 'https://m.naver.com', 1)]), /다른 날짜/);
});

// ---- 조회 ----

async function seeded() {
  const sql = await memoryDb();
  await setSetting(sql, 'blog_id', ME);
  const store = new SqlRefererStore(sql);
  // 11/19: 블로그_모바일 4 = URL 4(완전), 11/20: 블로그_모바일 4 중 URL 3(일부), 통합검색은 검색어
  await store.save(day('2026-11-19', [
    url('2026-11-19', '네이버 블로그_모바일', 'https://m.blog.naver.com/FeedList.naver', 3),
    url('2026-11-19', '네이버 블로그_모바일', 'https://blog.naver.com/myblog/224000000001', 1)]));
  await store.save(day('2026-11-20', [
    url('2026-11-20', '네이버 블로그_모바일', 'https://m.blog.naver.com/FeedList.naver', 1),
    url('2026-11-20', '네이버 블로그_모바일', PLACE, 1),
    url('2026-11-20', '네이버 블로그_모바일', 'https://example.com/x', 1)]));
  await store.save(day('2026-11-18')); // 상세 미수집 날
  await sql.query("INSERT INTO metric_row VALUES ('ARTICLE_INFO', '2026-11-20', '224000000001', '{\"title\":\"내 글 제목\"}', 'x')");
  return new DashboardQuery(sql, () => '2026-11-21');
}

test('조회: 기간 합산, 비율(기간 합계 대비), 방문수 순 정렬, 상세 미수집·일부 날', async () => {
  const q = await seeded();
  const r = await q.referrerDetails({ from: '2026-11-18', to: '2026-11-20' });
  assert.equal(r.total, 15);
  assert.equal(r.unclassified, 1);
  const blog = r.referrers[0]!;
  assert.equal(blog.name, '네이버 블로그_모바일');
  assert.equal(blog.visits, 12);
  assert.equal(blog.ratio, 80);
  assert.equal(blog.days, 3);
  assert.equal(blog.detailDays, 2);
  assert.equal(blog.partialDays, 1);
  assert.deepEqual(blog.details.map((d) => [d.label, d.visits]),
    [['이웃 새글 피드', 4], ['내 글에서 이동', 1], ['example.com/x', 1], ['플레이스 1234567 홈', 1]]);
  const mine = blog.details.find((d) => d.label === '내 글에서 이동') as { postTitle: string | null };
  assert.equal(mine.postTitle, '내 글 제목');
  const search = r.referrers[1]!;
  assert.equal(search.searchEngine, true);
  assert.deepEqual(search.details.map((d) => [d.kind, d.text, d.visits]), [['query', '검색어', 3]]);
  assert.equal(search.partialDays, 0);
});

test('조회: 플레이스 검색어 집계와 API 경로', async () => {
  const q = await seeded();
  const res = await q.handle('place-queries', { from: '2026-11-18', to: '2026-11-20' }, null);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ query: '광안리횟집', visits: 1, places: ['1234567'] }]);
  const d = await q.handle('referrer-details', { from: '2026-11-20', to: '2026-11-18' }, null);
  assert.equal(d.status, 400);
});
