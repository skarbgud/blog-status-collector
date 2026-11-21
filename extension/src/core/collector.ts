// 수집 회차 하나. "로그인돼 있으면 수집한다" 정책의 본체이고, 오프스크린 문서가 트리거마다 부른다.
// 요청을 보내기 전에 로컬에서 판단할 수 있는 것은 모두 먼저 판단한다(요청 0회로 끝나는 경우):
//   04:00 KST 전 / 오늘 이미 끝남 / 하루 상한 소진 / 최근 로그인 실패(6시간 안) / 다른 계정에 묶임(로그인 확인 후)
// 그다음 user-info로 로그인과 블로그 ID를 확인하고, 어제까지 30일 범위에서 빠진 것만 받는다.
//   1) 유입경로·검색어: 받지 않은 날짜(최신순)
//   2) 지표 시계열: 처음이면 30일(15일 창 2번), 이후에는 어제를 포함한 창 1번(늦게 확정된 값도 덮어쓴다)
//   3) 나머지 지표: 받지 않은 날짜·시간대·게시글(MetricJob)
import { addDays } from './dates.js';
import { MetricJob, type JobLog, type MetricPlan, type StatGetter } from './metric-job.js';
import { RefererParseError, fetchRefererDay } from './referer.js';
import {
  BudgetExceededError, ClientBlockedError, HttpStatusError, SessionExpiredError, USER_INFO_PATH,
  buildQuery, kstDate, kstHour, parseBlogId, type StatClient,
} from './naver.js';
import { ALL, isSeries, type MetricSpec } from './specs.js';
import { deleteSetting, getSetting, setSetting, type Sql } from './sql.js';
import { SqlMetricStore, SqlRefererStore } from './store.js';

export const DEFAULT_DAILY_CAP = 300;
export const RANGE_DAYS = 30;
/** 네이버가 어제분(순방문자·시간대)을 확정하는 시각. 2026-11-21 02:36엔 0, 03:20대엔 확정돼 있었다. */
export const READY_HOUR_KST = 4;
export const LOGIN_RETRY_MS = 6 * 3600_000;
export const RAW_KEEP_DAYS = 14;

export const S = {
  blogId: 'blog_id',
  dailyCap: 'daily_cap',
  completeDate: 'complete_date',
  loginFailedAt: 'login_failed_at',
  otherAccount: 'other_account_seen_at',
} as const;

export type Outcome =
  | 'done'            // 받을 것을 다 받음
  | 'partial'         // 집계 전 값이 있어 다음 확인 때 다시 받음
  | 'up-to-date'      // 오늘 이미 끝남(요청 0회)
  | 'waiting'         // 04:00 KST 전(요청 0회)
  | 'cap-reached'     // 하루 상한(요청 0회 또는 도중 멈춤). 내일 이어서
  | 'login-required'  // 로그인 안 됨·만료
  | 'login-backoff'   // 최근 로그인 실패라 잠시 쉼(요청 0회)
  | 'other-account'   // 처음 묶인 블로그와 다른 계정
  | 'error';          // 네트워크 등. 다음 확인 때 다시

export interface RunReport {
  outcome: Outcome;
  message: string;
  requests: number;
  saved: Record<string, number>;
  failures: number;
}

export interface CollectorDeps {
  sql: Sql;
  /** 회차 요청 상한으로 클라이언트를 만든다(하루 상한에서 오늘 쓴 만큼 뺀 값). */
  makeClient(maxRequests: number): StatClient;
  now?: Date;
  log?: JobLog;
  trigger: string;
  /** 사용자가 "지금 수집"을 누름: 오늘 끝남·로그인 실패 대기를 무시한다(시각·상한은 지킨다). */
  manual?: boolean;
}

export async function runCollection(deps: CollectorDeps): Promise<RunReport> {
  const { sql } = deps;
  const now = deps.now ?? new Date();
  const log: JobLog = deps.log ?? (() => {});
  const today = kstDate(0, now);
  const iso = now.toISOString();
  const report: RunReport = { outcome: 'done', message: '', requests: 0, saved: {}, failures: 0 };
  const finish = (outcome: Outcome, message: string) => {
    report.outcome = outcome;
    report.message = message;
    log('info', '[' + outcome + '] ' + message);
    return report;
  };

  // ---- 요청 없이 판단 ----
  if (kstHour(now) < READY_HOUR_KST) {
    return finish('waiting', '네이버가 어제 통계를 확정하는 04:00 이후에 받습니다.');
  }
  if (!deps.manual && (await getSetting(sql, S.completeDate)) === today) {
    return finish('up-to-date', '오늘 받을 것은 모두 받았습니다.');
  }
  const failedAt = await getSetting(sql, S.loginFailedAt);
  if (!deps.manual && failedAt && now.getTime() - Date.parse(failedAt) < LOGIN_RETRY_MS) {
    return finish('login-backoff', '최근 로그인 확인에 실패해 잠시 쉽니다. 네이버에 로그인한 뒤 "지금 수집"을 누르세요.');
  }
  const cap = Number((await getSetting(sql, S.dailyCap)) ?? DEFAULT_DAILY_CAP);
  const usedToday = Number((await sql.query('SELECT COALESCE(SUM(requests), 0) AS n FROM run_log WHERE kst_date = ?', [today]))[0]?.n ?? 0);
  const remaining = cap - usedToday;
  if (remaining <= 0) {
    return finish('cap-reached', '오늘 요청 상한(' + cap + '회)을 다 썼습니다. 내일 이어서 받습니다.');
  }

  // ---- 요청하는 회차 ----
  const runId = Number((await sql.query(
    'INSERT INTO run_log (kst_date, trigger, started_at) VALUES (?, ?, ?) RETURNING id', [today, deps.trigger, iso]))[0]?.id);
  const client = deps.makeClient(remaining);
  try {
    await collect(deps, client, today, log, report, finish);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      await setSetting(sql, S.loginFailedAt, iso);
      finish('login-required', '네이버 로그인이 필요합니다. 로그인하면 다음 확인 때(30분 안) 이어서 받습니다.');
    } else if (e instanceof BudgetExceededError) {
      finish('cap-reached', '오늘 요청 상한(' + cap + '회)에 닿아 멈췄습니다. 내일 이어서 받습니다.');
    } else if (e instanceof ClientBlockedError) {
      finish('error', '네트워크 문제로 멈췄습니다. 다음 확인 때 다시 시도합니다. (' + e.message + ')');
    } else {
      finish('error', '수집 중 오류: ' + (e instanceof Error ? e.message : String(e)));
    }
  } finally {
    report.requests = client.requestsUsed;
    await sql.query('UPDATE run_log SET finished_at = ?, requests = ?, outcome = ?, message = ? WHERE id = ?',
      [new Date().toISOString(), report.requests, report.outcome, report.message, runId]);
    await sql.query('DELETE FROM raw_response WHERE fetched_at < ?', [addDays(today, -RAW_KEEP_DAYS)]);
  }
  return report;
}

