// SQLite 저장소. Java MetricService·ReferrerDailyService의 저장 규칙을 옮겼다.
// - 교체 저장(멱등): 그 지표의 해당 날짜(게시글별은 그 게시글 행)만 지우고 다시 넣는다.
// - 유입경로는 날짜 단위로 유입경로와 검색어(받았으면 상세 URL도)를 함께 교체하고, 오늘(집계 중) 데이터는 저장하지 않는다.
// - 상세 URL 보충(saveUrls)은 그 날짜의 URL 행만 교체하고 유입경로·검색어는 건드리지 않는다.
import type { MetricRow } from './metric-parser.js';
import type { MetricStore } from './metric-job.js';
import { mergeQueries, mergeUrls, type RefererDay, type RefererUrlRow } from './referer.js';
import { ALL, EMPTY_KEY, isSeries } from './specs.js';
import type { Sql, Stmt } from './sql.js';
import { UNAVAILABLE_PAYLOAD } from './metric-job.js';

const RANK_METRICS = ['RANK_POST', 'RANK_LIKE', 'RANK_COMMENT'];
const POST_URI = /"uri":"https?:\/\/blog\.naver\.com\/[^/"]+\/(\d+)"/;
export const REFERER_UNIT = 'REFERER';
/** 검색 아닌 유입처 상세 URL을 받은 날짜(유입분석 탭). 가져온 H2 데이터에는 없어 따로 보충한다. */
export const REFERER_URL_UNIT = 'REFERER_URL';

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export class SqlMetricStore implements MetricStore {
  constructor(private readonly sql: Sql, private readonly clock: () => string = () => new Date().toISOString()) {}

  async datesWith(metric: string, from: string, to: string): Promise<Set<string>> {
    const rows = await this.sql.query(
      'SELECT DISTINCT stat_date FROM metric_row WHERE metric = ? AND stat_date BETWEEN ? AND ?', [metric, from, to]);
    return new Set(rows.map((r) => String(r.stat_date)));
  }

  async keysWith(metric: string, date: string): Promise<Set<string>> {
    const rows = await this.sql.query('SELECT row_key FROM metric_row WHERE metric = ? AND stat_date = ?', [metric, date]);
    return new Set(rows.map((r) => String(r.row_key)));
  }

  /** 순위의 uri(예: http://blog.naver.com/아이디/224476308011) 마지막 마디가 게시글 번호다. */
  async postIds(from: string, to: string): Promise<string[]> {
    const rows = await this.sql.query(
      'SELECT payload FROM metric_row WHERE metric IN (' + placeholders(RANK_METRICS.length) + ') AND stat_date BETWEEN ? AND ?',
      [...RANK_METRICS, from, to]);
    const ids = new Set<string>();
    for (const r of rows) {
      const m = POST_URI.exec(String(r.payload ?? ''));
      if (m) ids.add(m[1]!);
    }
    return [...ids].sort();
  }

  async replace(metric: string, rows: MetricRow[], rowKey: string | null): Promise<number> {
    if (rows.length === 0) return 0;
    const dates = new Set<string>();
    for (const r of rows) {
      if (r.metric !== metric) throw new Error('다른 지표의 행이 섞여 있습니다: ' + r.metric + ' != ' + metric);
      dates.add(r.statDate);
    }
    const ds = [...dates];
    const stmts: Stmt[] = [rowKey === null
      ? { sql: 'DELETE FROM metric_row WHERE metric = ? AND stat_date IN (' + placeholders(ds.length) + ')', bind: [metric, ...ds] }
      : { sql: 'DELETE FROM metric_row WHERE metric = ? AND row_key = ? AND stat_date IN (' + placeholders(ds.length) + ')',
        bind: [metric, rowKey, ...ds] }];
    const now = this.clock();
    for (const r of rows) {
      stmts.push({
        sql: 'INSERT INTO metric_row (metric, stat_date, row_key, payload, collected_at) VALUES (?, ?, ?, ?, ?)',
        bind: [r.metric, r.statDate, r.rowKey, r.payload, now],
      });
    }
    await this.sql.tx(stmts);
    return rows.filter((r) => r.rowKey !== EMPTY_KEY).length;
  }

  async clear(metric: string, date: string): Promise<number> {
    return (await this.sql.query('DELETE FROM metric_row WHERE metric = ? AND stat_date = ? RETURNING 1', [metric, date])).length;
  }

  /**
   * 게시글별 시계열 지표에 잘못 남은 "조회 불가" 표시를 지운다(Java repairMarkers).
   * 표시는 정보 지표(ARTICLE_INFO)에만 남아야 한다. 시계열에 있으면 그 글이 조회수 0인 글로 보인다.
   */
  async repairMarkers(): Promise<number> {
    const ids = ALL.filter((s) => isSeries(s) && s.perPost).map((s) => s.id);
    return (await this.sql.query(
      'DELETE FROM metric_row WHERE metric IN (' + placeholders(ids.length) + ') AND payload = ? RETURNING 1',
      [...ids, UNAVAILABLE_PAYLOAD])).length;
  }
}

