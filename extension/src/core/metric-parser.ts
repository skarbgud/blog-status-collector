// 통계 API 응답을 지표 행으로 푼다. Java collector/metric/MetricParser를 옮겼다(동작은 골든 테스트로 맞춘다).
// rows는 행 배열이 아니라 컬럼별 배열이라 같은 인덱스끼리 묶어 행으로 만든다.
// 배열 길이가 서로 다르면 어느 값이 어느 행의 것인지 알 수 없으므로 저장하지 않고 오류를 던진다.
import { isDate } from './dates.js';
import { EMPTY_KEY, VALUE_ROW, blockIds, isSeries, isValue, type MetricSpec } from './specs.js';

export interface MetricRow {
  statDate: string;
  metric: string;
  rowKey: string;
  /** 응답 컬럼 값들의 JSON 문자열 */
  payload: string;
}

export class MetricParseError extends Error {}

type Json = unknown;
type Scalar = string | number | null;

const isObject = (v: Json): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Jackson asInt와 같이: 숫자는 버림, 숫자 문자열은 변환, 나머지는 0. */
function asInt(v: Json): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Jackson asDouble과 같이: 숫자, 숫자 문자열, 나머지는 0. */
function asDouble(v: Json): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Java scalar(): null은 null, 숫자는 숫자, 문자열·불리언은 문자열, 배열·객체는 빈 문자열. */
function scalar(v: Json): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  return '';
}

function readRoot(json: string, spec: MetricSpec): Record<string, Json> {
  let root: Json;
  try {
    root = JSON.parse(json);
  } catch (e) {
    throw new MetricParseError(spec.id + ' JSON 파싱 실패');
  }
  if (!isObject(root) || asInt(root.statusCode) !== 200) {
    throw new MetricParseError(spec.id + ' API statusCode가 200이 아님: ' + (isObject(root) ? String(root.statusCode) : ''));
  }
  return root;
}

function blockOf(root: Record<string, Json>, blockId: string): Record<string, Json> | undefined {
  const result = root.result;
  const list = isObject(result) ? result.statDataList : undefined;
  if (!Array.isArray(list)) return undefined;
  for (const block of list) {
    if (isObject(block) && String(block.dataId ?? '') === blockId) return block;
  }
  return undefined;
}

function rowsOf(json: string, spec: MetricSpec): Record<string, Json> {
  const block = blockOf(readRoot(json, spec), spec.blockId);
  if (!block) throw new MetricParseError(spec.id + ' 응답에 ' + spec.blockId + ' 블록이 없음');
  const data = block.data;
  const rows = isObject(data) ? data.rows : undefined;
  if (!isObject(rows)) {
    // 하루 단위는 그 날 항목이 없으면 블록은 오되 rows가 빠진다(정상, 빈 날). 시계열은 구조 변경일 수 있어 엄격하게 둔다.
    if (!isSeries(spec)) return {};
    throw new MetricParseError(spec.id + ' 블록 ' + spec.blockId + '에 rows가 없음');
  }
  return rows;
}

function rowCount(rows: Record<string, Json>, names: string[], spec: MetricSpec): number {
  let size = -1;
  for (const name of names) {
    const column = rows[name];
    if (!Array.isArray(column)) throw new MetricParseError(spec.id + ' 컬럼 ' + name + '이 배열이 아님');
    if (size >= 0 && column.length !== size) {
      throw new MetricParseError(spec.id + ' 컬럼 배열 길이가 서로 다름: ' + name + ' ' + column.length + ' != ' + size);
    }
    size = column.length;
  }
  return Math.max(size, 0);
}

/** 행 구분값: 순서 이름 > 지정한 컬럼 값 > 순번(r001). */
function dayKey(values: Record<string, Scalar>, index: number, spec: MetricSpec): string {
  if (spec.indexKeys.length > 0) {
    return index < spec.indexKeys.length ? spec.indexKeys[index]! : 'i' + index;
  }
  if (spec.keyColumn !== null) {
    const key = values[spec.keyColumn];
    if (key === null || key === undefined) {
      throw new MetricParseError(spec.id + ' 행 구분 컬럼 ' + spec.keyColumn + '이 없음');
    }
    return String(key);
  }
  return 'r' + String(index + 1).padStart(3, '0');
}

