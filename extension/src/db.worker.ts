// SQLite(WASM) 워커. DB의 유일한 소유자이며 오프스크린 문서가 띄운다.
// OPFS SAH pool VFS를 써서 COOP/COEP 헤더 없이 브라우저 재시작 후에도 데이터가 남는다.
/// <reference lib="webworker" />

type Row = Record<string, unknown>;
interface Stmt { sql: string; bind?: unknown[] }
interface Req { id: number; sql?: string; bind?: unknown[]; tx?: Stmt[] }

// 타입 해석을 피하려고 런타임 URL로 불러온다(파일은 빌드 때 vendor/sqlite로 복사됨).
const sqliteUrl = new URL('./vendor/sqlite/index.mjs', import.meta.url).href;

const ready = (async () => {
  const { default: sqlite3InitModule } = await import(sqliteUrl);
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'blogstat-pool' });
  const db = new pool.OpfsSAHPoolDb('/blogstat.sqlite3');
  db.exec('PRAGMA foreign_keys = ON');
  return { db, version: sqlite3.version.libVersion as string };
})();

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, sql, bind, tx } = e.data;
  try {
    const { db, version } = await ready;
    if (tx) {
      db.transaction(() => {
        for (const s of tx) db.exec({ sql: s.sql, bind: s.bind });
      });
      self.postMessage({ id, rows: [] });
      return;
    }
    if (sql === '__version__') {
      self.postMessage({ id, rows: [{ version }] });
      return;
    }
    const rows: Row[] = [];
    db.exec({ sql, bind, rowMode: 'object', resultRows: rows });
    self.postMessage({ id, rows });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
