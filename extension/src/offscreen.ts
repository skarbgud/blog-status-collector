// 오프스크린 문서: 서비스 워커의 30초 수명 제약 없이 수집 루프를 돌리고 DB 워커를 소유한다.
// 0단계(PoC)에서는 세 가지를 확인한다.
//  1) 쿠키 파일 없이 확장 요청에 네이버 로그인 쿠키가 붙는가 (user-info, 유입 합계)
//  2) 2~5초 지연을 두고 연속 요청하는 동안 끊기지 않는가
//  3) SQLite(OPFS)에 쓴 값이 브라우저를 재시작해도 남는가
import { Db } from './db.js';
import { Pacer, SessionExpiredError, kstDate, statGet } from './core/naver.js';

const db = new Db();

interface DayCheck { date: string; http: number; rows: number; rowSum: number; totalCount: number; ok: boolean; note?: string }
export interface PocReport {
  login: { http: number | null; loggedIn: boolean; blogId?: string; error?: string };
  days: DayCheck[];
  elapsedSec: number;
  sqlite: { version?: string; runCount?: number; persisted?: boolean; error?: string };
}

const POC_DAYS = 5;

async function runPoc(): Promise<PocReport> {
  const started = Date.now();
  const report: PocReport = { login: { http: null, loggedIn: false }, days: [], elapsedSec: 0, sqlite: {} };
  const pacer = new Pacer();

  // 1) 로그인 판정. baUserKey는 읽지 않고 blogId만 쓴다.
  try {
    await pacer.beforeRequest();
    const res = await statGet('/api/blog/user-info');
    report.login.http = res.status;
    const json = JSON.parse(res.body) as { blogId?: unknown; result?: { blogId?: unknown } };
    const blogId = json.blogId ?? json.result?.blogId;
    report.login.loggedIn = res.status === 200 && typeof blogId === 'string' && blogId.length > 0;
    if (typeof blogId === 'string') report.login.blogId = blogId;
  } catch (e) {
    report.login.error = e instanceof SessionExpiredError ? e.message : String(e);
  }

  // 2) 로그인돼 있을 때만 유입 합계를 어제부터 거꾸로 며칠 받는다.
  if (report.login.loggedIn) {
    for (let i = 1; i <= POC_DAYS; i++) {
      const date = kstDate(-i);
      try {
        await pacer.beforeRequest();
        const res = await statGet('/api/blog/daily/referer/total', {
          timeDimension: 'DATE', additionalTimeDimension: 'WEEK', startDate: date,
          exclude: 'weekAndMonthAnalysis', _: String(Date.now()),
        });
        report.days.push({ date, http: res.status, ...checkReferer(res.body, date) });
      } catch (e) {
        report.days.push({ date, http: 0, rows: 0, rowSum: 0, totalCount: -1, ok: false, note: String(e) });
        if (e instanceof SessionExpiredError) break;
      }
    }
  }

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

/** RefererParser와 같은 검증: refererTotal 행 합계 == refererTotalCount, 날짜 일치. */
function checkReferer(body: string, date: string): Omit<DayCheck, 'date' | 'http'> {
  type Block = { dataId?: string; data?: { rows?: Record<string, unknown[]>; value?: unknown } };
  const root = JSON.parse(body) as { statusCode?: number; result?: { statDataList?: Block[] } };
  if (root.statusCode !== 200) {
    return { rows: 0, rowSum: 0, totalCount: -1, ok: false, note: 'statusCode ' + root.statusCode };
  }
  const list = root.result?.statDataList ?? [];
  const rows = list.find((b) => b.dataId === 'refererTotal')?.data?.rows;
  const cv = (rows?.cv ?? []) as number[];
  const dates = (rows?.date ?? []) as string[];
  const countValue = list.find((b) => b.dataId === 'refererTotalCount')?.data?.value;
  const totalCount = typeof countValue === 'number' ? countValue : -1;
  const rowSum = cv.reduce((a, b) => a + Number(b), 0);
  const datesOk = dates.every((d) => d === date);
  const ok = datesOk && (totalCount < 0 || rowSum === totalCount);
  return { rows: cv.length, rowSum, totalCount, ok, note: datesOk ? undefined : '응답 날짜 불일치' };
}

chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string }, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'poc') {
    runPoc().then(sendResponse, (e) => sendResponse({ fatal: String(e) }));
    return true;
  }
});
