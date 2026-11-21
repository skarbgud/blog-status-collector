// runPool: 동시 수 상한, 치명 오류면 새 항목을 시작하지 않고 진행 중인 것이 끝난 뒤 던진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from '../src/core/pool.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('풀: limit개까지만 동시에 돌리고 모든 항목을 처리한다', async () => {
  let active = 0;
  let peak = 0;
  const done: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
    done.push(n);
  });
  assert.equal(peak, 3);
  assert.deepEqual([...done].sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test('풀: 오류가 나면 새 항목은 시작하지 않고, 진행 중인 항목이 끝난 뒤 첫 오류를 던진다', async () => {
  const started: number[] = [];
  const finished: number[] = [];
  await assert.rejects(runPool([1, 2, 3, 4, 5], 2, async (n) => {
    started.push(n);
    if (n === 1) throw new Error('멈춤');
    await tick();
    finished.push(n);
  }), /멈춤/);
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(finished, [2]);
});

test('풀: 빈 목록이면 바로 끝난다', async () => {
  await runPool([], 6, async () => { throw new Error('호출되면 안 됨'); });
});
