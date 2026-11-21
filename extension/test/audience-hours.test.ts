// 독자가 오는 시간(요일×시간) 계산. 합성 데이터만 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAudienceHours, hourMatrix, topBlocks, MIN_SAMPLES, type MetricItem } from '../src/core/audience-hours.js';
import { addDays } from '../src/core/dates.js';

/** date의 시간별 조회수(24칸)를 HOUR 행으로. */
function day(date: string, cv: number[], pad = true): MetricItem[] {
  return cv.map((v, h) => ({ date, metric: 'HOUR', key: pad ? String(h).padStart(2, '0') : String(h), values: { cv: v } }));
}
const flat = (n: number) => new Array<number>(24).fill(n);
const peak = (hour: number, v: number, base = 0) => flat(base).map((x, h) => (h === hour ? v : x));
const MON = '2026-11-02'; // 월요일

test('요일별 비율의 합은 100%이고, 하루 합계로 나눠 많은 날이 평균을 끌지 않는다', () => {
  // 같은 월요일 패턴이지만 둘째 주는 조회가 10배다. 비율 평균은 같아야 한다.
  const items = [...day(MON, peak(21, 9, 1)), ...day(addDays(MON, 7), peak(21, 90, 10))];
  const r = computeAudienceHours(items);
  const mon = r.share[0]!;
  assert.equal(Math.round(mon.reduce<number>((s, v) => s + (v ?? 0), 0) * 1e6) / 1e6, 100);
  assert.equal(Math.round(mon[21]! * 1e6) / 1e6, Math.round((9 / 32) * 100 * 1e6) / 1e6);
  assert.equal(r.views[0]![21], (9 + 90) / 2);
  assert.equal(r.samples[0], 2);
  assert.equal(r.share[1]![0], null, '표본이 없는 요일은 null');
});

test('합계 0인 날(네이버 늦은 집계)은 표본에서 뺀다', () => {
  const items = [...day(MON, peak(9, 5)), ...day(addDays(MON, 7), flat(0))];
  const r = computeAudienceHours(items);
  assert.equal(r.samples[0], 1);
  assert.equal(r.days, 1);
  assert.equal(r.share[0]![9], 100);
});

test("키는 '05'와 '5' 모두 받고, 숫자가 아닌 키와 다른 지표는 무시한다", () => {
  const items: MetricItem[] = [
    ...day(MON, peak(5, 3), false),
    { date: MON, metric: 'HOUR', key: 'total', values: { cv: 999 } },
    { date: MON, metric: 'HOUR_TREND', key: '05', values: { cv: 999 } },
  ];
  const m = hourMatrix(items);
  assert.deepEqual(m.get(MON), peak(5, 3));
});

test('기간(from~to) 밖의 날짜는 뺀다', () => {
  const items = [...day(MON, peak(1, 1)), ...day(addDays(MON, 1), peak(2, 1))];
  const r = computeAudienceHours(items, addDays(MON, 1), addDays(MON, 1));
  assert.equal(r.days, 1);
  assert.equal(r.samples[0], 0);
  assert.equal(r.samples[1], 1);
});

test('상위 2시간 블록: 표본이 부족한 요일은 빼고, 동점이면 이른 요일·시각이 앞선다', () => {
  const items: MetricItem[] = [];
  for (let i = 0; i < MIN_SAMPLES; i++) {
    items.push(...day(addDays(MON, 7 * i), peak(21, 10, 1)));         // 월 20~22시
    items.push(...day(addDays(MON, 7 * i + 2), peak(8, 10, 1)));       // 수 08~10시
  }
  items.push(...day(addDays(MON, 4), peak(13, 100)));                  // 금 1일뿐(표본 부족)
  const r = computeAudienceHours(items);
  assert.deepEqual(r.top.slice(0, 2).map((b) => [b.weekday, b.fromHour, b.toHour]), [[0, 20, 22], [2, 8, 10]]);
  assert.ok(r.top.every((b) => b.weekday !== 4), '표본 부족 요일은 상위 블록에 없음');
});

test('topBlocks는 블록 점수를 블록 안 비율 합으로 계산한다', () => {
  const share = Array.from({ length: 7 }, () => new Array<number | null>(24).fill(0));
  share[3]![6] = 30; share[3]![7] = 20;
  const t = topBlocks(share, [5, 5, 5, 5, 5, 5, 5], 1, 1);
  assert.deepEqual(t, [{ weekday: 3, fromHour: 6, toHour: 8, share: 50 }]);
});

test('요일 지수 = 그 요일 일평균 / 전체 일평균', () => {
  const items = [...day(MON, flat(2)), ...day(addDays(MON, 1), flat(1))]; // 월 48, 화 24
  const r = computeAudienceHours(items);
  assert.equal(r.weekdayIndex[0], 48 / 36);
  assert.equal(r.weekdayIndex[1], 24 / 36);
  assert.equal(r.weekdayIndex[2], null);
});

test('안정성: 날짜가 14일 미만이면 null, 앞뒤 패턴이 같으면 true, 완전히 다르면 false', () => {
  const short = computeAudienceHours(Array.from({ length: 13 }, (_, i) => day(addDays(MON, i), peak(21, 5, 1))).flat());
  assert.equal(short.stable, null);

  const same = computeAudienceHours(Array.from({ length: 28 }, (_, i) => day(addDays(MON, i), peak(21, 5, 1))).flat());
  assert.equal(same.stable, true);

  const shifted = computeAudienceHours(Array.from({ length: 28 }, (_, i) =>
    day(addDays(MON, i), i < 14 ? peak(3, 5, 0) : peak(15, 5, 0))).flat());
  assert.equal(shifted.stable, false);
});

test('데이터가 없으면 빈 결과', () => {
  const r = computeAudienceHours([]);
  assert.equal(r.days, 0);
  assert.equal(r.from, null);
  assert.deepEqual(r.top, []);
  assert.ok(r.weekdayIndex.every((v) => v === null));
});
