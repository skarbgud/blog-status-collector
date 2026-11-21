// 팝업: 수집 상태와 "지금 수집". 값은 textContent로만 넣는다. 열려 있는 동안 2초마다 상태를 다시 읽는다.
import type { StatusReply } from './offscreen.js';

const rowsEl = document.getElementById('rows') as HTMLElement;
const progressEl = document.getElementById('progress') as HTMLElement;
const btn = document.getElementById('run') as HTMLButtonElement;

const OUTCOME: Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' }> = {
  done: { text: '완료', tone: 'ok' },
  partial: { text: '일부 대기', tone: 'warn' },
  'up-to-date': { text: '최신', tone: 'ok' },
  waiting: { text: '04:00 대기', tone: 'warn' },
  'cap-reached': { text: '하루 상한', tone: 'warn' },
  'login-required': { text: '로그인 필요', tone: 'bad' },
  'login-backoff': { text: '로그인 필요', tone: 'bad' },
  'other-account': { text: '다른 계정', tone: 'bad' },
  error: { text: '오류', tone: 'bad' },
};

function line(label: string, value: string, tone?: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'line';
  const b = document.createElement('b');
  b.textContent = label;
  const span = document.createElement('span');
  span.textContent = value;
  if (tone) span.className = tone;
  div.append(b, span);
  return div;
}

function mask(id: string): string {
  return id.length <= 2 ? '**' : id.slice(0, 2) + '*'.repeat(Math.min(6, id.length - 2));
}

function time(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function ensureOffscreen(): Promise<void> {
  const r = (await chrome.runtime.sendMessage({ target: 'background', type: 'ensure-offscreen' })) as { ok: boolean; error?: string };
  if (!r.ok) throw new Error(r.error);
}

function render(s: StatusReply): void {
  const out: HTMLElement[] = [];
  if (s.error || !s.stored) {
    out.push(line('상태', 'DB를 열지 못했습니다: ' + (s.error ?? '알 수 없음'), 'bad'));
    rowsEl.replaceChildren(...out);
    return;
  }
  const st = s.stored;
  out.push(line('블로그', st.blogId ? mask(st.blogId) : '아직 없음(첫 수집 때 묶임)'));
  const last = s.lastReport ?? (st.lastRun?.outcome ? { outcome: st.lastRun.outcome, message: st.lastRun.message ?? '' } : null);
  if (last) {
    const o = OUTCOME[last.outcome] ?? { text: last.outcome, tone: 'warn' as const };
    const when = st.lastRun ? time(st.lastRun.startedAt) + ' · ' : '';
    out.push(line('마지막 확인', when + o.text + (last.message ? ' — ' + last.message : ''), o.tone));
  } else {
    out.push(line('마지막 확인', '아직 없음'));
  }
  out.push(line('오늘 요청', st.todayRequests + ' / ' + st.dailyCap + '회'));
  out.push(line('유입경로', st.referrerDays > 0 ? st.referrerDays + '일 (' + st.referrerFirst + ' ~ ' + st.referrerLast + ')' : '없음'));
  out.push(line('지표', st.metricRows > 0 ? st.metricRows.toLocaleString('ko-KR') + '행 (최근 ' + st.metricLast + ')' : '없음'));
  rowsEl.replaceChildren(...out);

  const p = s.progress;
  progressEl.hidden = !p;
  btn.disabled = !!p;
  btn.textContent = p ? '수집 중…' : '지금 수집';
  if (p) progressEl.textContent = '수집 중 · 요청 ' + p.requests + (p.maxRequests ? ' / ' + p.maxRequests : '') + '회 · ' + p.message;
}

async function refresh(): Promise<void> {
  try {
    const s = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' })) as StatusReply | undefined;
    if (s) render(s);
  } catch (e) {
    rowsEl.replaceChildren(line('상태', '읽지 못했습니다: ' + String(e), 'bad'));
  }
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  try {
    const r = (await chrome.runtime.sendMessage({ target: 'background', type: 'collect-now' })) as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(r.error);
  } catch (e) {
    rowsEl.prepend(line('수집', '시작하지 못했습니다: ' + String(e), 'bad'));
  }
  await refresh();
});

(async () => {
  try {
    await ensureOffscreen();
  } catch (e) {
    rowsEl.replaceChildren(line('상태', '준비하지 못했습니다: ' + String(e), 'bad'));
    return;
  }
  await refresh();
  setInterval(refresh, 2000);
})();
