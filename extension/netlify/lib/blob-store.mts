// Netlify Blobs "blog-shares"를 ShareStore 모양으로. 함수 폴더 밖에 둔다(함수 폴더의 파일은 모두 함수가 된다).
import { getStore } from '@netlify/blobs';
import type { ShareMeta, ShareStore } from '../../src/core/share-api.ts';

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
  };
}

/** 사이트 환경변수 SHARE_WRITE_TOKEN(Netlify 설정 → Environment variables). */
export function writeToken(): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const netlify = (globalThis as any).Netlify;
  return netlify?.env?.get?.('SHARE_WRITE_TOKEN') ?? process.env.SHARE_WRITE_TOKEN;
}
