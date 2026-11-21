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
    // 워커 로드·초기화 실패 시 기다리는 질의를 모두 실패로 끝낸다(팝업이 '실행 중'에 멈추지 않게).
    this.worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      const err = new Error('DB 워커 오류: ' + (e.message || '로드 실패'));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
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
