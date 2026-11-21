// 테스트용 Sql: Node에서 sqlite-wasm 인메모리 DB를 쓴다(런타임과 같은 SQLite 엔진).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Row, Sql, Stmt } from '../src/core/sql.js';
import { migrate } from '../src/core/schema.js';

let sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>> | null = null;

export class NodeSql implements Sql {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any) {}

  async query(sql: string, bind?: unknown[]): Promise<Row[]> {
    const rows: Row[] = [];
    this.db.exec({ sql, bind, rowMode: 'object', resultRows: rows });
    return rows;
  }

  async tx(stmts: Stmt[]): Promise<void> {
    this.db.transaction(() => {
      for (const s of stmts) this.db.exec({ sql: s.sql, bind: s.bind });
    });
  }
}

export async function memoryDb(): Promise<NodeSql> {
  sqlite3 ??= await sqlite3InitModule();
  const sql = new NodeSql(new sqlite3.oo1.DB(':memory:'));
  await migrate(sql);
  return sql;
}

let fileSeq = 0;

/** SQLite 파일 바이트(확장 백업)를 wasm 메모리 파일시스템에 올려 연다. */
export async function openSqliteFile(bytes: Uint8Array): Promise<NodeSql> {
  sqlite3 ??= await sqlite3InitModule();
  const name = '/backup-' + ++fileSeq + '.sqlite3';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sqlite3.capi as any).sqlite3_js_posix_create_file(name, bytes);
  return new NodeSql(new sqlite3.oo1.DB(name, 'r'));
}

/** 인메모리 DB를 파일 바이트로(백업 파일 흉내). */
export function exportBytes(sql: NodeSql): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sqlite3!.capi as any).sqlite3_js_db_export((sql as any).db);
}
