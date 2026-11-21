// 팝업: PoC 실행 버튼과 결과 표. 값은 textContent로만 넣는다.
import type { PocReport } from './offscreen.js';

const btn = document.getElementById('run') as HTMLButtonElement;
const out = document.getElementById('out') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;

function line(label: string, value: string, ok?: boolean): HTMLElement {
  const div = document.createElement('div');
  div.className = 'line' + (ok === undefined ? '' : ok ? ' ok' : ' bad');
  const b = document.createElement('b');
  b.textContent = label;
  const span = document.createElement('span');
  span.textContent = value;
  div.append(b, span);
  return div;
}

function mask(id: string): string {
  return id.length <= 2 ? '**' : id.slice(0, 2) + '*'.repeat(Math.min(6, id.length - 2));
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  out.replaceChildren();
  status.textContent = '실행 중… (요청 사이 2~5초, 30초쯤 걸립니다)';
  try {
    const ready = (await chrome.runtime.sendMessage({ target: 'background', type: 'ensure-offscreen' })) as { ok: boolean; error?: string };
    if (!ready.ok) throw new Error(ready.error);
    const r = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'poc' })) as PocReport & { fatal?: string };
    if (r.fatal) throw new Error(r.fatal);
    const l = r.login;
    out.append(line('로그인', l.loggedIn ? '됨 (블로그 ' + mask(l.blogId ?? '') + ')' : '안 됨 ' + (l.error ?? 'HTTP ' + l.http), l.loggedIn));
    for (const d of r.days) {
      const text = 'HTTP ' + d.http + ' · ' + d.rows + '행 · 합계 ' + d.rowSum + ' / API ' + d.totalCount + (d.note ? ' · ' + d.note : '');
      out.append(line(d.date, text, d.ok));
    }
    const s = r.sqlite;
    out.append(line('SQLite', s.error ? s.error : 'v' + s.version + ' · 실행 ' + s.runCount + '회째 · 영구 저장 ' + (s.persisted ? '허용' : '미허용'), !s.error));
    status.textContent = '완료 (' + r.elapsedSec + '초, 네이버 요청 ' + r.requests + '회)';
  } catch (e) {
    status.textContent = '실패: ' + String(e);
  } finally {
    btn.disabled = false;
  }
});
