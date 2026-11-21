// 오프스크린 문서: 서비스 워커의 30초 수명 제약 없이 수집 루프를 돌리고 DB 워커를 소유한다.
// 팝업은 서비스 워커를 거치지 않고 이 문서와 직접 메시지를 주고받는다(서비스 워커는 문서만 띄운다).
// 0단계(PoC)에서는 세 가지를 확인한다.
//  1) 쿠키 파일 없이 확장 요청에 네이버 로그인 쿠키가 붙는가 (user-info, 유입 합계)
//  2) 2~5초 지연을 두고 연속 요청하는 동안 끊기지 않는가
//  3) SQLite(OPFS)에 쓴 값이 브라우저를 재시작해도 남는가
import { Db } from './db.js';
import { SessionExpiredError, StatClient, kstDate } from './core/naver.js';

const db = new Db();

interface DayCheck { date: string; http: number; rows: number; rowSum: number; totalCount: number; ok: boolean; note?: string }
export interface PocReport {
  login: { http: number | null; loggedIn: boolean; blogId?: string; error?: string };
  days: DayCheck[];
  requests: number;
  elapsedSec: number;
  sqlite: { version?: string; runCount?: number; persisted?: boolean; error?: string };
}

const POC_DAYS = 5;

/** 진행 중인 실행. 버튼을 다시 눌러도 같은 실행의 결과를 돌려준다(동시 실행 방지). */
let running: Promise<PocReport> | null = null;

function runOnce(): Promise<PocReport> {
  running ??= runPoc().finally(() => {
    running = null;
  });
  return running;
}

async function runPoc(): Promise<PocReport> {
  const started = Date.now();
  const report: PocReport = { login: { http: null, loggedIn: false }, days: [], requests: 0, elapsedSec: 0, sqlite: {} };
  const client = new StatClient({ maxRequests: 1 + POC_DAYS });

  // 1) 로그인 판정. baUserKey는 읽지 않고 blogId만 쓴다.
  try {
    const res = await client.get('/api/blog/user-info');
    report.login.http = res.status;
    const json = JSON.parse(res.body) as { blogId?: unknown; result?: { blogId?: unknown } };
    const blogId = json.blogId ?? json.result?.blogId;
    report.login.loggedIn = res.status === 200 && typeof blogId === 'string' && blogId.length > 0;
    if (typeof blogId === 'string') report.login.blogId = blogId;
  } catch (e) {
    report.login.error = e instanceof SessionExpiredError ? e.message : String(e);
  }

  // 2) 로그인돼 있을 때만 유입 합계를 어제부터 거꾸로 며칠 받는다. 만료나 네트워크 오류면 클라이언트가 이후 요청을 막는다.
  if (report.login.loggedIn) {
    for (let i = 1; i <= POC_DAYS; i++) {
      const date = kstDate(-i);
      try {
        const res = await client.get('/api/blog/daily/referer/total', {
          timeDimension: 'DATE', additionalTimeDimension: 'WEEK', startDate: date, exclude: 'weekAndMonthAnalysis',
        });
        report.days.push({ date, http: res.status, ...checkReferer(res.body, date) });
      } catch (e) {
        report.days.push({ date, http: 0, rows: 0, rowSum: 0, totalCount: -1, ok: false, note: String(e) });
        break;
      }
    }
  }
  report.requests = client.requestsUsed;

  // 3) SQLite 지속성: 실행할 때마다 1씩 늘어나는 카운터.
  try {
    report.sqlite.version = String((await db.query('__version__'))[0]?.version);
    await db.query('CREATE TABLE IF NOT EXISTS poc_run (id INTEGER PRIMARY KEY, ran_at TEXT NOT NULL)');
    await db.query('INSERT INTO poc_run (ran_at) VALUES (?)', [new Date().toISOString()]);
    report.sqlite.runCount = Number((await db.query('SELECT COUNT(*) AS n FROM poc_run'))[0]?.n);
    report.sqlite.persisted = await navigator.storage.persist();
  } catch (e) {
    report.sqlite.error = String(e);
  }

  report.elapsedSec = Math.round((Date.now() - started) / 100) / 10;
  return report;
}

/**
 * Java RefererParser와 같은 기준으로 검증한다.
 * statusCode 200, refererTotal 블록과 다섯 컬럼 존재, 컬럼 길이 일치, 날짜 일치,
 * 행 합계 == refererTotalCount, 오늘 데이터(dashboard.isToday)가 아님.
 */
function checkReferer(body: string, date: string): Omit<DayCheck, 'date' | 'http'> {
  type Block = { dataId?: string; data?: { rows?: Record<string, unknown>; value?: unknown } };
  const fail = (note: string, extra: Partial<DayCheck> = {}) => ({ rows: 0, rowSum: 0, totalCount: -1, ok: false, note, ...extra });

  let root: { statusCode?: number; result?: { statDataList?: Block[] } };
  try {
    root = JSON.parse(body);
  } catch {
    return fail('JSON 파싱 실패');
  }
  if (root.statusCode !== 200) return fail('statusCode ' + root.statusCode);

  const list = root.result?.statDataList ?? [];
  const rows = list.find((b) => b.dataId === 'refererTotal')?.data?.rows;
  if (!rows) return fail('refererTotal 블록 없음');

  const names = ['date', 'referrerDomain', 'referrerSearchEngine', 'cv', 'cv_p'];
  const cols = names.map((n) => rows[n]);
  const missing = names.filter((_, i) => !Array.isArray(cols[i]));
  if (missing.length > 0) return fail('컬럼 없음: ' + missing.join(', '));
  const arrays = cols as unknown[][];
  const size = arrays[0]!.length;
  if (arrays.some((c) => c.length !== size)) return fail('컬럼 배열 길이가 서로 다름');

  const dates = arrays[0] as string[];
  const cv = arrays[3]!.map(Number);
  const rowSum = cv.reduce((a, b) => a + b, 0);
  const countValue = list.find((b) => b.dataId === 'refererTotalCount')?.data?.value;
  const totalCount = typeof countValue === 'number' ? countValue : -1;
  const base = { rows: size, rowSum, totalCount };

  const badDate = dates.find((d) => d !== date);
  if (badDate !== undefined) return fail('응답 날짜 불일치: ' + badDate, base);
  if (totalCount >= 0 && rowSum !== totalCount) return fail('합계 불일치', base);
  const dash = list.find((b) => b.dataId === 'dashboard')?.data?.value as { isToday?: unknown } | undefined;
  if (dash?.isToday === true) return fail('오늘 데이터(집계 중)', base);
  return { ...base, ok: true };
}

chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string }, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'poc') {
    runOnce().then(sendResponse, (e) => sendResponse({ fatal: String(e) }));
    return true;
  }
});
