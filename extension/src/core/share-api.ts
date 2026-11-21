// 짧은 공유 링크의 서버 쪽(Netlify Function). 저장소를 주입받는 순수 처리기라 Node 테스트로 확인한다.
// 서버가 받는 것은 브라우저에서 암호화한 암호문뿐이다. 푸는 키는 링크의 # 뒤에만 있고 서버로 오지 않는다.
//   POST   /api/share?days=N     암호문 저장(쓰기 토큰 필요) → { id, deleteToken, expiresAt }
//   GET    /api/share/<id>       암호문(만료됐으면 지우고 404)
//   DELETE /api/share/<id>       X-Delete-Token이 맞으면 삭제
// 쓰기 토큰(SHARE_WRITE_TOKEN)이 없으면 저장을 받지 않는다(남이 이 사이트를 저장소로 쓰지 못하게).

export interface ShareMeta {
  createdAt: string;
  expiresAt: string;
  /** 삭제 토큰의 SHA-256(hex). 토큰 자체는 저장하지 않는다 */
  deleteHash: string;
}

export interface ShareStore {
  get(id: string): Promise<{ data: ArrayBuffer; meta: ShareMeta } | null>;
  /** 본문 없이 메타데이터만(만료 정리용) */
  meta(id: string): Promise<ShareMeta | null>;
  set(id: string, data: ArrayBuffer, meta: ShareMeta): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<string[]>;
}

export const MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
export const ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Delete-Token',
  'Access-Control-Max-Age': '600',
};
const BASE: Record<string, string> = { ...CORS, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...BASE, 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (status: number, message: string) => json(status, { message });

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomId = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 길이가 같아도 내용에 따라 시간이 달라지지 않게 비교한다. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const expired = (meta: ShareMeta, now: Date) => !(Date.parse(meta.expiresAt) > now.getTime());

export async function handleShare(req: Request, store: ShareStore, env: { token?: string }, now = new Date()): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const m = /^\/api\/share(?:\/([^/]*))?\/?$/.exec(url.pathname);
  if (!m) return fail(404, '없는 주소입니다.');
  const id = m[1];

  if (id === undefined || id === '') {
    if (req.method !== 'POST') return fail(405, '허용하지 않는 요청입니다.');
    if (!env.token) return fail(503, '이 사이트에 쓰기 토큰(SHARE_WRITE_TOKEN)이 설정되지 않아 공유를 저장할 수 없습니다.');
    const auth = req.headers.get('Authorization') ?? '';
    if (!sameText(auth, 'Bearer ' + env.token)) return fail(401, '쓰기 토큰이 맞지 않습니다.');
    const declared = Number(req.headers.get('Content-Length') ?? '0');
    if (declared > MAX_BYTES) return fail(413, '공유 데이터가 너무 큽니다.');
    const data = await req.arrayBuffer();
    if (data.byteLength === 0) return fail(400, '공유 데이터가 비어 있습니다.');
    if (data.byteLength > MAX_BYTES) return fail(413, '공유 데이터가 너무 큽니다.');
    const daysRaw = url.searchParams.get('days');
    const days = daysRaw === null ? DEFAULT_DAYS : Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return fail(400, '보관 일수는 1~' + MAX_DAYS + '일입니다.');
    const newId = randomId(12);
    const deleteToken = randomId(18);
    const meta: ShareMeta = {
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
      deleteHash: await sha256Hex(deleteToken),
    };
    await store.set(newId, data, meta);
    return json(201, { id: newId, deleteToken, expiresAt: meta.expiresAt });
  }

  if (!ID_PATTERN.test(id)) return fail(404, '없는 공유입니다.');
  if (req.method === 'GET') {
    const item = await store.get(id);
    if (!item) return fail(404, '없거나 만료된 공유입니다.');
    if (expired(item.meta, now)) {
      await store.delete(id);
      return fail(404, '없거나 만료된 공유입니다.');
    }
    return new Response(item.data, { status: 200, headers: { ...BASE, 'Content-Type': 'application/octet-stream' } });
  }
  if (req.method === 'DELETE') {
    const token = req.headers.get('X-Delete-Token') ?? '';
    const meta = await store.meta(id);
    if (!meta) return new Response(null, { status: 204, headers: BASE }); // 이미 없음
    if (!token || !sameText(await sha256Hex(token), meta.deleteHash)) return fail(403, '삭제 토큰이 맞지 않습니다.');
    await store.delete(id);
    return new Response(null, { status: 204, headers: BASE });
  }
  return fail(405, '허용하지 않는 요청입니다.');
}

/** 만료된 공유를 지운다(매일 도는 예약 함수). 지운 개수를 돌려준다. */
export async function sweepShares(store: ShareStore, now = new Date()): Promise<number> {
  let n = 0;
  for (const id of await store.list()) {
    const meta = await store.meta(id);
    if (!meta || expired(meta, now)) {
      await store.delete(id);
      n++;
    }
  }
  return n;
}
