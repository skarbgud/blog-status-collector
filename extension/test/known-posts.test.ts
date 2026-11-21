// 게시글별 지표: 이미 받은 글은 최근 순위에 있을 때만 최신 창 하나, 처음 보는 글은 기간 전체 창.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './node-sql.js';
import { MetricJob, type StatGetter } from '../src/core/metric-job.js';
import { SqlMetricStore } from '../src/core/store.js';
import { ARTICLE_CV, ARTICLE_INFO } from '../src/core/specs.js';

const rank = (date: string, id: string) => ({
  statDate: date, metric: 'RANK_POST', rowKey: 'r001', payload: JSON.stringify({ uri: 'http://blog.naver.com/me/' + id, title: 't', cv: 1, rank: 1 }),
});

test('게시글: 아는 글은 최근 15일 순위에 있으면 최신 창 1개, 없으면 건너뛰고, 새 글은 전체 창', async () => {
  const sql = await memoryDb();
  const store = new SqlMetricStore(sql);
  await store.replace('RANK_POST', [rank('2026-11-20', '224000000001')], null); // 아는 글, 최근 순위
  await store.replace('RANK_POST', [rank('2026-09-01', '224000000002')], null); // 아는 글, 오래전 순위만
  await store.replace('RANK_POST', [rank('2026-11-19', '224000000003')], null); // 처음 보는 글
  for (const id of ['224000000001', '224000000002']) {
    await store.replace('ARTICLE_INFO', [{ statDate: '2026-10-01', metric: 'ARTICLE_INFO', rowKey: id, payload: '{}' }], id);
  }
  const calls: string[] = [];
  const http: StatGetter = { async get(_p, params) { calls.push(params.contentId + '@' + params.startDate); throw new Error('stop'); } };
  const job = new MetricJob(store);
  await assert.rejects(job.execute(http, { specs: [ARTICLE_CV, ARTICLE_INFO], from: '2026-08-23', to: '2026-11-20', force: false,
    today: '2026-11-21', knownPostsLatestOnly: true }));
  // 첫 요청에서 멈추므로 계획을 따로 센다
  assert.equal(await job.estimateRequests({ specs: [ARTICLE_CV, ARTICLE_INFO], from: '2026-08-23', to: '2026-11-20', force: false,
    today: '2026-11-21', knownPostsLatestOnly: true }), 1 + 6);
  assert.equal(await job.estimateRequests({ specs: [ARTICLE_CV, ARTICLE_INFO], from: '2026-08-23', to: '2026-11-20', force: false,
    today: '2026-11-21' }), 6 * 3, '끄면 예전처럼 순위 글마다 전체 창');
});
