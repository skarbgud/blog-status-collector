// Netlify Blobs를 ShareStore 모양으로. 함수 폴더 밖에 둔다(함수 폴더의 파일은 모두 함수가 된다).
// - "blog-shares": 공유 암호문(키 = 공유 번호), 메타데이터 = 만료 시각·삭제 토큰 해시
// - "blog-share-counters": 날짜별 업로드 수(하루 상한용, 키 = YYYY-MM-DD)
import { getStore } from '@netlify/blobs';
import type { ShareEnv, ShareMeta, ShareStore } from '../../src/core/share-api.ts';

const counters = () => getStore({ name: 'blog-share-counters', consistency: 'strong' });

export function blobStore(): ShareStore {
  const store = getStore({ name: 'blog-shares', consistency: 'strong' });
  return {
    async get(id) {
      const r = await store.getWithMetadata(id, { type: 'arrayBuffer' });
      return r ? { data: r.data, meta: r.metadata as unknown as ShareMeta } : null;
    },
    async meta(id) {
      const r = await store.getMetadata(id);
      return r ? (r.metadata as unknown as ShareMeta) : null;
    },
    async set(id, data, meta) {
      await store.set(id, data, { metadata: { ...meta } });
    },
    async delete(id) {
      await store.delete(id);
    },
    async list() {
      const { blobs } = await store.list();
      return blobs.map((b) => b.key);
    },
    async bumpDaily(day) {
      const c = counters();
      const n = Number((await c.get(day, { type: 'text' })) ?? '0') + 1;
      await c.set(day, String(n));
      return n;
    },
  };
}

/** 7일 넘은 날짜 카운터를 지운다(예약 정리에서). */
export async function pruneCounters(now = new Date()): Promise<number> {
  const c = counters();
  const keep = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const { blobs } = await c.list();
  let n = 0;
  for (const b of blobs) {
    if (b.key < keep) {
      await c.delete(b.key);
      n++;
    }
  }
  return n;
}

/** 사이트 환경변수(Netlify 설정 → Environment variables). SHARE_UPLOADS=off면 업로드 긴급 정지. */
export function shareEnv(): ShareEnv {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const netlify = (globalThis as any).Netlify;
  const get = (k: string): string | undefined => netlify?.env?.get?.(k) ?? process.env[k];
  const cap = Number(get('SHARE_DAILY_CAP'));
  return { uploads: get('SHARE_UPLOADS'), dailyCap: Number.isInteger(cap) && cap > 0 ? cap : undefined };
}
