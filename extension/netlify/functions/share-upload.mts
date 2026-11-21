// 짧은 공유 링크 업로드(POST /api/share). 인증 없이 누구나 올릴 수 있어 남용을 막는다:
// IP당 3분에 5회(아래 rateLimit, Netlify 무료 요금제에서도 코드 설정으로 지원. 창은 최대 180초),
// 하루 전체 500건·1MB·30일(src/core/share-api.ts), 긴급 정지 SHARE_UPLOADS=off.
// 확장은 Content-Type 없이 보내 미리 확인 요청(OPTIONS)이 생기지 않게 한다(그것도 5회에 세지 않도록).
import { handleShare } from '../../src/core/share-api.ts';
import { blobStore, shareEnv } from '../lib/blob-store.mts';

export default async (req: Request): Promise<Response> => handleShare(req, blobStore(), shareEnv());

export const config = {
  path: '/api/share',
  rateLimit: { windowLimit: 5, windowSize: 180, aggregateBy: ['ip', 'domain'] },
};
