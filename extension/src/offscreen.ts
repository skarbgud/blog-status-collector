// 오프스크린 문서: 서비스 워커의 30초 수명 제약 없이 수집 회차를 돌리고 DB 워커를 소유한다.
// 서비스 워커(트리거), 팝업, 대시보드, 옵션 페이지는 이 문서에 메시지를 보낸다.
// 수집 요청에는 결과를 기다리지 않고 바로 답한다.
import { Db } from './db.js';
import {
  DEFAULT_DAILY_CAP, hasCap, REFETCH_DEFAULT_DAYS, REFETCH_MAX_DAYS, S, estimateRound, runCollection, type Outcome, type RunReport,
} from './core/collector.js';
import { DashboardQuery } from './core/dashboard-query.js';
import { fromBase64, looksLikeSqlite, toBase64 } from './core/base64.js';
import { importExport } from './core/importer.js';
import { BudgetExceededError, SessionExpiredError, StatClient, kstDate } from './core/naver.js';
import { migrate } from './core/schema.js';
import { getSetting, setSetting } from './core/sql.js';
import { readStatus, type StoredStatus } from './core/status.js';
import { refreshToday, remainingToday } from './core/today.js';
import { DURATION_UNITS, fetchLiveDurations, postsInRange, type DurationUnit } from './core/post-duration.js';
import { isDate } from './core/dates.js';

const db = new Db();
let ready = migrate(db);
void navigator.storage.persist().catch(() => false);
const query = new DashboardQuery(db, () => kstDate(0));

export interface Progress { trigger: string; startedAt: string; requests: number; maxRequests: number; message: string }
export interface StatusReply { stored: StoredStatus | null; progress: Progress | null; lastReport: RunReport | null; error?: string }

let running: Promise<RunReport> | null = null;
let progress: Progress | null = null;
let client: StatClient | null = null;
let lastReport: RunReport | null = null;
/** 복원·가져오기 중에는 수집을 시작하지 않는다(반대도 마찬가지). */
let maintenance = false;

/** 사람이 누른 수집이 다시 받을 일수. 범위를 벗어나면 기본값(어제 하루). */
function refetchDaysOf(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= REFETCH_MAX_DAYS ? n : REFETCH_DEFAULT_DAYS;
}

/**
 * 회차를 시작한다. 이미 돌고 있으면 시작하지 않고 'busy'를 돌려준다(동시 실행 방지).
 * 자동 회차가 도는 중에 누른 "지금 수집"이 자동 회차에 묻혀 덮어쓰기 없이 끝나는 일이 없게, 사람에게 알린다.
 */
function start(trigger: string, manual: boolean, refetchDays: number): 'started' | 'busy' | 'maintenance' {
  if (maintenance) return 'maintenance';
  if (running) return 'busy';
  running = (async () => {
    await ready;
    progress = { trigger, startedAt: new Date().toISOString(), requests: 0, maxRequests: 0, message: '시작' };
    const report = await runCollection({
      sql: db,
      trigger,
      manual,
      refetchDays,
      makeClient: (max) => (client = new StatClient({ maxRequests: max, log })),
      log,
    });
    lastReport = report;
    badge(report.outcome);
    return report;
  })()
    .catch((e): RunReport => {
      const report: RunReport = { outcome: 'error', message: String(e), requests: client?.requestsUsed ?? 0, saved: {}, failures: 0 };
      lastReport = report;
      badge('error');
      return report;
    })
    .finally(() => {
      running = null;
      progress = null;
      client = null;
    });
  return 'started';
}

function log(level: 'info' | 'warn', message: string): void {
  (level === 'warn' ? console.warn : console.info)(message);
  if (progress) progress.message = message;
}

/** 배지는 서비스 워커만 바꿀 수 있어 메시지로 부탁한다. 사람이 손써야 할 때만 표시한다. */
function badge(outcome: Outcome): void {
  const marks: Partial<Record<Outcome, { text: string; title: string }>> = {
    'login-required': { text: '!', title: '네이버 로그인이 필요합니다' },
    'login-backoff': { text: '!', title: '네이버 로그인이 필요합니다' },
    'other-account': { text: '!', title: '처음 수집한 블로그와 다른 계정입니다' },
    error: { text: '?', title: '마지막 수집에 문제가 있었습니다' },
  };
  const m = marks[outcome];
  chrome.runtime.sendMessage({ target: 'background', type: 'badge', text: m?.text ?? '', title: m?.title ?? '' }).catch(() => {});
}

