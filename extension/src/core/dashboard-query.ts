// 대시보드 조회 계층. Java DashboardController·MetricController·KeywordTrendController가 주던 응답을
// 같은 모양으로 로컬 SQLite에서 만든다. 그래서 대시보드 화면(Java static/index.html)을 거의 그대로 쓴다.
// 읽기 전용이다.
import { addDays, isDate } from './dates.js';
import { computeTrends, historyFrom, WINDOW_DAYS, type TrendReport } from './keyword-trends.js';
import type { Sql } from './sql.js';
import type { StoredStatus } from './status.js';

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 366;
export const MAX_REFERRER_LIMIT = 50;
export const MAX_QUERY_LIMIT = 2000;
export const DEFAULT_LOOKBACK = 28;
export const MAX_LOOKBACK = 365;
export const MAX_TREND_LIMIT = 100;
const LATEST_ONLY = ['UPPER_GROUP', 'ARTICLE_INFO'];

export interface ApiResponse { status: number; body: unknown }
export class BadRequest extends Error {}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

function dateParam(p: Record<string, string>, name: string): string | null {
  const v = p[name];
  if (v === undefined || v === '') return null;
  if (!isDate(v)) throw new BadRequest(name + ' 날짜 형식이 아닙니다: ' + v);
  return v;
}

function intParam(p: Record<string, string>, name: string, def: number): number {
  const v = p[name];
  if (v === undefined || v === '') return def;
  if (!/^-?\d+$/.test(v)) throw new BadRequest(name + '은 정수여야 합니다: ' + v);
  return Number(v);
}

export class DashboardQuery {
  constructor(private readonly sql: Sql, private readonly today: () => string) {}

  /** /api/dashboard/<name>?params 를 처리한다. 잘못된 요청은 400과 message. */
  async handle(name: string, params: Record<string, string>, status: StoredStatus | null): Promise<ApiResponse> {
    try {
      switch (name) {
        case 'summary': return ok(await this.summary(await this.period(params)));
        case 'daily': return ok(await this.daily(await this.period(params)));
        case 'referrers': return ok(await this.referrers(await this.period(params), intParam(params, 'limit', 10)));
        case 'queries': return ok(await this.queries(await this.period(params), intParam(params, 'limit', 500)));
        case 'keyword-trends': return ok(await this.trends(dateParam(params, 'to'),
          intParam(params, 'lookback', DEFAULT_LOOKBACK), intParam(params, 'limit', 20)));
        case 'metrics': return ok(await this.metrics(dateParam(params, 'from'), dateParam(params, 'to')));
        case 'session': return ok(session(status));
        default: return { status: 404, body: { status: 404, message: '없는 API: ' + name } };
      }
    } catch (e) {
      if (e instanceof BadRequest) return { status: 400, body: { status: 400, message: e.message } };
      throw e;
    }
  }

  // ---- 유입경로·검색어 (DashboardService) ----

  private async latestReferrer(): Promise<string | null> {
    const v = (await this.sql.query('SELECT MAX(stat_date) AS d FROM referrer_daily'))[0]?.d;
    return v === null || v === undefined ? null : String(v);
  }

  async period(p: Record<string, string>): Promise<{ from: string; to: string }> {
    const from = dateParam(p, 'from');
    const to = dateParam(p, 'to') ?? (await this.latestReferrer()) ?? addDays(this.today(), -1);
    const start = from ?? addDays(to, -(DEFAULT_DAYS - 1));
    if (start > to) throw new BadRequest('from이 to보다 늦습니다: ' + start + ' > ' + to);
    if (daysBetween(start, to) + 1 > MAX_DAYS) throw new BadRequest('조회 기간은 최대 ' + MAX_DAYS + '일입니다.');
    return { from: start, to };
  }

  private async dailyTotals(from: string, to: string) {
    const rows = await this.sql.query(
      `SELECT stat_date, SUM(visits) AS visits, SUM(CASE WHEN search_engine = 1 THEN visits ELSE 0 END) AS search
       FROM referrer_daily WHERE stat_date BETWEEN ? AND ? GROUP BY stat_date ORDER BY stat_date`, [from, to]);
    return rows.map((r) => ({ date: String(r.stat_date), visits: Number(r.visits), search: Number(r.search) }));
  }

