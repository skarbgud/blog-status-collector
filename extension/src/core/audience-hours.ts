// 독자가 오는 시간: 요일×시간 조회 패턴. 대시보드 metrics 응답의 HOUR 행(날짜×시간 조회수)으로 계산한다.
// DB·chrome API를 모르는 순수 함수라 대시보드(브라우저)와 테스트(Node)가 같은 코드를 쓴다.
// 설계: ~/.claude/plans/extension-analysis-features.md "D. 독자가 오는 시간"
import { isoDayOfWeek } from './dates.js';

export const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'] as const;
export const HOURS = 24;
export const BLOCK_HOURS = 2;
/** 요일 표본(날짜 수)이 이보다 적으면 그 요일 값은 "표본 부족"으로 표시한다. */
export const MIN_SAMPLES = 3;
/** 앞뒤 반으로 나눠 안정성을 판단하려면 최소 이만큼의 날짜가 있어야 한다. */
export const MIN_DAYS_FOR_STABILITY = 14;

export interface MetricItem { date: string; metric: string; key: string; values: Record<string, unknown> }

export interface TopBlock { weekday: number; fromHour: number; toHour: number; share: number }

export interface AudienceHours {
  weekdays: readonly string[];
  /** 요일(월=0)×시간: 그 요일 하루 조회 중 그 시간 비율(%)의 평균. 표본이 없으면 null. */
  share: (number | null)[][];
  /** 요일×시간: 평균 조회수. 표본이 없으면 null. */
  views: (number | null)[][];
  /** 요일별 표본 날짜 수(조회 합계가 0인 날은 뺀다). */
  samples: number[];
  /** 요일 지수: 그 요일 일평균 조회 / 전체 일평균 조회. 표본이 없으면 null. */
  weekdayIndex: (number | null)[];
  /** 2시간 블록 상위 3개(표본이 MIN_SAMPLES 이상인 요일만). */
  top: TopBlock[];
  /** 앞뒤 반의 상위 블록이 2개 이상 겹치면 true, 1개 이하면 false, 날짜가 부족하면 null. */
  stable: boolean | null;
  days: number;
  from: string | null;
  to: string | null;
}

/** HOUR 행을 날짜 → 24칸 조회수로 모은다. 키는 '05' 또는 '5' 모두 받는다. 'total'처럼 숫자가 아닌 키는 뺀다. */
export function hourMatrix(items: readonly MetricItem[], from?: string, to?: string): Map<string, number[]> {
  const byDate = new Map<string, number[]>();
  for (const it of items) {
    if (it.metric !== 'HOUR' || !/^\d{1,2}$/.test(it.key)) continue;
    if ((from && it.date < from) || (to && it.date > to)) continue;
    const h = Number(it.key);
    if (h < 0 || h >= HOURS) continue;
    const cv = Number(it.values.cv);
    if (!Number.isFinite(cv)) continue;
    let row = byDate.get(it.date);
    if (!row) { row = new Array<number>(HOURS).fill(0); byDate.set(it.date, row); }
    row[h] = (row[h] ?? 0) + cv;
  }
  return byDate;
}

const total = (row: readonly number[]) => row.reduce((s, v) => s + v, 0);
const weekdayOf = (date: string) => isoDayOfWeek(date) - 1;

/** 날짜 목록으로 요일×시간 비율 평균과 표본 수를 만든다. 합계 0인 날(늦은 집계)은 뺀다. */
function aggregate(byDate: Map<string, number[]>, dates: readonly string[]) {
  const shareSum = Array.from({ length: 7 }, () => new Array<number>(HOURS).fill(0));
  const viewSum = Array.from({ length: 7 }, () => new Array<number>(HOURS).fill(0));
  const daySum = new Array<number>(7).fill(0);
  const samples = new Array<number>(7).fill(0);
  for (const d of dates) {
    const row = byDate.get(d);
    if (!row) continue;
    const t = total(row);
    if (t <= 0) continue;
    const w = weekdayOf(d);
    samples[w]! += 1;
    daySum[w]! += t;
    for (let h = 0; h < HOURS; h++) {
      shareSum[w]![h]! += (row[h]! / t) * 100;
      viewSum[w]![h]! += row[h]!;
    }
  }
  const avg = (m: number[][]) => m.map((r, w) => r.map((v) => (samples[w]! > 0 ? v / samples[w]! : null)));
  return { share: avg(shareSum), views: avg(viewSum), samples, daySum };
}

/** 2시간 블록(요일, 시작 시각) 점수 상위 n개. 점수 = 블록 안 비율 합. */
export function topBlocks(share: (number | null)[][], samples: readonly number[], minSamples: number, n = 3): TopBlock[] {
  const blocks: TopBlock[] = [];
  for (let w = 0; w < 7; w++) {
    if (samples[w]! < minSamples) continue;
    for (let b = 0; b < HOURS; b += BLOCK_HOURS) {
      let s = 0;
      for (let h = b; h < b + BLOCK_HOURS; h++) s += share[w]![h] ?? 0;
      blocks.push({ weekday: w, fromHour: b, toHour: b + BLOCK_HOURS, share: s });
    }
  }
  // 점수가 같으면 요일·시각이 이른 쪽을 앞에 둔다(결과가 매번 같도록).
  blocks.sort((a, b) => b.share - a.share || a.weekday - b.weekday || a.fromHour - b.fromHour);
  return blocks.slice(0, n);
}

const blockKey = (b: TopBlock) => b.weekday + ':' + b.fromHour;

export function computeAudienceHours(items: readonly MetricItem[], from?: string, to?: string): AudienceHours {
  const byDate = hourMatrix(items, from, to);
  const dates = [...byDate.keys()].filter((d) => total(byDate.get(d)!) > 0).sort();
  const { share, views, samples, daySum } = aggregate(byDate, dates);

  const allDays = samples.reduce((s, v) => s + v, 0);
  const overall = allDays > 0 ? daySum.reduce((s, v) => s + v, 0) / allDays : 0;
  const weekdayIndex = samples.map((n, w) => (n > 0 && overall > 0 ? daySum[w]! / n / overall : null));

  let stable: boolean | null = null;
  if (dates.length >= MIN_DAYS_FOR_STABILITY) {
    const half = Math.floor(dates.length / 2);
    const a = aggregate(byDate, dates.slice(0, half));
    const b = aggregate(byDate, dates.slice(half));
    const ta = new Set(topBlocks(a.share, a.samples, 1).map(blockKey));
    const overlap = topBlocks(b.share, b.samples, 1).filter((x) => ta.has(blockKey(x))).length;
    stable = overlap >= 2;
  }

  return {
    weekdays: WEEKDAYS, share, views, samples, weekdayIndex,
    top: topBlocks(share, samples, MIN_SAMPLES), stable,
    days: dates.length, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null,
  };
}
