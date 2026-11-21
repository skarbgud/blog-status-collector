// 오프스크린 문서에서 DB 워커를 부르는 얇은 클라이언트.

type Row = Record<string, unknown>;

export class Db {
  private readonly worker = new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' });
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (r: Row[]) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<{ id: number; rows?: Row[]; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.rows ?? []);
    };
  }

  query(sql: string, bind?: unknown[]): Promise<Row[]> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, sql, bind });
    });
  }
}
