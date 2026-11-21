// 짧은 공유 링크 열람·삭제(GET·DELETE /api/share/<번호>). 처리 규칙은 src/core/share-api.ts(테스트 있음).
// 링크를 여는 사람을 막지 않도록 IP당 제한은 넉넉하게(1분에 60회) 두고, 업로드 제한은 share-upload에만 건다.
import { handleShare } from '../../src/core/share-api.ts';
import { blobStore, shareEnv } from '../lib/blob-store.mts';

export default async (req: Request): Promise<Response> => handleShare(req, blobStore(), shareEnv());

export const config = {
  path: '/api/share/*',
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
