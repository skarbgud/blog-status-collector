// 여러 작업을 동시에 돌리는 도우미. 실제 동시 요청 수 상한은 StatClient가 쥐고 있으므로 여기 limit은 넉넉히 둬도 된다.
// worker가 던진 오류는 치명 오류로 본다(항목별 실패는 worker 안에서 처리한다). 치명 오류가 나면 새 항목을 시작하지 않고,
// 이미 시작한 항목이 끝나기를 기다린 뒤 첫 오류를 던진다(진행 중인 저장이 중간에 끊기지 않게).

/** 기본 동시 작업 수. StatClient 기본 동시 요청 수(6)와 맞췄다. */
export const POOL_LIMIT = 6;

export async function runPool<T>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const lane = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const i = next++;
      try {
        await worker(items[i]!, i);
      } catch (e) {
        if (failure === null) failure = { error: e };
      }
    }
  };
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
  if (failure !== null) throw (failure as { error: unknown }).error;
}
