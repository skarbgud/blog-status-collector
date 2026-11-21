// StatClient: 지연, 재시도·백오프(Java StatSession과 같은 정책), 상한, 로그인 만료 차단.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetExceededError, ClientBlockedError, HttpStatusError, SessionExpiredError, StatClient,
  backoffMs, kstDate, kstHour, parseBlogId, parseRetryAfterMs,
} from '../src/core/naver.js';

const PATH = '/api/blog/user-info';
type Step = number | { status: number; headers?: Record<string, string>; body?: string } | 'network';

function fake(steps: Step[], opts: { maxRequests?: number } = {}) {
  const sleeps: number[] = [];
  let calls = 0;
  const client = new StatClient({
    maxRequests: opts.maxRequests ?? 100,
    random: () => 0.5,
    sleep: async (ms) => { sleeps.push(Math.round(ms)); },
    fetchFn: async () => {
      const s = steps[Math.min(calls++, steps.length - 1)]!;
      if (s === 'network') throw new TypeError('Failed to fetch');
      const o = typeof s === 'number' ? { status: s } : s;
      const json: Record<string, string> = o.status === 200 ? { 'content-type': 'application/json;charset=UTF-8' } : {};
      return new Response(o.status === 200 ? (o.body ?? '{"ok":1}') : null, { status: o.status, headers: { ...json, ...o.headers } });
    },
  });
  return { client, sleeps, calls: () => calls };
}

test('지연: 첫 요청은 바로, 이후는 직전 요청 시작부터 2~5초', async () => {
  const f = fake([200]);
  await f.client.get(PATH);
  assert.deepEqual(f.sleeps, []);
  await f.client.get(PATH);
  assert.equal(f.sleeps.length, 1);
  assert.ok(f.sleeps[0]! > 3000 && f.sleeps[0]! <= 3500, '0.5면 3.5초에서 경과 시간을 뺀 만큼: ' + f.sleeps[0]);
});

test('재시도: 503 두 번 뒤 200이면 본문을 돌려주고 재시도도 요청 수에 센다', async () => {
  const f = fake([503, 503, 200]);
  assert.equal(await f.client.get(PATH), '{"ok":1}');
  assert.equal(f.client.requestsUsed, 3);
  assert.deepEqual(f.sleeps, [500, 1000]); // 0.5 × min(30000, 1000 × 2^n)
});

test('재시도: 429는 Retry-After(초)를 따르고 상한 30초로 자른다', async () => {
  const a = fake([{ status: 429, headers: { 'retry-after': '7' } }, 200]);
  await a.client.get(PATH);
  assert.deepEqual(a.sleeps, [7000]);
  const b = fake([{ status: 429, headers: { 'retry-after': '100' } }, 200]);
  await b.client.get(PATH);
  assert.deepEqual(b.sleeps, [30000]);
});

test('재시도 소진: HTTP 상태는 그 요청만 실패하고 회차는 계속된다', async () => {
  const f = fake([502, 502, 502, 502, 200]);
  await assert.rejects(f.client.get(PATH, {}, '라벨'), (e: unknown) => e instanceof HttpStatusError && e.status === 502);
  assert.equal(f.client.requestsUsed, 4); // 처음 1 + 재시도 3
  assert.equal(await f.client.get(PATH), '{"ok":1}');
});

test('400·404는 재시도하지 않는다', async () => {
  const f = fake([400]);
  await assert.rejects(f.client.get(PATH), (e: unknown) => e instanceof HttpStatusError && e.status === 400);
  assert.equal(f.calls(), 1);
});

test('만료: 401은 재시도 없이 멈추고 이후 요청은 보내지 않는다', async () => {
  const f = fake([401, 200]);
  await assert.rejects(f.client.get(PATH), SessionExpiredError);
  await assert.rejects(f.client.get(PATH), ClientBlockedError);
  assert.equal(f.calls(), 1);
});

test('만료: 리다이렉트와 JSON이 아닌 200도 로그인 만료로 본다', async () => {
  await assert.rejects(fake([302]).client.get(PATH), SessionExpiredError);
  await assert.rejects(fake([{ status: 200, headers: { 'content-type': 'text/html' } }]).client.get(PATH), SessionExpiredError);
});

test('네트워크 오류: 재시도를 다 쓰면 회차를 막는다', async () => {
  const f = fake(['network', 'network', 'network', 'network', 200]);
  await assert.rejects(f.client.get(PATH), ClientBlockedError);
  assert.equal(f.calls(), 4);
  await assert.rejects(f.client.get(PATH), ClientBlockedError);
  assert.equal(f.calls(), 4);
});

test('네트워크 오류 뒤 회복하면 계속한다', async () => {
  const f = fake(['network', 200]);
  assert.equal(await f.client.get(PATH), '{"ok":1}');
});

test('상한: 재시도를 포함해 상한을 넘으면 멈춘다', async () => {
  const f = fake([503, 503, 200], { maxRequests: 2 });
  await assert.rejects(f.client.get(PATH), BudgetExceededError);
  assert.equal(f.calls(), 2);
});

test('허용 목록에 없는 경로는 보내지 않는다', async () => {
  const f = fake([200]);
  await assert.rejects(f.client.get('/api/blog/somewhere-else'), /허용 목록/);
  assert.equal(f.calls(), 0);
});

test('백오프와 Retry-After 해석은 Java와 같다', () => {
  assert.equal(backoffMs(0, 1000, 30000, 0.5), 500);
  assert.equal(backoffMs(5, 1000, 30000, 0.999), 29970);
  assert.equal(backoffMs(40, 1000, 30000, 1), 30000);
  assert.equal(parseRetryAfterMs(' 12 '), 12000);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT'), -1);
  assert.equal(parseRetryAfterMs(null), -1);
});

test('user-info: blogId만 꺼낸다', () => {
  assert.equal(parseBlogId('{"baUserKey":"k","blogId":"me"}'), 'me');
  assert.equal(parseBlogId('{"result":{"blogId":"me"}}'), 'me');
  assert.equal(parseBlogId('{"blogId":""}'), null);
  assert.equal(parseBlogId('{"statusCode":401,"result":null}'), null);
  assert.equal(parseBlogId('<html>'), null);
  assert.equal(parseBlogId('null'), null);
});

test('한국 시간 날짜·시', () => {
  const t = new Date('2026-11-20T19:30:00Z'); // KST 11/21 04:30
  assert.equal(kstDate(0, t), '2026-11-21');
  assert.equal(kstDate(-1, t), '2026-11-20');
  assert.equal(kstHour(t), 4);
  assert.equal(kstHour(new Date('2026-11-20T18:59:00Z')), 3);
});
