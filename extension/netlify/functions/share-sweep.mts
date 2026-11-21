// 매일 만료된 공유와 지난 날짜 카운터를 지운다(Netlify 예약 함수). 열람 때도 만료분은 지우지만, 아무도 열지 않은 공유를 남기지 않으려고.
import { sweepShares } from '../../src/core/share-api.ts';
import { blobStore, pruneCounters } from '../lib/blob-store.mts';

export default async (): Promise<void> => {
  const n = await sweepShares(blobStore());
  const c = await pruneCounters();
  console.log('만료된 공유 ' + n + '개, 지난 카운터 ' + c + '개를 지웠습니다.');
};

export const config = { schedule: '@daily' };