  async summary(period: { from: string; to: string }) {
    const totals = await this.dailyTotals(period.from, period.to);
    const visits = totals.reduce((a, t) => a + t.visits, 0);
    const search = totals.reduce((a, t) => a + t.search, 0);
    return {
      from: period.from, to: period.to, totalVisits: visits, searchVisits: search,
      searchRatio: visits === 0 ? 0 : (search * 100) / visits,
      collectedDays: totals.length, totalDays: daysBetween(period.from, period.to) + 1,
      latestDate: await this.latestReferrer(),
    };
  }

  async daily(period: { from: string; to: string }) {
    const byDate = new Map((await this.dailyTotals(period.from, period.to)).map((t) => [t.date, t]));
    const out: { date: string; visits: number | null; searchVisits: number | null }[] = [];
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) {
      const t = byDate.get(d);
      out.push({ date: d, visits: t ? t.visits : null, searchVisits: t ? t.search : null });
    }
    return out;
  }

  async referrers(period: { from: string; to: string }, limit: number) {
    const size = Math.max(1, Math.min(limit, MAX_REFERRER_LIMIT));
    const total = (await this.summary(period)).totalVisits;
    const rows = await this.sql.query(
      `SELECT referrer_name, search_engine, SUM(visits) AS visits FROM referrer_daily
       WHERE stat_date BETWEEN ? AND ? GROUP BY referrer_name, search_engine
       ORDER BY SUM(visits) DESC, referrer_name LIMIT ?`, [period.from, period.to, size]);
    return rows.map((r) => ({
      name: String(r.referrer_name), searchEngine: Number(r.search_engine) === 1, visits: Number(r.visits),
      ratio: total === 0 ? 0 : (Number(r.visits) * 100) / total,
    }));
  }

  async queries(period: { from: string; to: string }, limit: number) {
    const size = Math.max(1, Math.min(limit, MAX_QUERY_LIMIT));
    const rows = await this.sql.query(
      'SELECT stat_date, referrer_name, search_query, visits FROM search_query_daily WHERE stat_date BETWEEN ? AND ?',
      [period.from, period.to]);
    const by = new Map<string, { visits: number; dates: Set<string>; sources: Map<string, number> }>();
    for (const r of rows) {
      const q = String(r.search_query);
      let a = by.get(q);
      if (!a) by.set(q, (a = { visits: 0, dates: new Set(), sources: new Map() }));
      const v = Number(r.visits);
      a.visits += v;
      a.dates.add(String(r.stat_date));
      const src = String(r.referrer_name);
      a.sources.set(src, (a.sources.get(src) ?? 0) + v);
    }
    const total = [...by.values()].reduce((s, a) => s + a.visits, 0);
    const sorted = [...by.entries()]
      .sort(([qa, a], [qb, b]) => b.visits - a.visits || cmp(qa, qb))
      .map(([query, a]) => ({
        query, visits: a.visits, days: a.dates.size,
        sources: [...a.sources.entries()].sort(([na, va], [nb, vb]) => vb - va || cmp(na, nb)).map(([n]) => n),
        dates: [...a.dates].sort(),
      }));
    return {
      from: period.from, to: period.to, distinctQueries: sorted.length, totalVisits: total,
      truncated: sorted.length > size, items: sorted.slice(0, size),
    };
  }

  // ---- 검색어 변화 (KeywordTrendController) ----

  async trends(to: string | null, lookback: number, limit: number): Promise<TrendReport> {
    if (lookback < WINDOW_DAYS || lookback > MAX_LOOKBACK) {
      throw new BadRequest('lookback은 ' + WINDOW_DAYS + '~' + MAX_LOOKBACK + '일이어야 합니다.');
    }
    if (limit < 1 || limit > MAX_TREND_LIMIT) throw new BadRequest('limit은 1~' + MAX_TREND_LIMIT + '이어야 합니다.');
    const latest = (await this.sql.query('SELECT MAX(stat_date) AS d FROM search_query_daily'))[0]?.d;
    const anchor = to ?? (latest === null || latest === undefined ? null : String(latest));
    if (anchor === null) return computeTrends([], this.today(), lookback, limit);
    const rows = await this.sql.query(
      'SELECT stat_date, search_query, visits FROM search_query_daily WHERE stat_date BETWEEN ? AND ?',
      [historyFrom(anchor, lookback), anchor]);
    return computeTrends(rows.map((r) => ({ date: String(r.stat_date), query: String(r.search_query), visits: Number(r.visits) })),
      anchor, lookback, limit);
  }

  // ---- 블로그 지표 (MetricQueryService) ----

  async metrics(from: string | null, to: string | null) {
    const latestV = (await this.sql.query('SELECT MAX(stat_date) AS d FROM metric_row'))[0]?.d;
    if (latestV === null || latestV === undefined) {
      return { ready: false, from: null, to: null, latest: null, coverage: [], items: [] };
    }
    const latest = String(latestV);
    const end = to ?? latest;
    const start = from ?? addDays(end, -(DEFAULT_DAYS - 1));
    if (start > end) throw new BadRequest('from이 to보다 늦습니다: ' + start + ' > ' + end);
    if (addDays(start, MAX_DAYS) < end) throw new BadRequest('기간은 최대 ' + MAX_DAYS + '일까지 조회할 수 있습니다.');

    const item = (r: Record<string, unknown>) => ({
      date: String(r.stat_date), metric: String(r.metric), key: String(r.row_key), values: JSON.parse(String(r.payload)),
    });
    const items = (await this.sql.query(
      `SELECT stat_date, metric, row_key, payload FROM metric_row
       WHERE stat_date BETWEEN ? AND ? AND row_key <> '_empty' ORDER BY stat_date, metric, rowid`, [start, end])).map(item);
    // 월·게시글 단위 값은 조회 기간 안에 날짜가 없을 수 있어서 최신값을 항상 함께 보낸다.
    for (const metric of LATEST_ONLY) {
      const rows = await this.sql.query(
        `SELECT stat_date, metric, row_key, payload FROM metric_row
         WHERE metric = ? AND stat_date = (SELECT MAX(stat_date) FROM metric_row WHERE metric = ?) ORDER BY rowid`,
        [metric, metric]);
      for (const r of rows) {
        const d = String(r.stat_date);
        if (d < start || d > end) items.push(item(r));
      }
    }
    const coverage = (await this.sql.query(
      `SELECT metric, COUNT(*) AS n, MIN(stat_date) AS f, MAX(stat_date) AS l FROM metric_row
       WHERE row_key <> '_empty' GROUP BY metric ORDER BY metric`)).map((r) => ({
      metric: String(r.metric), rows: Number(r.n), firstDate: String(r.f), lastDate: String(r.l),
    }));
    return { ready: true, from: start, to: end, latest, coverage, items };
  }
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body });

/** Java의 로그인 쿠키 만료 배너 자리에 확장의 수집 상태를 넣는다(state OK/WARN/EXPIRED). */
function session(status: StoredStatus | null) {
  const outcome = status?.lastRun?.outcome ?? null;
  const message = status?.lastRun?.message ?? '';
  if (outcome === 'login-required' || outcome === 'login-backoff') {
    return { state: 'EXPIRED', daysLeft: null, expiresAt: null, message: '네이버 로그인이 필요합니다. 로그인하면 30분 안에 이어서 수집합니다.' };
  }
  if (outcome === 'other-account') {
    return { state: 'EXPIRED', daysLeft: null, expiresAt: null, message: '처음 수집한 블로그와 다른 계정으로 로그인돼 있어 수집하지 않습니다.' };
  }
  if (outcome === 'error') {
    return { state: 'WARN', daysLeft: null, expiresAt: null, message: '마지막 수집에 문제가 있었습니다: ' + message };
  }
  return { state: 'OK', daysLeft: null, expiresAt: null, message };
}