async function collect(deps: CollectorDeps, client: StatClient, today: string, log: JobLog, report: RunReport,
  finish: (o: Outcome, m: string) => RunReport): Promise<void> {
  const { sql } = deps;

  // 로그인과 블로그 ID. baUserKey는 읽지 않고, 응답 원문도 저장하지 않는다.
  const info = await client.request(USER_INFO_PATH, {}, '로그인 확인');
  const blogId = info.status === 200 ? parseBlogId(info.body) : null;
  if (!blogId) {
    if (info.status !== 200) throw new HttpStatusError(info.status, '로그인 확인');
    throw new SessionExpiredError('로그인 정보 없음');
  }
  await deleteSetting(sql, S.loginFailedAt);
  const bound = await getSetting(sql, S.blogId);
  if (bound === null) {
    await setSetting(sql, S.blogId, blogId);
    log('info', '[블로그] 이 확장을 지금 로그인한 블로그에 묶었습니다.');
  } else if (bound !== blogId) {
    await setSetting(sql, S.otherAccount, new Date().toISOString());
    finish('other-account', '처음 수집한 블로그와 다른 계정으로 로그인돼 있어 받지 않습니다.');
    return;
  }

  const http = recording(client, sql);
  const to = addDays(today, -1);
  const from = addDays(to, -(RANGE_DAYS - 1));

  // 1) 유입경로·검색어
  const referers = new SqlRefererStore(sql);
  const have = await referers.datesWith(from, to);
  for (let d = to; d >= from; d = addDays(d, -1)) {
    if (have.has(d)) continue;
    try {
      const day = await fetchRefererDay(http, d, 100, log);
      if (await referers.save(day)) report.saved.REFERER = (report.saved.REFERER ?? 0) + day.rows.length;
    } catch (e) {
      if (!(e instanceof HttpStatusError) && !(e instanceof RefererParseError)) throw e;
      report.failures++;
      log('warn', '[경고] ' + d + ' 유입경로 수집 실패, 건너뜁니다: ' + e.message);
    }
  }

  // 2)·3) 지표
  const store = new SqlMetricStore(sql);
  const repaired = await store.repairMarkers();
  if (repaired > 0) log('info', '[정리] 시계열 지표에 잘못 남은 조회 불가 표시 ' + repaired + '행을 지웠습니다.');
  const job = new MetricJob(store, log);
  const plainSeries = (s: MetricSpec) => isSeries(s) && !s.perPost && !s.perHour;
  const seriesSpecs = ALL.filter(plainSeries);
  const firstTime = (await sql.query("SELECT 1 FROM metric_row WHERE metric = 'VIEWS' LIMIT 1")).length === 0;
  const plans: MetricPlan[] = [
    { specs: seriesSpecs, from: firstTime ? from : to, to, force: false, today },
    { specs: ALL.filter((s) => !plainSeries(s)), from, to, force: false, today },
  ];
  let pending = 0;
  for (const plan of plans) {
    const r = await job.execute(http, plan);
    for (const [k, v] of Object.entries(r.saved)) report.saved[k] = (report.saved[k] ?? 0) + v;
    report.failures += r.failures;
    pending += r.pending;
    if (r.budgetStopped) throw new BudgetExceededError('상한');
  }

  const failures = report.failures > 0 ? ' 실패 ' + report.failures + '건은 내일 다시 받습니다.' : '';
  if (pending > 0) {
    finish('partial', '네이버가 아직 집계하지 않은 값 ' + pending + '건은 다음 확인 때 다시 받습니다.' + failures);
    return;
  }
  await setSetting(sql, S.completeDate, today);
  finish('done', '어제(' + to + ')까지 받았습니다.' + failures);
}

/** 받은 응답 원문을 남기는 StatGetter(파서를 고친 뒤 다시 읽기용, 14일 보관). */
function recording(client: StatClient, sql: Sql): StatGetter {
  return {
    async get(path, params, label) {
      const body = await client.get(path, params, label);
      await sql.query('INSERT INTO raw_response (fetched_at, path, query, body) VALUES (?, ?, ?, ?)',
        [new Date().toISOString(), path, buildQuery(params), body]);
      return body;
    },
  };
}
