// 네이버 통계 API 호출의 유일한 통로(StatClient).
// - 호스트는 blog.stat.naver.com, 경로는 아래 허용 목록, 메서드는 GET만 쓴다.
// - 쿠키는 브라우저가 붙인다. 확장은 쿠키 값을 읽지도 저장하지도 않는다.
// - 요청 사이 2~5초 지연, 회차당 요청 상한, 로그인 만료나 네트워크 오류 뒤 차단을 이 클래스가 강제한다.

export const STAT_ORIGIN = 'https://blog.stat.naver.com';

/** 허용 경로. 카탈로그(2026-11-21)에서 확인한 API만 넣는다. 새 API는 여기에 먼저 추가한다. */
const ALLOWED_PATHS = new Set<string>([
  '/api/blog/user-info',
  '/api/blog/daily/referer/total',
  '/api/blog/daily/referer/total/detail',
]);

/** 로그인 만료(401/403, 로그인 페이지로 리다이렉트, JSON이 아닌 응답). 재시도하지 않는다. */
export class SessionExpiredError extends Error {}
/** 회차 요청 상한 도달. */
export class BudgetExceededError extends Error {}
/** 이전 요청이 만료·네트워크 오류로 끝나 이 회차가 막힌 상태. */
export class ClientBlockedError extends Error {}

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

export interface StatClientOptions {
  maxRequests: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** 한 회차 동안 쓰는 클라이언트. 회차마다 새로 만든다. */
export class StatClient {
  private used = 0;
  private lastAt = 0;
  private blocked: string | null = null;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(private readonly opts: StatClientOptions) {
    this.minDelayMs = opts.minDelayMs ?? 2000;
    this.maxDelayMs = opts.maxDelayMs ?? 5000;
  }

  get requestsUsed(): number {
    return this.used;
  }

  async get(path: string, params: Record<string, string> = {}): Promise<StatResponse> {
    if (this.blocked) throw new ClientBlockedError(this.blocked);
    if (this.used >= this.opts.maxRequests) {
      throw new BudgetExceededError('이번 회차 요청 상한 ' + this.opts.maxRequests + '회에 도달');
    }
    const url = statUrl(path, params);
    await this.pace();
    this.used++;
    this.lastAt = Date.now();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual', // 로그인 만료 시 nid.naver.com 리다이렉트를 따라가지 않고 감지한다
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      this.block('네트워크 오류: ' + String(e));
      throw e;
    }

    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw this.expire('로그인 페이지로 이동하는 응답(리다이렉트)');
    }
    if (res.status === 401 || res.status === 403) {
      throw this.expire('HTTP ' + res.status);
    }
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 200 && !type.includes('json')) {
      throw this.expire('JSON이 아닌 응답(' + (type || '형식 없음') + '), 로그인 페이지로 추정');
    }
    return { status: res.status, body: await res.text() };
  }

  /** 첫 요청 앞에는 지연을 두지 않고, 이후에는 직전 요청 시작부터 2~5초가 지나야 보낸다. */
  private async pace(): Promise<void> {
    if (this.lastAt === 0) return;
    const wait = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    const remain = this.lastAt + wait - Date.now();
    if (remain > 0) await new Promise((r) => setTimeout(r, remain));
  }

  private expire(reason: string): SessionExpiredError {
    this.block('로그인 만료: ' + reason);
    return new SessionExpiredError('로그인이 필요합니다 (' + reason + ')');
  }

  private block(reason: string): void {
    this.blocked = reason;
  }
}

/** 한국 시간 기준 날짜(YYYY-MM-DD). offsetDays=-1이면 어제. */
export function kstDate(offsetDays = 0, now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000 + offsetDays * 86_400_000);
  return kst.toISOString().slice(0, 10);
}
