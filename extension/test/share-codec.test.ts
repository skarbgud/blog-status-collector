// 공유 링크 데이터: 왕복, 잘린 링크·변조·버전·크기 상한, 세션 제외, 링크 주소.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARE_VERSION, ShareDecodeError, dataFromHash, decodeShare, encodeShare, pickResponses, shareLink, type SharePayload,
} from '../src/core/share-codec.js';

const payload = (responses: Record<string, unknown>): SharePayload =>
  ({ v: SHARE_VERSION, createdAt: '2026-11-21T07:00:00.000Z', from: '2026-10-22', to: '2026-11-20', responses });

test('공유 데이터: 한글·긴 URL을 포함해 그대로 왕복하고 링크에 쓸 수 있는 글자만 쓴다', async () => {
  const p = payload({
    summary: { from: '2026-10-22', to: '2026-11-20', totalVisits: 1234 },
    'referrer-details': { referrers: [{ name: '네이버 플레이스_모바일', details: [{ text: 'https://m.place.naver.com/x?bk_query=%EA%B4%91' + 'a'.repeat(300) }] }] },
  });
  const text = await encodeShare(p);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShare(text), p);
});

test('공유 데이터: 반복이 많은 응답은 크게 줄어든다', async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ date: '2026-11-' + String((i % 30) + 1).padStart(2, '0'), metric: 'HOUR', v: i % 7 }));
  const json = JSON.stringify(payload({ metrics: rows })).length;
  const text = await encodeShare(payload({ metrics: rows }));
  assert.ok(text.length < json / 5, text.length + ' vs ' + json);
});

test('공유 데이터: 잘리거나 바뀐 링크, 다른 버전, 이상한 글자는 알아볼 수 있는 오류', async () => {
  const text = await encodeShare(payload({ summary: { a: 'x'.repeat(5000) + Math.random() } }));
  await assert.rejects(decodeShare(text.slice(0, Math.floor(text.length / 2))), ShareDecodeError);
  await assert.rejects(decodeShare(''), ShareDecodeError);
  await assert.rejects(decodeShare('abc$def'), ShareDecodeError);
  await assert.rejects(decodeShare(await encodeShare({ ...payload({}), v: 99 })), /버전/);
  const notPayload = await encodeShare({ hello: 1 } as unknown as SharePayload);
  await assert.rejects(decodeShare(notPayload), ShareDecodeError);
});

test('공유 데이터: 풀었을 때 너무 큰 데이터(압축 폭탄)는 거부한다', async () => {
  const huge = payload({ summary: 'a'.repeat(21 * 1024 * 1024) });
  const text = await encodeShare(huge);
  assert.ok(text.length < 100_000, '압축하면 작다: ' + text.length);
  await assert.rejects(decodeShare(text), /너무 큽니다/);
});

test('블로그 지표: 열 형식으로 줄였다가 순서·값 그대로 되돌리고, 안 쓰는 지표는 빼고, 소수는 셋째 자리까지', async () => {
  const items = [
    { date: '2026-11-19', metric: 'VIEWS', key: 'all', values: { total: 110, follow: 11 } },
    { date: '2026-11-19', metric: 'HOUR', key: '05', values: { cv: 3, cv_p: 14.285714285714285 } },
    { date: '2026-11-19', metric: 'REFERER_SITE', key: 'r001', values: { cv: 1 } },
    { date: '2026-11-20', metric: 'VIEWS', key: 'all', values: { total: 98 } }, // 앞 행보다 값 이름이 적다
    { date: '2026-11-20', metric: 'ARTICLE_INFO', key: '224000000001', values: { title: '제목', unavailable: true } },
    { date: '2026-11-10', metric: 'UPPER_GROUP', key: 'all', values: { avg: 1.5 } }, // 기간 밖 최신값은 뒤에 붙어 온다
  ];
  const metrics = { ready: true, from: '2026-11-19', to: '2026-11-20', latest: '2026-11-20', coverage: [{ metric: 'VIEWS', rows: 2 }], items };
  const back = await decodeShare(await encodeShare(payload({ metrics })));
  const expected = items.filter((i) => i.metric !== 'REFERER_SITE')
    .map((i) => (i.metric === 'HOUR' ? { ...i, values: { cv: 3, cv_p: 14.286 } } : i));
  assert.deepEqual(back.responses.metrics, { ...metrics, items: expected });
});

test('공유할 응답: 세션 상태와 이름이 이상한 항목은 뺀다', () => {
  assert.deepEqual(Object.keys(pickResponses({ summary: 1, session: 2, metrics: 3, '../x': 4, 'Bad': 5, 'place-queries': 6 })),
    ['summary', 'metrics', 'place-queries']);
});

test('링크: 보기 페이지 주소의 기존 #은 버리고 #s=<데이터>를 붙이며, https만 허용한다(로컬 확인용 localhost 예외)', () => {
  assert.equal(shareLink('https://blog-share.netlify.app/#/old', 'AbC'), 'https://blog-share.netlify.app/#s=AbC');
  assert.equal(shareLink('http://localhost:8787/', 'x'), 'http://localhost:8787/#s=x');
  assert.throws(() => shareLink('http://example.com/', 'x'), /https/);
  assert.equal(dataFromHash('#s=AbC'), 'AbC');
  assert.equal(dataFromHash('#/overview'), null);
  assert.equal(dataFromHash(''), null);
});
