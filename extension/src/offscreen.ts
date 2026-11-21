// 오프스크린 문서: 서비스 워커의 30초 수명 제약 없이 수집 회차를 돌리고 DB 워커를 소유한다.
// 서비스 워커(트리거)와 팝업은 이 문서에 메시지를 보낸다. 수집 요청에는 결과를 기다리지 않고 바로 답한다.
import { Db } from './db.js';
import { runCollection, type Outcome, type RunReport } from './core/collector.js';
import { StatClient, kstDate } from './core/naver.js';
import { migrate } from './core/schema.js';
import { readStatus, type StoredStatus } from './core/status.js';

const db = new Db();
const ready = migrate(db);
void navigator.storage.persist().catch(() => false);

export interface Progress { trigger: string; startedAt: string; requests: number; maxRequests: number; message: string }
export interface StatusReply { stored: StoredStatus | null; progress: Progress | null; lastReport: RunReport | null; error?: string }

let running: Promise<RunReport> | null = null;
let progress: Progress | null = null;
let client: StatClient | null = null;
let lastReport: RunReport | null = null;

/** 진행 중이면 같은 회차를 돌려준다(동시 실행 방지). */
function start(trigger: string, manual: boolean): Promise<RunReport> {
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

async function status(): Promise<StatusReply> {
  const p = progress && client ? { ...progress, requests: client.requestsUsed, maxRequests: client.maxRequests } : progress;
  try {
    await ready;
    return { stored: await readStatus(db, kstDate(0)), progress: p, lastReport };
  } catch (e) {
    return { stored: null, progress: p, lastReport, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string; trigger?: string }, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'collect') {
    void start(msg.trigger ?? 'unknown', msg.trigger === 'manual');
    sendResponse({ accepted: true });
    return;
  }
  if (msg.type === 'status') {
    status().then(sendResponse);
    return true;
  }
});
