// 오프스크린 문서: 서비스 워커의 30초 수명 제약 없이 수집 회차를 돌리고 DB 워커를 소유한다.
// 서비스 워커(트리거), 팝업, 대시보드, 옵션 페이지는 이 문서에 메시지를 보낸다.
// 수집 요청에는 결과를 기다리지 않고 바로 답한다.
import { Db } from './db.js';
import { DEFAULT_DAILY_CAP, S, runCollection, type Outcome, type RunReport } from './core/collector.js';
import { DashboardQuery } from './core/dashboard-query.js';
import { fromBase64, looksLikeSqlite, toBase64 } from './core/base64.js';
import { importExport } from './core/importer.js';
import { StatClient, kstDate } from './core/naver.js';
import { migrate } from './core/schema.js';
import { getSetting, setSetting } from './core/sql.js';
import { readStatus, type StoredStatus } from './core/status.js';

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

/** 진행 중이면 같은 회차를 돌려준다(동시 실행 방지). */
function start(trigger: string, manual: boolean): Promise<RunReport> | null {
  if (maintenance) return null;
  running ??= (async () => {
    await ready;
    progress = { trigger, startedAt: new Date().toISOString(), requests: 0, maxRequests: 0, message: '시작' };
    const report = await runCollection({
      sql: db,
      trigger,
      manual,
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
  return running;
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
  const p = progress && client ? { ...progress, requests: client.requestsUsed, maxRequests: client.maxRequests } : progress;
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

type Msg = { target?: string; type?: string; trigger?: string; name?: string; params?: Record<string, string>; data?: unknown; base64?: string; cap?: number };
type Handler = (msg: Msg) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  status: () => status(),
  api: async (m) => query.handle(m.name ?? '', m.params ?? {}, await stored()),
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
  'get-settings': async () => ({ dailyCap: Number((await getSetting(db, S.dailyCap)) ?? DEFAULT_DAILY_CAP) }),
  'set-settings': async (m) => {
    const cap = Math.round(Number(m.cap));
    if (!Number.isFinite(cap) || cap < 50 || cap > 2000) throw new Error('하루 요청 상한은 50~2000회입니다.');
    await ready;
    await setSetting(db, S.dailyCap, String(cap));
    return { dailyCap: cap };
  },
};

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'collect') {
    const r = start(msg.trigger ?? 'unknown', msg.trigger === 'manual');
    sendResponse({ accepted: r !== null });
    return;
  }
  const h = handlers[msg.type ?? ''];
  if (!h) return;
  h(msg).then((r) => sendResponse(r), (e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
  return true;
});
