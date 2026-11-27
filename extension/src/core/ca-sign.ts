// 크리에이터 어드바이저 요청 서명(x-ca-*). 네이버 화면 스크립트가 자기 요청에 붙이는 것과 같은 방식을 재현한다.
// 서명은 네이버가 브라우저에 심어 준 쿠키 __ca_key를 키로 쓰는 요청 무결성 검사(요청이 정상 클라이언트에서 왔는지)이고,
// 로그인·권한 경계가 아니다. 본인 계정·본인 블로그 데이터를 본인 세션으로 받을 때만 쓴다.
// message = `METHOD|pathname|ts|nonce` (쿼리 제외), key = __ca_key 값의 첫 '.' 앞 부분. HMAC-SHA256 → 소문자 hex.
// crypto.subtle은 오프스크린 문서·Node 테스트 둘 다 있다. 비밀값(키·쿠키·서명)은 로그에 남기지 않는다.

/** __ca_key 쿠키 값에서 서명 키를 뽑는다(첫 '.' 앞). 없으면 null. */
export function signKeyOf(caKeyValue: string | null | undefined): string | null {
  if (!caKeyValue) return null;
  const head = caKeyValue.split('.')[0];
  return head ? head : null;
}

export function signMessage(method: string, pathname: string, ts: string, nonce: string): string {
  return method.toUpperCase() + '|' + pathname + '|' + ts + '|' + nonce;
}

export async function hmacSha256Hex(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CaSignOptions {
  now?: () => number;
  nonce?: () => string;
  method?: string;
}

/** 서명 헤더 세 개. 키가 없으면 빈 객체(서명 없이 보내 403을 받고 키를 새로 받는다). */
export async function caSignHeaders(url: URL | string, signKey: string | null, opts: CaSignOptions = {}): Promise<Record<string, string>> {
  if (!signKey) return {};
  const pathname = (typeof url === 'string' ? new URL(url) : url).pathname;
  const ts = String((opts.now ?? Date.now)());
  const nonce = (opts.nonce ?? (() => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2))))();
  const sig = await hmacSha256Hex(signMessage(opts.method ?? 'GET', pathname, ts, nonce), signKey);
  return { 'x-ca-nonce': nonce, 'x-ca-ts': ts, 'x-ca-sig': sig };
}
