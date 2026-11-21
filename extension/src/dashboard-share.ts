// 대시보드 "공유 링크 만들기". 지금 화면이 받은 응답(/api/dashboard/*)을 모아 링크의 # 뒤에 넣는다.
// - dashboard-api.js 다음에 일반 스크립트로 불러온다. fetch를 한 번 더 감싸서 응답을 기록만 하고, 응답은 그대로 돌려준다.
// - 링크를 여는 보기 페이지(Netlify, share-viewer.ts)는 데이터를 저장하지 않는다. # 뒤는 서버로 전송되지 않는다.
// - 링크를 가진 사람은 누구나 이 화면(검색어·유입 URL 포함)을 볼 수 있다. 버튼 아래에 그렇게 알린다.
(() => {
  const PREFIX = '/api/dashboard/';
  const VIEWER_KEY = 'share_viewer_url';
  /** 배포된 보기 페이지(Netlify, 저장소 루트 netlify.toml). 다른 곳에 올렸으면 "보기 페이지 주소 바꾸기"로 바꾼다. */
  const DEFAULT_VIEWER = 'https://blog-status-collector.netlify.app/';
  /** 30일 링크는 보통 이보다 훨씬 길다. 메신저에 따라 긴 링크가 잘릴 수 있어 이 길이를 넘으면 알린다. */
  const LONG_LINK = 30_000;

  // ---- 응답 기록: 이름마다 가장 최근의 성공 응답 ----
  const recorded = new Map<string, unknown>();
  const inner = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await inner(input, init);
    try {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href, location.href);
      if (res.ok && url.origin === location.origin && url.pathname.startsWith(PREFIX)) {
        const name = url.pathname.slice(PREFIX.length);
        res.clone().json().then((body: unknown) => recorded.set(name, body), () => {});
      }
    } catch { /* 기록 실패는 화면에 영향 없음 */ }
    return res;
  };

  const $ = (id: string) => document.getElementById(id);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function viewerUrl(ask: boolean): string | null {
    let saved: string | null = null;
    try { saved = localStorage.getItem(VIEWER_KEY); } catch { /* 저장소 없음 */ }
    if (!ask) return saved || DEFAULT_VIEWER;
    const v = prompt('공유 링크를 열 보기 페이지 주소를 입력하세요.\n비우고 확인하면 기본 주소(' + DEFAULT_VIEWER + ')로 돌아갑니다.',
      saved || DEFAULT_VIEWER);
    if (v !== null && v.trim() === '') {
      try { localStorage.removeItem(VIEWER_KEY); } catch { /* 저장소 없음 */ }
      return DEFAULT_VIEWER;
    }
    if (!v) return null;
    try {
      const u = new URL(v.trim());
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('https');
      const clean = u.origin + u.pathname;
      try { localStorage.setItem(VIEWER_KEY, clean); } catch { /* 저장 못 해도 이번에는 쓴다 */ }
      return clean;
    } catch {
      alert('주소 형식이 잘못됐습니다. https://로 시작하는 주소를 입력하세요.');
      return null;
    }
  }

  function mount(): void {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const box = el('div');
    box.append(el('p', '공유'));
    box.firstElementChild!.className = 'side-label';
    const controls = el('div');
    controls.className = 'controls';
    const make = el('button', '공유 링크 만들기');
    make.type = 'button';
    make.id = 'share-make';
    make.title = '지금 기간의 화면 전부(검색어·유입 URL 포함)를 링크 하나에 담습니다. 데이터는 어느 서버에도 저장되지 않습니다.';
    const out = el('p');
    out.id = 'share-out';
    out.className = 'note';
    out.style.margin = '0';
    out.style.overflowWrap = 'anywhere';
    const change = el('a', '보기 페이지 주소 바꾸기');
    change.href = '#';
    change.className = 'note';
    change.addEventListener('click', (e) => {
      e.preventDefault();
      const u = viewerUrl(true);
      if (u) out.textContent = '보기 페이지: ' + u;
    });
    controls.append(make, out, change);
    box.append(controls);
    sidebar.append(box);
    make.addEventListener('click', () => void create(make, out));
  }

  async function create(button: HTMLButtonElement, out: HTMLElement): Promise<void> {
    const from = ($('from') as HTMLInputElement | null)?.value ?? '';
    const to = ($('to') as HTMLInputElement | null)?.value ?? '';
    // 기간이 있는 응답은 모두 지금 기간이어야 한다(이전 기간 응답이 섞이지 않게).
    const stale = [...recorded.values()].some((b) => {
      const r = b as { from?: unknown; to?: unknown } | null;
      return !!r && typeof r === 'object' && typeof r.from === 'string' && (r.from !== from || r.to !== to);
    });
    if (!recorded.has('summary') || !recorded.has('metrics') || stale) {
      out.textContent = '화면을 다 불러온 뒤 다시 눌러 주세요. (기간을 바꿨다면 "조회"를 먼저 누르세요)';
      return;
    }
    const base = viewerUrl(false);
    if (!base) return;
    button.disabled = true;
    out.textContent = '만드는 중…';
    try {
      const codec = await import('./core/share-codec.js');
      const responses = codec.pickResponses(Object.fromEntries(recorded));
      const data = await codec.encodeShare({
        v: codec.SHARE_VERSION, createdAt: new Date().toISOString(), from, to, responses,
      });
      const link = codec.shareLink(base, data);
      let copied = false;
      try {
        await navigator.clipboard.writeText(link);
        copied = true;
      } catch { /* 복사 권한 없음: 아래 링크를 직접 복사 */ }
      out.replaceChildren();
      const msg = (copied ? '링크를 복사했습니다. ' : '') + from + ' ~ ' + to + ' · ' + link.length.toLocaleString('ko-KR') + '자. '
        + '링크를 가진 사람은 누구나 이 화면(검색어·유입 URL 포함)을 볼 수 있습니다.'
        + (link.length > LONG_LINK ? ' 링크가 길어 메신저에 따라 잘릴 수 있습니다. 잘리면 기간을 줄여 다시 만드세요.' : '');
      const open = el('a', '새 탭에서 열어 보기');
      open.href = link;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      out.append(el('span', msg + ' '), open);
    } catch (e) {
      out.textContent = '링크를 만들지 못했습니다: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      button.disabled = false;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