async function stored(): Promise<StoredStatus> {
  await ready;
  return readStatus(db, kstDate(0));
}

async function status(): Promise<StatusReply> {
  // 상한 없음(Infinity)은 메시지로 보내면 null이 되므로 0(표시 안 함)으로 보낸다.
  const max = client && Number.isFinite(client.maxRequests) ? client.maxRequests : 0;
  const p = progress && client ? { ...progress, requests: client.requestsUsed, maxRequests: max } : progress;
  try {
    return { stored: await stored(), progress: p, lastReport };
  } catch (e) {
    return { stored: null, progress: p, lastReport, error: String(e) };
  }
}

/** 수집이 돌고 있지 않을 때만 DB를 통째로 바꾸는 작업을 한다. */
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  if (running || maintenance) throw new Error('수집이나 다른 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.');
  maintenance = true;
  try {
    await ready;
    return await work();
  } finally {
    maintenance = false;
  }
}

type Msg = {
  target?: string; type?: string; trigger?: string; name?: string; params?: Record<string, string>; data?: unknown;
  base64?: string; cap?: number; days?: number;
};

/** "지금 수집"(다시 받기) 전에 보여 줄 어림값. 요청은 보내지 않는다. */
export interface RefetchEstimate {
  days: number; estimate: number; used: number; cap: number;
  /** 상한이 없으면 true(이때 remaining은 의미 없음) */
  unlimited: boolean; remaining: number;
}
type Handler = (msg: Msg) => Promise<unknown>;

/**
 * 오늘 유입(집계 중)을 네이버에서 받아 저장하고 화면용 응답(today-details)을 돌려준다.
 * 대시보드가 fetch('/api/dashboard/today-refresh')로 부른다. 동시에 여러 번 눌러도 한 번만 받는다.
 * 수집 회차와 겹쳐도 된다(요청 수가 적고, 저장하는 곳이 다르다).
 */
let todayRun: Promise<unknown> | null = null;
async function todayRefresh(): Promise<{ status: number; body: unknown }> {
  if (maintenance) return { status: 409, body: { message: '복원·가져오기 중이에요. 끝난 뒤 다시 눌러 주세요.' } };
  await ready;
  try {
    todayRun ??= refreshToday({ sql: db, makeClient: (max) => new StatClient({ maxRequests: max, log }), log })
      .finally(() => { todayRun = null; });
    await todayRun;
  } catch (e) {
    const message = e instanceof SessionExpiredError ? '네이버 로그인이 필요해요. 크롬에서 네이버에 로그인한 뒤 다시 눌러 주세요.'
      : e instanceof BudgetExceededError ? e.message
      : '오늘 유입을 받지 못했어요. 잠시 뒤 다시 눌러 주세요. (' + (e instanceof Error ? e.message : String(e)) + ')';
    return { status: 502, body: { message } };
  }
  return query.handle('today-details', {}, await stored());
}

/**
 * 사용시간 합계: 크리에이터 어드바이저를 지금 바로 불러 더한다(저장하지 않음). 대시보드가 사용시간 탭을 볼 때만
 * fetch('/api/dashboard/post-duration?from&to&unit')로 부른다. 같은 기간·단위는 10분 동안 메모리에 둔 값을 쓴다(refresh=1이면 새로).
 * 요청 수는 run_log(trigger=duration, outcome 없음)에 남겨 하루 상한에 센다.
 */
