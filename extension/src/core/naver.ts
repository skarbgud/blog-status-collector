// 네이버 통계 API 호출의 유일한 통로.
// - 호스트는 blog.stat.naver.com, 경로는 아래 허용 목록, 메서드는 GET만 쓴다.
// - 쿠키는 브라우저가 붙인다. 확장은 쿠키 값을 읽지도 저장하지도 않는다.

export const STAT_ORIGIN = 'https://blog.stat.naver.com';

/** 허용 경로. 카탈로그(2026-11-21)에서 확인한 API만 넣는다. 새 API는 여기에 먼저 추가한다. */
const ALLOWED_PATHS = new Set<string>([
  '/api/blog/user-info',
  '/api/blog/daily/referer/total',
  '/api/blog/daily/referer/total/detail',
]);

export class SessionExpiredError extends Error {}

export interface StatResponse {
  status: number;
  body: string;
}

export function statUrl(path: string, params: Record<string, string> = {}): URL {
  if (!ALLOWED_PATHS.has(path)) {
    throw new Error('허용 목록에 없는 경로: ' + path);
  }
  const url = new URL(path, STAT_ORIGIN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url;
}

/** GET 한 번. 로그인 페이지로 넘어가거나 401/403이면 SessionExpiredError. */
export async function statGet(path: string, params: Record<string, string> = {}): Promise<StatResponse> {
  const url = statUrl(path, params);
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403 || new URL(res.url).host !== url.host) {
    throw new SessionExpiredError('로그인이 필요합니다 (HTTP ' + res.status + ')');
  }
  return { status: res.status, body: await res.text() };
}

/** 요청 사이 2~5초 지연. 첫 요청 앞에는 두지 않는다. */
export class Pacer {
  private first = true;
  constructor(private readonly minMs = 2000, private readonly maxMs = 5000) {}

  async beforeRequest(): Promise<void> {
    if (this.first) {
      this.first = false;
      return;
    }
    const ms = this.minMs + Math.random() * (this.maxMs - this.minMs);
    await new Promise((r) => setTimeout(r, ms));
  }
}

/** 한국 시간 기준 날짜(YYYY-MM-DD). offsetDays=-1이면 어제. */
export function kstDate(offsetDays = 0, now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000 + offsetDays * 86_400_000);
  return kst.toISOString().slice(0, 10);
}
