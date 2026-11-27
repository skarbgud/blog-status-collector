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
import { refreshToday } from './core/today.js';

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

const handlers: Record<string, Handler> = {
  status: () => status(),
  api: async (m) => (m.name === 'today-refresh' ? todayRefresh() : query.handle(m.name ?? '', m.params ?? {}, await stored())),
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