function isPending(rows: Record<string, Json>, spec: MetricSpec): boolean {
  if (spec.pendingColumn === null) return false;
  const column = rows[spec.pendingColumn];
  if (!Array.isArray(column)) return false;
  return column.every((v) => asDouble(v) === 0);
}

/**
 * @param requested 하루 단위 지표에서 요청한 날짜(행의 날짜가 된다)
 * @param today     이 날짜 이후의 시계열 행은 집계 중이라 버린다
 * @param key       게시글별·시간대별 지표에서 행 구분으로 쓸 게시글 번호나 두 자리 시간. 그 밖에는 null
 */
export function parseMetric(json: string, spec: MetricSpec, requested: string, today: string,
  key: string | null = null): MetricRow[] {
  if (isValue(spec)) return parseValue(json, spec, requested, key);

  const rows = rowsOf(json, spec);
  const names = Object.keys(rows);
  const size = rowCount(rows, names, spec);
  const result: MetricRow[] = [];
  for (let i = 0; i < size; i++) {
    const values: Record<string, Scalar> = {};
    for (const name of names) values[name] = scalar((rows[name] as Json[])[i]);
    if (isSeries(spec)) {
      const raw = values.date;
      delete values.date;
      const date = String(raw);
      if (!isDate(date)) throw new MetricParseError(spec.id + ' 날짜 형식을 읽지 못함: ' + date);
      if (date >= today) continue; // 오늘은 집계 중이라 확정값이 아니다
      result.push({ statDate: date, metric: spec.id, rowKey: key ?? 'all', payload: JSON.stringify(values) });
    } else {
      result.push({ statDate: requested, metric: spec.id, rowKey: dayKey(values, i, spec), payload: JSON.stringify(values) });
    }
  }
  if (!isSeries(spec) && result.length === 0) {
    result.push({ statDate: requested, metric: spec.id, rowKey: EMPTY_KEY, payload: '{}' });
  }
  if (!isSeries(spec) && isPending(rows, spec)) {
    return []; // 집계 전. 저장하지 않으면 빈 표시도 남지 않아 다음 실행에서 다시 받는다.
  }
  return result;
}

/**
 * rows가 아니라 data.value 객체로 오는 지표. 객체인 항목은 항목 이름을 행 구분으로, 나머지는 모아 한 행(value 또는 key)으로.
 * 지정한 블록이 하나도 없으면 잘못된 응답이다. 일부만 없는 것은 허용한다.
 */
function parseValue(json: string, spec: MetricSpec, requested: string, key: string | null): MetricRow[] {
  const root = readRoot(json, spec);
  const scalars: Record<string, Scalar> = {};
  const result: MetricRow[] = [];
  let found = 0;
  for (const id of blockIds(spec)) {
    const data = blockOf(root, id)?.data;
    const value = isObject(data) ? data.value : undefined;
    if (!isObject(value)) continue;
    found++;
    for (const [name, v] of Object.entries(value)) {
      if (isObject(v)) {
        const nested: Record<string, Scalar> = {};
        for (const [k, inner] of Object.entries(v)) nested[k] = scalar(inner);
        result.push({ statDate: requested, metric: spec.id, rowKey: name, payload: JSON.stringify(nested) });
      } else {
        scalars[name] = scalar(v);
      }
    }
  }
  if (found === 0) throw new MetricParseError(spec.id + ' 응답에 ' + spec.blockId + ' 블록의 value가 없음');
  if (Object.keys(scalars).length > 0) {
    result.push({ statDate: requested, metric: spec.id, rowKey: key ?? VALUE_ROW, payload: JSON.stringify(scalars) });
  }
  return result;
}
