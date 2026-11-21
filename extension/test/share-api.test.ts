// 짧은 공유 링크: 서버 처리기(쓰기 토큰, 크기·일수 제한, 만료, 삭제 토큰)와 브라우저 암호화(봉인·열기).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BYTES, handleShare, sweepShares, type ShareMeta, type ShareStore } from '../src/core/share-api.js';
import {
  SHARE_VERSION, ShareDecodeError, openShare, refFromHash, sealShare, shortLink, type SharePayload,
} from '../src/core/share-codec.js';

const TOKEN = 'test-token-0123456789';
const NOW = new Date('2026-11-21T09:00:00Z');
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

function memoryStore(): ShareStore & { size(): number } {
  const m = new Map<string, { data: ArrayBuffer; meta: ShareMeta }>();
  return {
    size: () => m.size,
    async get(id) { return m.get(id) ?? null; },
    async meta(id) { return m.get(id)?.meta ?? null; },
    async set(id, data, meta) { m.set(id, { data, meta }); },
    async delete(id) { m.delete(id); },
    async list() { return [...m.keys()]; },
  };
}

const url = (path: string) => 'https://share.example' + path;
const post = (body: BodyInit | null, headers: Record<string, string> = {}, query = '') =>
  new Request(url('/api/share' + query), { method: 'POST', body, headers: { Authorization: 'Bearer ' + TOKEN, ...headers } });
const bytes = (n: number) => new Uint8Array(n).fill(7);

async function upload(store: ShareStore, query = '') {
  const res = await handleShare(post(bytes(100), {}, query), store, { token: TOKEN }, NOW);
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string; deleteToken: string; expiresAt: string };
}

test('공유 API: 쓰기 토큰이 맞아야 저장하고, 토큰이 설정되지 않은 사이트는 저장을 받지 않는다', async () => {
  const store = memoryStore();
  assert.equal((await handleShare(post(bytes(10), { Authorization: 'Bearer wrong' }), store, { token: TOKEN }, NOW)).status, 401);
  assert.equal((await handleShare(post(bytes(10), { Authorization: '' }), store, { token: TOKEN }, NOW)).status, 401);
  assert.equal((await handleShare(post(bytes(10)), store, {}, NOW)).status, 503);
  assert.equal(store.size(), 0);
  const r = await upload(store);
  assert.match(r.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(r.expiresAt, later(30).toISOString(), '기본 30일');
  assert.equal(store.size(), 1);
  // 삭제 토큰 자체는 저장하지 않는다
  assert.ok(!JSON.stringify(await store.meta(r.id)).includes(r.deleteToken));
});

test('공유 API: 받은 암호문을 그대로 돌려주고, 캐시·다른 출처 설정이 맞다', async () => {
  const store = memoryStore();
  const r = await upload(store);
  const res = await handleShare(new Request(url('/api/share/' + r.id)), store, { token: TOKEN }, NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes(100));
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const pre = await handleShare(new Request(url('/api/share'), { method: 'OPTIONS' }), store, { token: TOKEN }, NOW);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers') ?? '', /Authorization/);
});

test('공유 API: 크기·일수·번호 형식을 검사한다', async () => {
  const store = memoryStore();
  assert.equal((await handleShare(post(bytes(MAX_BYTES + 1)), store, { token: TOKEN }, NOW)).status, 413);
  assert.equal((await handleShare(post(new Uint8Array(0)), store, { token: TOKEN }, NOW)).status, 400);
  assert.equal((await handleShare(post(bytes(10), {}, '?days=0'), store, { token: TOKEN }, NOW)).status, 400);
  assert.equal((await handleShare(post(bytes(10), {}, '?days=91'), store, { token: TOKEN }, NOW)).status, 400);
  assert.equal((await upload(store, '?days=7')).expiresAt, later(7).toISOString());
  for (const bad of ['/api/share/../x', '/api/share/short', '/api/share/' + 'a'.repeat(17), '/api/other']) {
    assert.equal((await handleShare(new Request(url(bad)), store, { token: TOKEN }, NOW)).status, 404, bad);
  }
  assert.equal((await handleShare(new Request(url('/api/share')), store, { token: TOKEN }, NOW)).status, 405, '목록 조회 없음');
});

test('공유 API: 만료되면 열리지 않고 지워지며, 매일 정리가 열지 않은 공유도 지운다', async () => {
  const store = memoryStore();
  const a = await upload(store, '?days=1');
  await upload(store, '?days=30');
  assert.equal((await handleShare(new Request(url('/api/share/' + a.id)), store, {}, later(2))).status, 404);
  assert.equal(store.size(), 1, '열 때 만료분 삭제');
  await upload(store, '?days=1');
  assert.equal(await sweepShares(store, later(2)), 1);
  assert.equal(store.size(), 1);
});

test('공유 API: 삭제 토큰이 맞을 때만 지운다', async () => {
  const store = memoryStore();
  const r = await upload(store);
  const del = (token: string) => handleShare(new Request(url('/api/share/' + r.id), { method: 'DELETE', headers: { 'X-Delete-Token': token } }),
    store, { token: TOKEN }, NOW);
  assert.equal((await del('wrong')).status, 403);
  assert.equal(store.size(), 1);
  assert.equal((await del(r.deleteToken)).status, 204);
  assert.equal(store.size(), 0);
  assert.equal((await del(r.deleteToken)).status, 204, '이미 없음');
});

// ---- 브라우저 암호화 ----

const payload: SharePayload = {
  v: SHARE_VERSION, createdAt: NOW.toISOString(), from: '2026-11-14', to: '2026-11-20',
  responses: { summary: { from: '2026-11-14', to: '2026-11-20', totalVisits: 1450 }, queries: [{ query: '검색어 하나', visits: 3 }] },
};

test('봉인·열기: 키로만 풀리고, 암호문에는 원문이 보이지 않는다', async () => {
  const { body, key } = await sealShare(payload);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await openShare(body, key), payload);
  assert.ok(!Buffer.from(body).toString('latin1').includes('totalVisits'));
  const other = (await sealShare(payload)).key;
  await assert.rejects(openShare(body, other), ShareDecodeError, '다른 키');
  const tampered = body.slice();
  tampered[tampered.length - 1]! ^= 1;
  await assert.rejects(openShare(tampered, key), ShareDecodeError, '바뀐 암호문');
  await assert.rejects(openShare(body, key.slice(0, 40)), /키 부분/);
});

test('짧은 링크: 형식과 길이, # 에서 번호·키 꺼내기', async () => {
  const { key } = await sealShare(payload);
  const link = shortLink('https://blog-status-collector.netlify.app/', 'AbCdEfGhIjKlMnOp', key);
  assert.equal(link, 'https://blog-status-collector.netlify.app/#k=AbCdEfGhIjKlMnOp.' + key);
  assert.ok(link.length < 120, '카톡에서 잘리지 않을 길이: ' + link.length);
  assert.deepEqual(refFromHash(new URL(link).hash), { id: 'AbCdEfGhIjKlMnOp', key });
  assert.equal(refFromHash('#k=AbCdEfGhIjKlMnOp.' + key.slice(0, 20)), null, '잘린 키');
  assert.equal(refFromHash('#/overview'), null);
});
