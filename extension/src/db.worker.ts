// SQLite(WASM) 워커. DB의 유일한 소유자이며 오프스크린 문서가 띄운다.
// OPFS SAH pool VFS를 써서 COOP/COEP 헤더 없이 브라우저 재시작 후에도 데이터가 남는다.
// 백업(파일 통째 내보내기)과 복원도 여기서 한다(복원은 검사 후 실패하면 원래 파일로 되돌린다).
/// <reference lib="webworker" />

type Row = Record<string, unknown>;
interface Stmt { sql: string; bind?: unknown[] }
interface Req { id: number; sql?: string; bind?: unknown[]; tx?: Stmt[]; op?: 'export' | 'import'; bytes?: Uint8Array }

const FILE = '/blogstat.sqlite3';
// 타입 해석을 피하려고 런타임 URL로 불러온다(파일은 빌드 때 vendor/sqlite로 복사됨).
const sqliteUrl = new URL('./vendor/sqlite/index.mjs', import.meta.url).href;

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any = null;
const ready = (async () => {
  const { default: sqlite3InitModule } = await import(sqliteUrl);
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'blogstat-pool' });
  db = open(pool);
  return { pool, version: sqlite3.version.libVersion as string };
})();

function open(pool: any): any {
  const d = new pool.OpfsSAHPoolDb(FILE);
  d.exec('PRAGMA foreign_keys = ON');
  return d;
}

/** 이 확장의 DB인지 확인한다(settings 표와 스키마 버전, 무결성). */
function check(d: any): void {
  const ok = d.selectValue('PRAGMA quick_check');
  if (ok !== 'ok') throw new Error('백업 파일이 손상됐습니다: ' + ok);
  const v = d.selectValue("SELECT value FROM settings WHERE key = 'schema_version'");
  if (v === undefined || v === null) throw new Error('이 확장의 백업 파일이 아닙니다.');
}

async function restore(pool: any, bytes: Uint8Array): Promise<void> {
  const before: Uint8Array = pool.exportFile(FILE);
  db.close();
  try {
    await pool.importDb(FILE, bytes);
    db = open(pool);
    check(db);
  } catch (e) {
    try { db?.close(); } catch { /* 이미 닫힘 */ }
    await pool.importDb(FILE, before);
    db = open(pool);
    throw e;
  }
}

// 메시지를 하나씩 끝까지 처리한다. 복원(비동기) 도중에 다른 질의가 닫힌 DB를 건드리지 않게 줄을 세운다.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent<Req>) => {
  queue = queue.then(() => handle(e.data));
};

async function handle(req: Req): Promise<void> {
  const { id, sql, bind, tx, op, bytes } = req;
  try {
    const { pool, version } = await ready;
    if (op === 'export') {
      const out: Uint8Array = pool.exportFile(FILE);
      self.postMessage({ id, rows: [], bytes: out }, [out.buffer]);
      return;
    }
    if (op === 'import') {
      await restore(pool, bytes!);
      self.postMessage({ id, rows: [] });
      return;
    }
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
}
