// 날짜는 'YYYY-MM-DD' 문자열로 다룬다(시간대 없는 달력 날짜). 문자열 비교가 곧 날짜 비교다.

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식 오류: ' + date);
  return Date.parse(date + 'T00:00:00Z');
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 엄격한 날짜 검사(Java LocalDate.parse와 같은 기준). 2026-02-30 같은 값은 거부한다. */
export function isDate(text: unknown): text is string {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const ms = Date.parse(text + 'T00:00:00Z');
  return !Number.isNaN(ms) && fromUtc(ms) === text;
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** ISO 요일: 월=1 … 일=7. */
export function isoDayOfWeek(date: string): number {
  const d = new Date(toUtc(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** 그 달 1일에서 한 달 전 1일(Java: withDayOfMonth(1).minusMonths(1)). */
export function previousMonthStart(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}
