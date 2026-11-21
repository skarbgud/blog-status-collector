// 유입경로·검색어 골든 테스트(Java RefererGoldenDumpTest가 만든 test/golden/referer.json과 비교)와 검색어 합치기.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HttpStatusError, buildQuery } from '../src/core/naver.js';
import { RefererParseError, fetchRefererDay, mergeQueries, parseReferer } from '../src/core/referer.js';
import type { StatGetter } from '../src/core/metric-job.js';

const read = (p: string) => JSON.parse(readFileSync(resolve(p), 'utf8'));
const fx = read('test/fixtures/referer-cases.json');
const golden = read('test/golden/referer.json');

function http(total: unknown, urls: string[]): StatGetter {
  return {
    async get(path, params, label) {
      urls.push(path + '?' + buildQuery(params));
      if (!path.endsWith('/detail')) return JSON.stringify(total);
      const detail = fx.details[params.refererDomain!];
      if (typeof detail === 'number') throw new HttpStatusError(detail, label);
      return JSON.stringify(detail);
    },
  };
}

for (const name of ['normal', 'today'] as const) {
  test('유입경로 하루 수집: ' + name, async () => {
    const total = structuredClone(fx.total);
    if (name === 'today') total.result.statDataList[2].data.value.isToday = true;
    const urls: string[] = [];
    const day = await fetchRefererDay(http(total, urls), fx.date, 100);
    const g = golden[name];
    assert.deepEqual(urls, g.urls);
    assert.equal(day.today, g.today);
    assert.equal(day.totalCount, g.totalCount);
    assert.deepEqual(day.rows, g.rows);
    assert.deepEqual(day.queries, g.queries);
  });
}

for (const [i, c] of (fx.parseErrors as { name: string; body: unknown }[]).entries()) {
  test('유입경로 파싱 오류: ' + c.name, () => {
    assert.equal(golden.parseErrors[i].name, c.name);
    const run = () => parseReferer(JSON.stringify(c.body), fx.date);
    if (golden.parseErrors[i].error) assert.throws(run, RefererParseError);
    else assert.doesNotThrow(run);
  });
}

test('같은 유입처·검색어는 방문수와 비율을 합치고 처음 순서를 유지한다', () => {
  const rows = golden.normal.queries;
  const merged = mergeQueries(rows);
  assert.deepEqual(merged.map((q) => [q.query, q.visits]), [['검색어 하나', 23], ['공백 있는 검색어', 6]]);
  assert.ok(Math.abs(merged[0]!.ratio - 76.7) < 1e-9);
});
