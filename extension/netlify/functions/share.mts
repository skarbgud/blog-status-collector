// 짧은 공유 링크 API(Netlify Function). 처리 규칙은 src/core/share-api.ts(테스트 있음)에 있고, 여기서는 저장소만 잇는다.
// 저장되는 것은 브라우저에서 암호화한 암호문과 만료 시각·삭제 토큰 해시뿐이다.
import { handleShare } from '../../src/core/share-api.ts';
import { blobStore, writeToken } from '../lib/blob-store.mts';

export default async (req: Request): Promise<Response> => handleShare(req, blobStore(), { token: writeToken() });

export const config = { path: ['/api/share', '/api/share/*'] };
