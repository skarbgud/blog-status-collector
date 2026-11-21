// SQLite 스키마. 개인이 자기 블로그 하나만 쓰므로(local-first) blog_id 컬럼은 두지 않고 settings에 블로그 ID를 묶는다.
// 버전은 settings.schema_version으로 관리하고, 올릴 때는 MIGRATIONS 끝에 단계를 추가한다(기존 단계는 고치지 않는다).
import { getSetting, setSettingStmt, type Sql, type Stmt } from './sql.js';

const V1: string[] = [
  // 단위별 수집 상태. 지금은 유입경로(REFERER) 날짜를 기록한다(유입이 0건인 날도 다시 부르지 않도록).
  `CREATE TABLE collection_state (
     unit_key TEXT NOT NULL, stat_date TEXT NOT NULL, status TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL,
     PRIMARY KEY (unit_key, stat_date))`,
  `CREATE TABLE referrer_daily (
     stat_date TEXT NOT NULL, referrer_name TEXT NOT NULL, search_engine INTEGER NOT NULL,
     visits INTEGER NOT NULL, ratio REAL NOT NULL, collected_at TEXT NOT NULL,
     PRIMARY KEY (stat_date, referrer_name))`,
  `CREATE TABLE search_query_daily (
     stat_date TEXT NOT NULL, referrer_name TEXT NOT NULL, search_query TEXT NOT NULL,
     visits INTEGER NOT NULL, ratio REAL NOT NULL, collected_at TEXT NOT NULL,
     PRIMARY KEY (stat_date, referrer_name, search_query))`,
  `CREATE TABLE metric_row (
     metric TEXT NOT NULL, stat_date TEXT NOT NULL, row_key TEXT NOT NULL,
     payload TEXT, collected_at TEXT NOT NULL,
     PRIMARY KEY (metric, stat_date, row_key))`,
  'CREATE INDEX metric_row_date ON metric_row (stat_date)',
  // 파서를 고쳤을 때 다시 요청하지 않고 다시 읽기 위한 원문(최근 14일). user-info 응답은 넣지 않는다.
  `CREATE TABLE raw_response (
     id INTEGER PRIMARY KEY AUTOINCREMENT, fetched_at TEXT NOT NULL,
     path TEXT NOT NULL, query TEXT NOT NULL, body TEXT NOT NULL)`,
  'CREATE INDEX raw_response_time ON raw_response (fetched_at)',
  `CREATE TABLE run_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, kst_date TEXT NOT NULL, trigger TEXT NOT NULL,
     started_at TEXT NOT NULL, finished_at TEXT, requests INTEGER NOT NULL DEFAULT 0,
     outcome TEXT, message TEXT)`,
  'CREATE INDEX run_log_date ON run_log (kst_date)',
  'DROP TABLE IF EXISTS poc_run',
];

// V2: 검색 아닌 유입처의 상세 URL(유입분석 탭). url은 원문 그대로 저장한다(표시할 때만 디코딩).
const V2: string[] = [
  `CREATE TABLE referrer_url_daily (
     stat_date TEXT NOT NULL, referrer_name TEXT NOT NULL, url TEXT NOT NULL,
     visits INTEGER NOT NULL, ratio REAL NOT NULL, collected_at TEXT NOT NULL,
     PRIMARY KEY (stat_date, referrer_name, url))`,
];

const MIGRATIONS: string[][] = [V1, V2];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** 스키마를 최신으로 올린다. 단계마다 한 트랜잭션이라 중간에 실패해도 반쯤 만든 표가 남지 않는다. */
export async function migrate(sql: Sql): Promise<void> {
  await sql.query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const current = Number((await getSetting(sql, 'schema_version')) ?? 0);
  if (current > SCHEMA_VERSION) {
    throw new Error('DB 스키마(' + current + ')가 이 확장 버전(' + SCHEMA_VERSION + ')보다 새롭습니다. 확장을 업데이트하세요.');
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const stmts: Stmt[] = MIGRATIONS[v]!.map((s) => ({ sql: s }));
    stmts.push(setSettingStmt('schema_version', String(v + 1)));
    await sql.tx(stmts);
  }
}