const DURATION_CACHE_MS = 10 * 60 * 1000;
const durationCache = new Map<string, { at: number; body: unknown }>();
const durationRuns = new Map<string, Promise<{ status: number; body: unknown }>>();
async function postDuration(params: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const unit = (DURATION_UNITS as string[]).includes(params.unit ?? '') ? params.unit as DurationUnit : 'day';
  const from = params.from ?? '';
  const to = params.to ?? '';
  if (!isDate(from) || !isDate(to) || from > to) return { status: 400, body: { message: '기간이 잘못됐어요.' } };
  const key = unit + '|' + from + '|' + to;
  const hit = durationCache.get(key);
  if (hit && params.refresh !== '1' && Date.now() - hit.at < DURATION_CACHE_MS) return { status: 200, body: hit.body };
  let run = durationRuns.get(key);
  if (!run) {
    run = (async () => {
      await ready;
      const blogId = await getSetting(db, S.blogId);
      if (!blogId) return { status: 409, body: { message: '먼저 팝업에서 "지금 수집"을 한 번 해 주세요. 블로그를 확인해야 사용시간을 받을 수 있어요.' } };
      const ids = await postsInRange(db, from, to);
      const today = kstDate(0);
      const remaining = await remainingToday(db, today);
      if (remaining <= 0) return { status: 429, body: { message: '오늘 요청 상한을 다 써서 사용시간을 받을 수 없어요. 내일 다시 열어 주세요.' } };
      const client = new StatClient({ maxRequests: remaining, log });
      const startedAt = new Date().toISOString();
      try {
        const live = await fetchLiveDurations(client, blogId, ids, unit, from, to, log);
        const titles = live.posts.length > 0 ? await query.postTitles() : new Map<string, string>();
        const total = live.periods.reduce((a, p) => ({ seconds: a.seconds + p.seconds, views: a.views + p.views }), { seconds: 0, views: 0 });
        const body = {
          unit, from, to, fetchedAt: new Date().toISOString(), total, periods: live.periods,
          posts: live.posts.map((p) => ({ ...p, title: titles.get(p.postId) ?? null, average: p.views ? p.seconds / p.views : 0 })),
          postCount: ids.length, requested: live.requested, failures: live.failures, stopped: live.stopped,
        };
        if (!live.stopped && live.failures === 0) durationCache.set(key, { at: Date.now(), body });
        return { status: 200, body };
      } catch (e) {
        if (e instanceof BudgetExceededError) return { status: 429, body: { message: '오늘 요청 상한에 닿아 사용시간을 다 받지 못했어요.' } };
        return { status: 502, body: { message: '사용시간을 받지 못했어요. 잠시 뒤 다시 열어 주세요. (' + (e instanceof Error ? e.message : String(e)) + ')' } };
      } finally {
        await db.query('INSERT INTO run_log (kst_date, trigger, started_at, finished_at, requests) VALUES (?, ?, ?, ?, ?)',
          [today, 'duration', startedAt, new Date().toISOString(), client.requestsUsed]);
      }
    })().finally(() => durationRuns.delete(key));
    durationRuns.set(key, run);
  }
  return run;
}

const handlers: Record<string, Handler> = {
  status: () => status(),
  api: async (m) => (m.name === 'today-refresh' ? todayRefresh()
    : m.name === 'post-duration' ? postDuration(m.params ?? {})
    : query.handle(m.name ?? '', m.params ?? {}, await stored())),
  'export-db': () => exclusive(async () => ({ base64: toBase64(await db.exportFile()) })),
  'import-db': (m) => exclusive(async () => {
    const bytes = fromBase64(m.base64 ?? '');
    if (!looksLikeSqlite(bytes)) throw new Error('SQLite 파일이 아닙니다.');
    await db.importFile(bytes);
    ready = migrate(db); // 예전 버전 백업이면 스키마를 올린다
    await ready;
    lastReport = null;
    return { stored: await stored() };
  }),
  'import-json': (m) => exclusive(async () => ({ result: await importExport(db, m.data) })),
  'estimate-refetch': async (m): Promise<RefetchEstimate> => {
    const st = await stored();
    const days = refetchDaysOf(m.days);
    const estimate = await estimateRound(db, kstDate(0), days);
    const unlimited = !hasCap(st.dailyCap);
    return {
      days, estimate, used: st.todayRequests, cap: st.dailyCap, unlimited,
      remaining: unlimited ? estimate : Math.max(0, st.dailyCap - st.todayRequests),
    };
  },
  'get-settings': async () => ({ dailyCap: Number((await getSetting(db, S.dailyCap)) ?? DEFAULT_DAILY_CAP) }),
  'set-settings': async (m) => {
    const cap = Math.round(Number(m.cap));
    if (!Number.isFinite(cap) || (cap !== 0 && (cap < 50 || cap > 100000))) {
      throw new Error('하루 요청 상한은 0(상한 없음) 또는 50~100000회입니다.');
    }
    await ready;
    await setSetting(db, S.dailyCap, String(cap));
    return { dailyCap: cap };
  },
};

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'collect') {
    const manual = msg.trigger === 'manual';
    const r = start(msg.trigger ?? 'unknown', manual, manual ? refetchDaysOf(msg.days) : 0);
    sendResponse({ accepted: r === 'started', reason: r === 'started' ? undefined : r });
    return;
  }
  const h = handlers[msg.type ?? ''];
  if (!h) return;
  h(msg).then((r) => sendResponse(r), (e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});
