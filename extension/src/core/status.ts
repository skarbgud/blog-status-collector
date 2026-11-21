// 팝업에 보여 줄 상태 요약. 값은 집계·날짜만 담고 개인 통계 원문은 담지 않는다.
import { DEFAULT_DAILY_CAP, S } from './collector.js';
import { getSetting, type Sql } from './sql.js';

export interface LastRun {
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  requests: number;
  outcome: string | null;
  message: string | null;
}

export interface StoredStatus {
  blogId: string | null;
  otherAccountSeenAt: string | null;
  dailyCap: number;
  todayRequests: number;
  lastRun: LastRun | null;
  referrerDays: number;
  referrerFirst: string | null;
  referrerLast: string | null;
  metricRows: number;
  metricLast: string | null;
}

export async function readStatus(sql: Sql, today: string): Promise<StoredStatus> {
  const one = async (q: string, bind: unknown[] = []) => (await sql.query(q, bind))[0] ?? {};
  const run = await one(`SELECT trigger, started_at, finished_at, requests, outcome, message FROM run_log
                         WHERE outcome IS NOT NULL ORDER BY id DESC LIMIT 1`);
  const ref = await one('SELECT COUNT(DISTINCT stat_date) AS n, MIN(stat_date) AS f, MAX(stat_date) AS l FROM referrer_daily');
  const met = await one("SELECT COUNT(*) AS n, MAX(stat_date) AS l FROM metric_row WHERE row_key <> '_empty'");
  const used = await one('SELECT COALESCE(SUM(requests), 0) AS n FROM run_log WHERE kst_date = ?', [today]);
  const str = (v: unknown) => (v === undefined || v === null ? null : String(v));
  return {
    blogId: await getSetting(sql, S.blogId),
    otherAccountSeenAt: await getSetting(sql, S.otherAccount),
    dailyCap: Number((await getSetting(sql, S.dailyCap)) ?? DEFAULT_DAILY_CAP),
    todayRequests: Number(used.n ?? 0),
    lastRun: run.started_at === undefined ? null : {
      trigger: String(run.trigger), startedAt: String(run.started_at), finishedAt: str(run.finished_at),
      requests: Number(run.requests ?? 0), outcome: str(run.outcome), message: str(run.message),
    },
    referrerDays: Number(ref.n ?? 0),
    referrerFirst: str(ref.f),
    referrerLast: str(ref.l),
    metricRows: Number(met.n ?? 0),
    metricLast: str(met.l),
  };
}