export class SqlRefererStore {
  constructor(private readonly sql: Sql, private readonly clock: () => string = () => new Date().toISOString()) {}

  /** 이미 받은 날짜. 수집 상태가 OK이거나(유입 0건인 날 포함) 유입경로 행이 있는 날(가져온 데이터). */
  async datesWith(from: string, to: string): Promise<Set<string>> {
    const rows = await this.sql.query(
      `SELECT stat_date FROM collection_state WHERE unit_key = ? AND status = 'OK' AND stat_date BETWEEN ? AND ?
       UNION SELECT DISTINCT stat_date FROM referrer_daily WHERE stat_date BETWEEN ? AND ?`,
      [REFERER_UNIT, from, to, from, to]);
    return new Set(rows.map((r) => String(r.stat_date)));
  }

  /** 그 날짜의 유입경로·검색어(받았으면 상세 URL도)를 지우고 다시 넣는다(한 트랜잭션). 오늘 데이터면 저장하지 않고 false. */
  async save(day: RefererDay): Promise<boolean> {
    if (day.today) return false;
    const now = this.clock();
    const stmts: Stmt[] = [
      { sql: 'DELETE FROM search_query_daily WHERE stat_date = ?', bind: [day.date] },
      { sql: 'DELETE FROM referrer_daily WHERE stat_date = ?', bind: [day.date] },
    ];
    for (const r of day.rows) {
      stmts.push({
        sql: 'INSERT INTO referrer_daily (stat_date, referrer_name, search_engine, visits, ratio, collected_at) VALUES (?, ?, ?, ?, ?, ?)',
        bind: [r.date, r.referrer, r.searchEngine ? 1 : 0, r.visits, r.ratio, now],
      });
    }
    for (const q of mergeQueries(day.queries)) {
      stmts.push({
        sql: 'INSERT INTO search_query_daily (stat_date, referrer_name, search_query, visits, ratio, collected_at) VALUES (?, ?, ?, ?, ?, ?)',
        bind: [q.date, q.referrer, q.query, q.visits, q.ratio, now],
      });
    }
    stmts.push({
      sql: `INSERT INTO collection_state (unit_key, stat_date, status, attempts, last_error, updated_at)
            VALUES (?, ?, 'OK', 1, NULL, ?)
            ON CONFLICT(unit_key, stat_date) DO UPDATE SET status = 'OK', attempts = attempts + 1, last_error = NULL,
              updated_at = excluded.updated_at`,
      bind: [REFERER_UNIT, day.date, now],
    });
    if (day.urls) stmts.push(...urlStmts(day.date, day.urls, now));
    await this.sql.tx(stmts);
    return true;
  }

  /** 상세 URL 보충: 그 날짜의 URL 행만 교체하고 받은 날로 기록한다. 유입경로·검색어 행은 그대로 둔다. */
  async saveUrls(date: string, urls: RefererUrlRow[]): Promise<void> {
    await this.sql.tx(urlStmts(date, urls, this.clock()));
  }

  /** 상세 URL을 받은 날짜. */
  async urlDatesWith(from: string, to: string): Promise<Set<string>> {
    const rows = await this.sql.query(
      "SELECT stat_date FROM collection_state WHERE unit_key = ? AND status = 'OK' AND stat_date BETWEEN ? AND ?",
      [REFERER_URL_UNIT, from, to]);
    return new Set(rows.map((r) => String(r.stat_date)));
  }
}

function urlStmts(date: string, urls: RefererUrlRow[], now: string): Stmt[] {
  const stmts: Stmt[] = [{ sql: 'DELETE FROM referrer_url_daily WHERE stat_date = ?', bind: [date] }];
  for (const u of mergeUrls(urls)) {
    if (u.date !== date) throw new Error('다른 날짜의 URL 행이 섞여 있습니다: ' + u.date + ' != ' + date);
    stmts.push({
      sql: 'INSERT INTO referrer_url_daily (stat_date, referrer_name, url, visits, ratio, collected_at) VALUES (?, ?, ?, ?, ?, ?)',
      bind: [u.date, u.referrer, u.url, u.visits, u.ratio, now],
    });
  }
  stmts.push({
    sql: `INSERT INTO collection_state (unit_key, stat_date, status, attempts, last_error, updated_at)
          VALUES (?, ?, 'OK', 1, NULL, ?)
          ON CONFLICT(unit_key, stat_date) DO UPDATE SET status = 'OK', attempts = attempts + 1, last_error = NULL,
            updated_at = excluded.updated_at`,
    bind: [REFERER_URL_UNIT, date, now],
  });
  return stmts;
}
