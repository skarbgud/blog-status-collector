// 옵션 페이지: 백업 내보내기·복원, Java 데이터 가져오기, 하루 요청 상한. 결과는 textContent로만 넣는다.
import { fromBase64, toBase64 } from './core/base64.js';
import type { ImportResult } from './core/importer.js';
import type { RefetchEstimate } from './offscreen.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function call<T>(msg: object): Promise<T> {
  const ready = (await chrome.runtime.sendMessage({ target: 'background', type: 'ensure-offscreen' })) as { ok: boolean; error?: string };
  if (!ready?.ok) throw new Error(ready?.error ?? '준비 실패');
  const r = (await chrome.runtime.sendMessage({ target: 'offscreen', ...msg })) as (T & { error?: string }) | undefined;
  if (!r) throw new Error('응답이 없습니다');
  if (r.error) throw new Error(r.error);
  return r;
}

function show(id: string, text: string, ok: boolean): void {
  const el = $(id);
  el.textContent = text;
  el.className = 'result ' + (ok ? 'ok' : 'bad');
}

async function busy(el: HTMLElement, work: () => Promise<void>): Promise<void> {
  el.setAttribute('disabled', '');
  el.classList.add('disabled');
  try {
    await work();
  } finally {
    el.removeAttribute('disabled');
    el.classList.remove('disabled');
  }
}

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

$('export').addEventListener('click', () => busy($('export'), async () => {
  try {
    const { base64 } = await call<{ base64: string }>({ type: 'export-db' });
    const bytes = fromBase64(base64);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'blogstat-backup-' + stamp() + '.sqlite';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    show('export-out', '받았습니다 (' + (bytes.length / 1024).toFixed(0) + ' KB).', true);
  } catch (e) {
    show('export-out', '실패: ' + (e as Error).message, false);
  }
}));

$<HTMLInputElement>('restore').addEventListener('change', (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!confirm('지금 데이터를 "' + file.name + '"의 내용으로 바꿉니다. 먼저 백업을 받아 두셨나요?')) return;
  void busy($('restore-label'), async () => {
    try {
      const base64 = toBase64(new Uint8Array(await file.arrayBuffer()));
      const r = await call<{ stored: { referrerDays: number; metricRows: number } }>({ type: 'import-db', base64 });
      show('restore-out', '복원했습니다. 유입경로 ' + r.stored.referrerDays + '일, 지표 ' + r.stored.metricRows.toLocaleString('ko-KR') + '행.', true);
    } catch (e) {
      show('restore-out', '복원하지 않았습니다: ' + (e as Error).message, false);
    }
  });
});

$<HTMLInputElement>('json').addEventListener('change', (ev) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  void busy($('json-label'), async () => {
    try {
      const data: unknown = JSON.parse(await file.text());
      const { result: r } = await call<{ result: ImportResult }>({ type: 'import-json', data });
      show('json-out', '가져왔습니다. 유입경로 ' + r.referrerDays + '일(' + r.referrerRows + '행), 검색어 ' + r.queryRows + '행, 지표 '
        + r.metricRows.toLocaleString('ko-KR') + '행. 이미 있어서 건너뜀: 유입경로 ' + r.skippedReferrerDays + '일, 지표 '
        + r.skippedMetricGroups + '건.', true);
    } catch (e) {
      show('json-out', '가져오지 못했습니다: ' + (e as Error).message, false);
    }
  });
});

$('save-cap').addEventListener('click', () => busy($('save-cap'), async () => {
  try {
    const r = await call<{ dailyCap: number }>({ type: 'set-settings', cap: Number($<HTMLInputElement>('cap').value) });
    show('cap-out', '저장했습니다: ' + (r.dailyCap > 0 ? '하루 ' + r.dailyCap + '회' : '상한 없음'), true);
  } catch (e) {
    show('cap-out', '저장하지 못했습니다: ' + (e as Error).message, false);
  }
}));

call<{ dailyCap: number }>({ type: 'get-settings' })
  .then((r) => { $<HTMLInputElement>('cap').value = String(r.dailyCap); })
  .catch((e) => show('cap-out', '설정을 읽지 못했습니다: ' + (e as Error).message, false));

// 최근 7일 다시 받기: 누르기 전에 예상 요청 수와 남은 상한을 보여 준다(요청은 보내지 않음).
const REFETCH_DAYS = 7;
async function refetchPlan(): Promise<void> {
  try {
    const e = await call<RefetchEstimate>({ type: 'estimate-refetch', days: REFETCH_DAYS });
    $('refetch7-plan').textContent = '약 ' + e.estimate + '회'
      + (e.unlimited ? '' : ' / 오늘 남은 상한 ' + e.remaining + '회' + (e.remaining < e.estimate ? ' (상한이 부족해 나눠 받습니다)' : ''));
  } catch (err) {
    $('refetch7-plan').textContent = '예상 요청 수를 계산하지 못했습니다: ' + (err as Error).message;
  }
}
$('refetch7').addEventListener('click', () => busy($('refetch7'), async () => {
  try {
    const r = (await chrome.runtime.sendMessage({ target: 'background', type: 'collect-now', days: REFETCH_DAYS })) as
      { ok: boolean; reason?: string; error?: string };
    if (!r.ok) {
      throw new Error(r.error ?? (r.reason === 'busy' ? '수집이 이미 돌고 있습니다. 끝난 뒤 다시 누르세요.'
        : r.reason === 'maintenance' ? '복원·가져오기가 진행 중입니다.' : (r.reason ?? '알 수 없음')));
    }
    show('refetch7-out', '시작했습니다. 진행 상황과 결과는 팝업에서 볼 수 있습니다.', true);
  } catch (e) {
    show('refetch7-out', '시작하지 못했습니다: ' + (e as Error).message, false);
  }
}));
void refetchPlan();
