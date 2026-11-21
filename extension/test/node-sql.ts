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
