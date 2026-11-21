// 확장 메시지는 JSON으로 직렬화되므로 바이너리(백업 파일)는 base64로 주고받는다.

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** SQLite 파일 머리말("SQLite format 3\0") 확인. */
export function looksLikeSqlite(bytes: Uint8Array): boolean {
  const magic = 'SQLite format 3\u0000';
  if (bytes.length < 100) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}
