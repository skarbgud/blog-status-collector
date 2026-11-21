// 공유 링크의 데이터 부분. 대시보드 화면이 받은 응답(/api/dashboard/<이름>)을 그대로 모아
// JSON → deflate-raw 압축 → base64url로 만들어 링크의 # 뒤에 넣는다.
// # 뒤(fragment)는 브라우저가 서버로 보내지 않으므로, 보기 페이지를 올린 곳(Netlify)에도 데이터가 남지 않는다.
// 확장(만들기)과 보기 페이지(열기)가 이 파일 하나를 같이 쓴다. 둘 다 브라우저 내장 CompressionStream을 쓴다.

export const SHARE_VERSION = 1;
/** 링크 fragment 접두어: https://…/#s=<데이터> */
export const SHARE_PREFIX = 's=';
/** 풀었을 때 크기 상한(압축 폭탄 방지). 30일 화면 전부가 수백 KB라 넉넉하다. */
export const MAX_DECODED_BYTES = 20 * 1024 * 1024;
/** 공유에서 빼는 응답: 로그인 쿠키 상태는 보는 사람과 상관없다. */
export const EXCLUDED = new Set(['session']);
const NAME = /^[a-z][a-z-]{0,40}$/;

export interface SharePayload {
  v: number;
  /** 만든 시각(ISO) */
  createdAt: string;
  from: string;
  to: string;
  /** 응답 이름(summary, metrics, referrer-details …) → 응답 본문 */
  responses: Record<string, unknown>;
}

export class ShareDecodeError extends Error {}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ShareDecodeError('링크의 데이터 부분에 허용되지 않는 글자가 있습니다.');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new ShareDecodeError('링크의 데이터 부분을 읽을 수 없습니다(잘린 링크일 수 있습니다).');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => {});
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ShareDecodeError('공유 데이터가 너무 큽니다.');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- 크기 줄이기(링크 길이의 대부분은 블로그 지표 응답이다) ----
// 30일 실데이터로 잰 링크 데이터 길이: 그대로 24만 자 → 아래 세 가지 적용 후 약 10만 자(7일은 6.9만 → 3.7만).

/** 블로그 지표 화면(dashboard-metrics.js·dashboard-hours.js)이 쓰지 않는 지표. 공유에서 뺀다. */
export const UNUSED_METRICS = new Set(['REFERER_SEARCH', 'REFERER_SITE', 'RELATION_VISIT']);
/** 소수는 셋째 자리까지(화면은 최대 둘째 자리까지 보여 준다). 정수는 그대로. */
const roundDeep = (x: unknown): unknown => {
  if (typeof x === 'number') return Number.isInteger(x) || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000;
  if (Array.isArray(x)) return x.map(roundDeep);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, roundDeep(v)]));
  return x;
};

interface MetricItem { date: string; metric: string; key: string; values: Record<string, unknown> }
/** metrics.items를 열 형식으로: 지표마다 값 이름 목록을 한 번만 두고, 행은 [지표 번호, 날짜, 키, 값…]. 순서는 그대로다. */
interface MetricCols { metrics: string[]; keys: string[][]; rows: unknown[][] }

function packItems(items: MetricItem[]): MetricCols {
  const metrics: string[] = [];
  const keys: string[][] = [];
  const index = new Map<string, number>();
  const rows: unknown[][] = [];
  for (const it of items) {
    if (UNUSED_METRICS.has(it.metric)) continue;
    let m = index.get(it.metric);
    if (m === undefined) {
      m = metrics.length;
      index.set(it.metric, m);
      metrics.push(it.metric);
      keys.push([]);
    }
    const ks = keys[m]!;
    for (const k of Object.keys(it.values ?? {})) if (!ks.includes(k)) ks.push(k);
    rows.push([m, it.date, it.key]);
  }
  // 값 이름이 다 모인 뒤에 값을 채운다(행마다 같은 길이). 없는 값은 null로 두고, 풀 때 빼서 원래 모양으로 돌린다.
  let r = 0;
  for (const it of items) {
    if (UNUSED_METRICS.has(it.metric)) continue;
    const row = rows[r++]!;
    for (const k of keys[row[0] as number]!) row.push(it.values && k in it.values ? it.values[k] : null);
  }
  return { metrics, keys, rows };
}

