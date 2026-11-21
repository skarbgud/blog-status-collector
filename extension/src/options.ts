// 옵션 페이지: 백업 내보내기·복원, Java 데이터 가져오기, 하루 요청 상한. 결과는 textContent로만 넣는다.
import { fromBase64, toBase64 } from './core/base64.js';
import type { ImportResult } from './core/importer.js';

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
    show('cap-out', '저장했습니다: 하루 ' + r.dailyCap + '회', true);
  } catch (e) {
    show('cap-out', '저장하지 못했습니다: ' + (e as Error).message, false);
  }
}));

call<{ dailyCap: number }>({ type: 'get-settings' })
  .then((r) => { $<HTMLInputElement>('cap').value = String(r.dailyCap); })
  .catch((e) => show('cap-out', '설정을 읽지 못했습니다: ' + (e as Error).message, false));
