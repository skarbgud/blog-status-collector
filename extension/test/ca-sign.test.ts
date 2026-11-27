// 크리에이터 어드바이저 서명(x-ca-*): 알고리즘이 표준 HMAC-SHA256인지(Node crypto와 대조), 메시지·키 규칙, 403 재시도 훅.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { caSignHeaders, hmacSha256Hex, signKeyOf, signMessage } from '../src/core/ca-sign.js';
import { StatClient } from '../src/core/naver.js';

test('서명 키: __ca_key 값의 첫 점 앞부분, 없으면 null', () => {
  assert.equal(signKeyOf('abc123.9999.xyz'), 'abc123');
  assert.equal(signKeyOf('onlyhead'), 'onlyhead');
  assert.equal(signKeyOf(''), null);
  assert.equal(signKeyOf(null), null);
});

test('HMAC: crypto.subtle 구현이 표준 HMAC-SHA256과 같다', async () => {
  const key = 'secretKey.tail';
  const msg = signMessage('GET', '/api/v6/integrated-analysis/content-summary', '1795000000000', 'nonce-1');
  const expected = createHmac('sha256', key).update(msg).digest('hex');
  assert.equal(await hmacSha256Hex(msg, key), expected);
  assert.equal(msg, 'GET|/api/v6/integrated-analysis/content-summary|1795000000000|nonce-1', '쿼리는 서명에 넣지 않는다');
});

test('서명 헤더: pathname만 서명하고(쿼리 제외), 키가 없으면 빈 객체', async () => {
  const url = new URL('https://creator-advisor.naver.com/api/v6/integrated-analysis/content-summary?channelId=x&startDate=2026-11-01');
  const h = await caSignHeaders(url, signKeyOf('head.tail'), { now: () => 1795000000000, nonce: () => 'n1' });
  const expected = createHmac('sha256', 'head').update('GET|/api/v6/integrated-analysis/content-summary|1795000000000|n1').digest('hex');
  assert.deepEqual(h, { 'x-ca-nonce': 'n1', 'x-ca-ts': '1795000000000', 'x-ca-sig': expected });
  assert.deepEqual(await caSignHeaders(url, null), {}, '키 없으면 서명 안 함');
});

test('StatClient: extraHeaders가 요청에 붙고, onForbidden(true)면 403을 재시도한다', async () => {
  const seen: Record<string, string>[] = [];
  let calls = 0;
  const client = new StatClient({
    maxRequests: 5, maxRetries: 2, sleep: async () => {}, random: () => 0,
    extraHeaders: async () => ({ 'x-ca-sig': 'sig' + calls }),
    onForbidden: async () => true, // 매번 "고쳤으니 다시"
    fetchFn: async (_url, init) => {
      seen.push(init.headers as Record<string, string>);
      calls++;
      return new Response(calls < 2 ? 'forbidden' : '{"data":[]}',
        { status: calls < 2 ? 403 : 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const body = await client.get('/api/blog/user-info', {}, 'test');
  assert.equal(body, '{"data":[]}');
  assert.equal(calls, 2, '403 한 번 → 재시도 → 200');
  assert.equal(seen[0]!['x-ca-sig'], 'sig0');
  assert.equal(seen[0]!['Accept'], 'application/json');
});

test('StatClient: onForbidden(false)면 403을 로그인 만료로 처리한다', async () => {
  const client = new StatClient({
    maxRequests: 5, maxRetries: 1, sleep: async () => {}, random: () => 0,
    onForbidden: async () => false,
    fetchFn: async () => new Response('no', { status: 403 }),
  });
  await assert.rejects(client.get('/api/blog/user-info', {}, 'test'), /로그인/);
});