function unpackItems(cols: MetricCols): MetricItem[] {
  if (!Array.isArray(cols.metrics) || !Array.isArray(cols.keys) || !Array.isArray(cols.rows)) {
    throw new ShareDecodeError('블로그 지표 데이터 형식이 잘못됐습니다.');
  }
  return cols.rows.map((row) => {
    const m = Array.isArray(row) ? row[0] : undefined;
    const ks = typeof m === 'number' ? cols.keys[m] : undefined;
    if (typeof m !== 'number' || typeof cols.metrics[m] !== 'string' || !Array.isArray(ks)) {
      throw new ShareDecodeError('블로그 지표 데이터 형식이 잘못됐습니다.');
    }
    const values: Record<string, unknown> = {};
    ks.forEach((k, i) => {
      const v = row[3 + i];
      if (v !== null && v !== undefined) values[k] = v;
    });
    return { metric: cols.metrics[m]!, date: String(row[1]), key: String(row[2]), values };
  });
}

/** 링크에 넣기 전에 줄인다(지표 열 형식, 안 쓰는 지표 제외, 소수 반올림). */
export function compactResponses(responses: Record<string, unknown>): Record<string, unknown> {
  const out = roundDeep(responses) as Record<string, unknown>;
  const m = out.metrics as { items?: MetricItem[] } | undefined;
  if (m && Array.isArray(m.items)) {
    const { items, ...rest } = m;
    out.metrics = { ...rest, cols: packItems(items) };
  }
  return out;
}

/** compactResponses를 되돌린다. 화면 스크립트가 받는 응답 모양(metrics.items)으로 만든다. */
export function expandResponses(responses: Record<string, unknown>): Record<string, unknown> {
  const out = { ...responses };
  const m = out.metrics as { cols?: MetricCols } | undefined;
  if (m && typeof m === 'object' && m.cols) {
    const { cols, ...rest } = m;
    out.metrics = { ...rest, items: unpackItems(cols) };
  }
  return out;
}

/** 화면이 받은 응답 중 공유할 것만 고른다(이름 검사, 세션 제외). */
export function pickResponses(recorded: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, body] of Object.entries(recorded ?? {})) {
    if (NAME.test(name) && !EXCLUDED.has(name) && body !== undefined) out[name] = body;
  }
  return out;
}

/** 링크 데이터를 만든다. 응답은 compactResponses로 줄여서 넣고, decodeShare가 되돌린다. */
export async function encodeShare(payload: SharePayload): Promise<string> {
  const packed = { ...payload, responses: compactResponses(pickResponses(payload.responses)) };
  const json = new TextEncoder().encode(JSON.stringify(packed));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw'), Number.MAX_SAFE_INTEGER));
}

export async function decodeShare(text: string): Promise<SharePayload> {
  const bytes = fromBase64Url(text.trim());
  if (bytes.length === 0) throw new ShareDecodeError('링크에 공유 데이터가 없습니다.');
  let raw: Uint8Array;
  try {
    raw = await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_DECODED_BYTES);
  } catch (e) {
    if (e instanceof ShareDecodeError) throw e;
    throw new ShareDecodeError('공유 데이터를 풀 수 없습니다(링크가 잘렸거나 바뀌었습니다).');
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new ShareDecodeError('공유 데이터 형식이 잘못됐습니다.');
  }
  const p = data as Partial<SharePayload> | null;
  if (!p || typeof p !== 'object') throw new ShareDecodeError('공유 데이터 형식이 잘못됐습니다.');
  if (p.v !== SHARE_VERSION) throw new ShareDecodeError('지원하지 않는 공유 데이터 버전입니다: ' + String(p.v));
  if (typeof p.from !== 'string' || typeof p.to !== 'string' || typeof p.createdAt !== 'string'
    || !p.responses || typeof p.responses !== 'object' || Array.isArray(p.responses)) {
    throw new ShareDecodeError('공유 데이터에 필요한 값이 빠져 있습니다.');
  }
  return { v: p.v, createdAt: p.createdAt, from: p.from, to: p.to, responses: expandResponses(pickResponses(p.responses)) };
}

/** 보기 페이지 주소와 데이터로 링크를 만든다. 주소의 기존 #은 버린다. */
export function shareLink(viewerUrl: string, data: string): string {
  const u = new URL(viewerUrl);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
    throw new Error('보기 페이지 주소는 https여야 합니다: ' + viewerUrl);
  }
  u.hash = '';
  return u.toString() + '#' + SHARE_PREFIX + data;
}

/** location.hash에서 데이터 부분을 꺼낸다. 공유 링크가 아니면 null. */
export function dataFromHash(hash: string): string | null {
  const h = hash.replace(/^#/, '');
  return h.startsWith(SHARE_PREFIX) ? h.slice(SHARE_PREFIX.length) : null;
}
