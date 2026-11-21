// SQL 실행 창구. 런타임은 오프스크린의 DB 워커(OPFS), 테스트는 Node의 인메모리 sqlite-wasm을 쓴다.

export type Row = Record<string, unknown>;
export interface Stmt { sql: string; bind?: unknown[] }

export interface Sql {
  query(sql: string, bind?: unknown[]): Promise<Row[]>;
  /** 여러 문장을 한 트랜잭션으로 실행한다. 하나라도 실패하면 모두 되돌린다. */
  tx(stmts: Stmt[]): Promise<void>;
}

export async function getSetting(sql: Sql, key: string): Promise<string | null> {
  const v = (await sql.query('SELECT value FROM settings WHERE key = ?', [key]))[0]?.value;
  return v === undefined || v === null ? null : String(v);
}

export function setSettingStmt(key: string, value: string): Stmt {
  return {
    sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    bind: [key, value],
  };
}

export async function setSetting(sql: Sql, key: string, value: string): Promise<void> {
  const s = setSettingStmt(key, value);
  await sql.query(s.sql, s.bind);
}

export async function deleteSetting(sql: Sql, key: string): Promise<void> {
  await sql.query('DELETE FROM settings WHERE key = ?', [key]);
}
