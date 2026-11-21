// 네이버 통계 API 호출의 유일한 통로(StatClient).
// - 호스트는 blog.stat.naver.com, 경로는 아래 허용 목록, 메서드는 GET만 쓴다.
// - 쿠키는 브라우저가 붙인다. 확장은 쿠키 값을 쓰지도 저장하지도 않는다
//   (서비스 워커가 로그인 쿠키가 "있는지"만 확인해 로그아웃 상태에서는 요청을 보내지 않는다).
// - 요청 사이 1~2초 지연(2026-11-21 사용자 결정, 처음 30일 채우기 47분 → 약 20분), 재시도·백오프, 회차당 요청 상한, 로그인 만료 뒤 차단을 이 클래스가 강제한다(Java StatSession).

import { ALL } from './specs.js';

export const STAT_ORIGIN = 'https://blog.stat.naver.com';
export const USER_INFO_PATH = '/api/blog/user-info';

/** 허용 경로. 카탈로그(2026-11-21)에서 확인한 API만 넣는다. 새 API는 지표 정의(specs.ts)나 여기에 먼저 추가한다. */
const ALLOWED_PATHS = new Set<string>([
  USER_INFO_PATH,
  '/api/blog/daily/referer/total',
  '/api/blog/daily/referer/total/detail',
  ...ALL.map((s) => s.path),
]);

/** 로그인 만료(401/403, 로그인 페이지로 리다이렉트, JSON이 아닌 응답). 재시도하지 않는다. */
export class SessionExpiredError extends Error {}
/** 회차 요청 상한 도달. */
export class BudgetExceededError extends Error {}
/** 이전 요청이 만료·네트워크 오류로 끝나 이 회차가 막힌 상태(재시도를 다 쓴 네트워크 오류 포함). */
export class ClientBlockedError extends Error {}
/** 200이 아닌 응답(만료 제외). 그 요청만 실패로 보고 수집은 계속한다. 게시글 400은 삭제 글로 처리한다. */
export class HttpStatusError extends Error {
  constructor(readonly status: number, label: string) {
    super(label + ' 수집 실패: HTTP ' + status);
  }
}
/** 재시도할 만한 전송 오류(타임아웃, 네트워크). */
class TransientError extends Error {}

export interface StatResponse {
  status: number;
  body: string;
}

export function statUrl(path: string, params: Record<string, string> = {}): URL {
  if (!ALLOWED_PATHS.has(path)) {
    throw new Error('허용 목록에 없는 경로: ' + path);
  }
  const url = new URL(path, STAT_ORIGIN);
  url.search = buildQuery(params);
  return url;
}

