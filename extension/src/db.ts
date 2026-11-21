// 오프스크린 문서에서 DB 워커를 부르는 얇은 클라이언트. 워커는 메시지를 하나씩 순서대로 처리한다.
import type { Row, Sql, Stmt } from './core/sql.js';

interface Reply { id: number; rows?: Row[]; bytes?: Uint8Array; error?: string }

export class Db implements Sql {
  private readonly worker = new Worker(new URL('./db.worker.js', import.meta.url), { type: 'module' });
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
    // 워커 로드·초기화 실패 시 기다리는 질의를 모두 실패로 끝낸다(팝업이 '실행 중'에 멈추지 않게).
    this.worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      const err = new Error('DB 워커 오류: ' + (e.message || '로드 실패'));
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  async query(sql: string, bind?: unknown[]): Promise<Row[]> {
    return (await this.send({ sql, bind })).rows ?? [];
  }

  async tx(stmts: Stmt[]): Promise<void> {
    await this.send({ tx: stmts });
  }

  /** DB 파일 전체(백업). */
  async exportFile(): Promise<Uint8Array> {
    return (await this.send({ op: 'export' })).bytes!;
  }

  /** 백업 파일로 바꾼다. 이 확장의 DB가 아니거나 손상됐으면 원래대로 두고 실패한다. */
  async importFile(bytes: Uint8Array): Promise<void> {
    await this.send({ op: 'import', bytes }, [bytes.buffer as ArrayBuffer]);
  }

  private send(msg: object, transfer: Transferable[] = []): Promise<Reply> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...msg }, transfer);
    });
  }
}