/** Java URLEncoder와 같은 퍼센트 인코딩(공백은 화면처럼 %20). */
export function encodeParam(value: string): string {
  return encodeURIComponent(value).replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 쿼리 문자열. 넣은 순서를 지킨다(화면·Java 버전과 같은 순서). */
export function buildQuery(params: Record<string, string>): string {
  return Object.entries(params).map(([k, v]) => k + '=' + encodeParam(v)).join('&');
}

/** 지수 백오프 + 풀 지터: random(0, min(cap, base * 2^attempt)). Java Backoff와 같다. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, random: number): number {
  return Math.floor(random * Math.min(capMs, baseMs * 2 ** Math.min(attempt, 20)));
}

/** Retry-After는 초 단위 숫자만 처리한다. 날짜 형식이나 없음이면 -1. */
export function parseRetryAfterMs(header: string | null): number {
  if (header === null || !/^\s*\d+\s*$/.test(header)) return -1;
  return Number(header.trim()) * 1000;
}

export interface StatClientOptions {
  maxRequests: number;
  /** 동시에 보내는 요청 수(기본 6, 2026-11-21 사용자 결정). 429를 받으면 그 회차 동안 절반으로 줄인다 */
  maxConcurrent?: number;
  /** 요청 시작 사이 최소 간격(기본 0) */
  minGapMs?: number;
  /** 429 재시도의 최소 대기(Retry-After가 없을 때, 기본 1초). 무작위 백오프가 너무 짧게 뽑혀 바로 다시 막히지 않게 */
  min429Ms?: number;
  /** 마지막 429 뒤 이만큼 막히지 않으면 동시 수를 하나씩 되돌린다(기본 15초) */
  recoverMs?: number;
  /** 테스트용 시계 */
  now?: () => number;
  /** 429·502·503·504·타임아웃·네트워크 오류 재시도 횟수(Java app.collect.max-retries) */
  maxRetries?: number;
  baseBackoffMs?: number;
  capBackoffMs?: number;
  timeoutMs?: number;
  /** 테스트용 주입 */
  fetchFn?: (url: URL, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);

/**
 * 네이버는 속도 제한을 HTTP 500 + 본문 `{"statusCode":429,...}`로 보내기도 한다(2026-11-21 동시 6개 수집에서 확인).
 * 그런 500은 429로 바꿔 재시도·공동 감속을 한다. 다른 500은 그대로 둔다(그 요청만 실패).
 */
export function disguised429(status: number, body: string): boolean {
  if (status !== 500 || body === '') return false;
  try {
    const json = JSON.parse(body) as { statusCode?: unknown } | null;
    return json?.statusCode === 429 || json?.statusCode === '429';
  } catch {
    return false;
  }
}

/**
 * 한 회차 동안 쓰는 클라이언트. 회차마다 새로 만든다.
 * - 동시에 최대 maxConcurrent(기본 6)개를 보내고, 요청 사이 간격은 minGapMs(기본 0)다(2026-11-21 1~2초 직렬에서 바꿈).
 * - 429 재시도는 최소 1초 쉰다. 429 없이 15초가 지나면 동시 수를 하나씩 원래(maxConcurrent)까지 되돌린다.
 * - 429(또는 본문이 statusCode 429인 500)를 받으면 모든 요청이 Retry-After(없으면 백오프)만큼 함께 쉬고, 그 회차의 동시 수를 절반(최소 1)으로 줄인다.
 * - 재시도를 포함한 실제 요청 수를 상한으로 센다.
 * - 429(Retry-After 우선)·502·503·504·타임아웃·네트워크 오류는 백오프 후 재시도한다.
 *   HTTP 상태는 재시도를 다 써도 그 상태를 돌려주고(그 요청만 실패), 네트워크 오류는 회차를 막는다(오프라인).
 * - 로그인 만료(401/403, 리다이렉트, JSON 아닌 200)는 재시도 없이 막고 SessionExpiredError.
 */
export class StatClient {
  private used = 0;
  private lastAt = 0;
  private blocked: string | null = null;
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private concurrency: number;
  private pauseUntil = 0;
  private limitedAt = 0;
  private readonly maxConcurrentLimit: number;
  private readonly minGapMs: number;
  private readonly min429Ms: number;
  private readonly recoverMs: number;
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly capBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly fetchFn: (url: URL, init: RequestInit) => Promise<Response>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (level: 'info' | 'warn', message: string) => void;

  constructor(private readonly opts: StatClientOptions) {
    this.concurrency = Math.max(1, Math.floor(opts.maxConcurrent ?? 6));
    this.maxConcurrentLimit = this.concurrency;
    this.minGapMs = Math.max(0, opts.minGapMs ?? 0);
    this.min429Ms = Math.max(0, opts.min429Ms ?? 1000);
    this.recoverMs = Math.max(0, opts.recoverMs ?? 15_000);
    this.now = opts.now ?? Date.now;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.capBackoffMs = opts.capBackoffMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.log = opts.log ?? (() => {});
  }

  get requestsUsed(): number {
    return this.used;
  }

  get maxRequests(): number {
    return this.opts.maxRequests;
  }

  /** 지금 허용된 동시 요청 수(429를 받으면 줄어든다). */
  get maxConcurrent(): number {
    return this.concurrency;
  }

  /** 200 응답 본문. 200이 아니면 HttpStatusError(만료는 SessionExpiredError). */
  async get(path: string, params: Record<string, string> = {}, label = path): Promise<string> {
    const res = await this.request(path, params, label);
    if (res.status !== 200) throw new HttpStatusError(res.status, label);
    return res.body;
  }

  async request(path: string, params: Record<string, string> = {}, label = path): Promise<StatResponse> {
    const url = statUrl(path, params);
    if (this.blocked) throw new ClientBlockedError(this.blocked);
    await this.enter();
    try {
      return await this.attempts(url, label);
    } finally {
      this.leave();
    }
  }

  private async attempts(url: URL, label: string): Promise<StatResponse> {
    for (let attempt = 0; ; attempt++) {
      this.acquire();
      let failure: string;
      let retryAfter = -1;
      let last: StatResponse | null = null;
      try {
        const res = await this.send(url);
        if (!RETRY_STATUS.has(res.status)) {
          this.recover();
          return { status: res.status, body: res.body };
        }
        last = { status: res.status, body: res.body };
        failure = 'HTTP ' + res.status;
        if (res.status === 429) retryAfter = parseRetryAfterMs(res.retryAfter);
      } catch (e) {
        if (!(e instanceof TransientError)) throw e;
        failure = e.message;
      }
      if (attempt >= this.maxRetries) {
        if (last) return last; // 그 요청만 실패로 처리하고 수집은 계속한다
        this.blocked = failure;
        this.wakeAll();
        throw new ClientBlockedError(label + ' 수집 실패: 재시도 ' + this.maxRetries + '회 소진 (' + failure + ')');
      }
      const limited = last?.status === 429;
      const delay = retryAfter >= 0
        ? Math.min(retryAfter, this.capBackoffMs)
        : Math.max(limited ? this.min429Ms : 0, backoffMs(attempt, this.baseBackoffMs, this.capBackoffMs, this.random()));
      if (limited) this.slowDown(delay);
      this.log('warn', '[재시도] ' + label + ' ' + failure + ' → ' + delay + 'ms 후 (' + (attempt + 1) + '/' + this.maxRetries + ')');
      await this.sleep(delay);
    }
  }

  private acquire(): void {
    if (this.blocked) throw new ClientBlockedError(this.blocked);
    if (this.used >= this.opts.maxRequests) {
      throw new BudgetExceededError('이번 회차 요청 상한 ' + this.opts.maxRequests + '회에 도달');
    }
    this.used++;
    this.lastAt = this.now();
  }

  private async send(url: URL): Promise<StatResponse & { retryAfter: string | null }> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual', // 로그인 만료 시 nid.naver.com 리다이렉트를 따라가지 않고 감지한다
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      throw new TransientError((timeout ? '타임아웃' : '네트워크 오류') + ': ' + String(e));
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
    // 실패 응답 본문은 쓰지 않는다. 500만 속도 제한인지 보려고 읽고 버린다.
    const retryAfter = res.headers.get('retry-after');
    if (res.status === 500 && disguised429(500, await res.text().catch(() => ''))) {
      return { status: 429, body: '', retryAfter };
    }
    return { status: res.status, body: res.status === 200 ? await res.text() : '', retryAfter };
  }

  /**
   * 동시 슬롯을 잡는다. 슬롯이 없으면 다른 요청이 끝날 때까지 기다리고, 429로 함께 쉬는 중이거나
   * 요청 간격(minGapMs)이 안 지났으면 그만큼 기다린 뒤 보낸다. 막힌 회차면 기다리던 요청도 같은 오류로 끝난다.
   */
  private async enter(): Promise<void> {
    while (this.inFlight >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.blocked) throw new ClientBlockedError(this.blocked);
    }
    this.inFlight++;
    const now = this.now();
    const gap = this.lastAt === 0 ? 0 : this.lastAt + this.minGapMs - now;
    const wait = Math.max(this.pauseUntil - now, gap);
    if (wait > 0) {
      try {
        await this.sleep(wait);
      } catch (e) {
        this.leave();
        throw e;
      }
    }
  }

  private leave(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }

  /** 429: 새 요청 전부가 delay만큼 함께 쉬고, 이 회차의 동시 수를 절반(최소 1)으로 줄인다. */
  private slowDown(delay: number): void {
    this.limitedAt = this.now();
    this.pauseUntil = Math.max(this.pauseUntil, this.limitedAt + delay);
    const next = Math.max(1, Math.floor(this.concurrency / 2));
    if (next < this.concurrency) {
      this.log('warn', '[감속] 429를 받아 동시 요청을 ' + this.concurrency + ' → ' + next + '개로 줄입니다.');
      this.concurrency = next;
    }
  }

  /** 성공 응답마다: 마지막 429 뒤 recoverMs가 지났으면 동시 수를 하나 되돌리고, 기다리던 요청 하나를 더 보낸다. */
  private recover(): void {
    if (this.concurrency >= this.maxConcurrentLimit) return;
    const now = this.now();
    if (now - this.limitedAt < this.recoverMs) return;
    this.concurrency++;
    this.limitedAt = now; // 다음 회복은 다시 recoverMs 뒤
    this.log('info', '[회복] 429 없이 ' + Math.round(this.recoverMs / 1000) + '초가 지나 동시 요청을 ' + this.concurrency + '개로 늘립니다.');
    this.waiters.shift()?.();
  }

  /** 막힌 회차에서 슬롯을 기다리던 요청을 모두 깨워 같은 오류로 끝나게 한다. */
  private wakeAll(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private expire(reason: string): SessionExpiredError {
    this.blocked = '로그인 만료: ' + reason;
    this.wakeAll();
    return new SessionExpiredError('로그인이 필요합니다 (' + reason + ')');
  }
}

/** user-info 응답에서 blogId만 꺼낸다. baUserKey 등 다른 값은 읽지 않는다. */
export function parseBlogId(body: string): string | null {
  try {
    const json = JSON.parse(body) as { blogId?: unknown; result?: { blogId?: unknown } | null } | null;
    const id = json?.blogId ?? json?.result?.blogId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** 한국 시간 기준 날짜(YYYY-MM-DD). offsetDays=-1이면 어제. */
export function kstDate(offsetDays = 0, now = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600_000 + offsetDays * 86_400_000);
  return kst.toISOString().slice(0, 10);
}

/** 한국 시간 기준 시(0~23). */
export function kstHour(now = new Date()): number {
  return new Date(now.getTime() + 9 * 3600_000).getUTCHours();
}
