// 대시보드 "공유 링크 만들기". 지금 화면이 받은 응답(/api/dashboard/*)을 모아 브라우저에서 암호화하고,
// 암호문만 보기 사이트(Netlify Function + Blobs)에 맡긴 뒤 짧은 링크(#k=<번호>.<키>)를 만든다.
// - 푸는 키는 링크의 # 뒤에만 있다. # 뒤는 서버로 전송되지 않으므로 사이트는 내용을 읽을 수 없다.
// - dashboard-api.js 다음에 일반 스크립트로 불러온다. fetch를 한 번 더 감싸서 응답을 기록만 하고, 응답은 그대로 돌려준다.
// - 링크를 가진 사람은 누구나 이 화면(검색어·유입 URL 포함)을 볼 수 있다. 버튼 아래에 그렇게 알린다.
// - 누구나 공유할 수 있다(인증 없음). 사이트가 IP당·하루 전체 업로드 수를 제한한다(src/core/share-api.ts).
// - 내 공유 목록(삭제 토큰 포함)은 이 확장 페이지의 localStorage에만 둔다.
(() => {
  const PREFIX = '/api/dashboard/';
  const VIEWER_KEY = 'share_viewer_url';
  const LIST_KEY = 'share_list';
  /** 배포된 보기 페이지(Netlify, 저장소 루트 netlify.toml). 다른 곳에 올렸으면 설정에서 바꾼다. */
  const DEFAULT_VIEWER = 'https://blog-status-collector.netlify.app/';
  /** 공유를 보관하는 일수. 지나면 사이트가 지운다(share-sweep). */
  const KEEP_DAYS = 90;

  interface MyShare { id: string; deleteToken: string; link: string; from: string; to: string; createdAt: string; expiresAt: string }

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
  const load = (k: string): string | null => {
    try { return localStorage.getItem(k); } catch { return null; }
  };
  const save = (k: string, v: string | null) => {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 저장 못 함 */ }
  };

  function viewerUrl(ask: boolean): string | null {
    const saved = load(VIEWER_KEY);
    if (!ask) return saved || DEFAULT_VIEWER;
    const v = prompt('공유 링크를 열 보기 페이지 주소를 입력하세요.\n비우고 확인하면 기본 주소(' + DEFAULT_VIEWER + ')로 돌아갑니다.',
      saved || DEFAULT_VIEWER);
    if (v !== null && v.trim() === '') {
      save(VIEWER_KEY, null);
      return DEFAULT_VIEWER;
    }
    if (!v) return null;
    try {
      const u = new URL(v.trim());
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') throw new Error('https');
      const clean = u.origin + u.pathname;
      save(VIEWER_KEY, clean);
      return clean;
    } catch {
      alert('주소 형식이 잘못됐습니다. https://로 시작하는 주소를 입력하세요.');
      return null;
    }
  }

  // ---- 내 공유 목록 ----
  function myShares(): MyShare[] {
    try {
      const list = JSON.parse(load(LIST_KEY) ?? '[]') as MyShare[];
      const now = Date.now();
      return Array.isArray(list) ? list.filter((s) => Date.parse(s.expiresAt) > now) : [];
    } catch {
      return [];
    }
  }
  const saveShares = (list: MyShare[]) => save(LIST_KEY, JSON.stringify(list.slice(0, 20)));

  let listBox: HTMLDetailsElement | null = null;
  function renderList(): void {
    if (!listBox) return;
    const list = myShares();
    listBox.replaceChildren();
    listBox.hidden = list.length === 0;
    if (list.length === 0) return;
    const ul = el('ul');
    Object.assign(ul.style, { listStyle: 'none', margin: '6px 0 0', padding: '0', display: 'grid', gap: '6px' });
    for (const s of list) {
      const li = el('li');
      const copy = el('a', '복사');
      copy.href = s.link;
      copy.addEventListener('click', (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(s.link).then(() => { copy.textContent = '복사됨'; }, () => window.open(s.link, '_blank', 'noopener'));
      });
      const del = el('a', '삭제');
      del.href = '#';
      del.style.marginLeft = '8px';
      del.addEventListener('click', (e) => {
        e.preventDefault();
        if (!confirm(s.from + ' ~ ' + s.to + ' 공유를 지울까요? 이 링크는 더 이상 열리지 않습니다.')) return;
        void remove(s).then(renderList);
      });
      li.append(el('span', s.from + ' ~ ' + s.to + ' · ' + s.expiresAt.slice(0, 10) + '까지 '), copy, del);
      ul.append(li);
    }
    listBox.append(el('summary', '내 공유 ' + list.length + '개'), ul);
  }

  async function remove(s: MyShare): Promise<void> {
    try {
      const res = await fetch(new URL('api/share/' + s.id, viewerUrl(false) ?? DEFAULT_VIEWER), {
        method: 'DELETE', headers: { 'X-Delete-Token': s.deleteToken },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      saveShares(myShares().filter((x) => x.id !== s.id));
    } catch (e) {
      alert('지우지 못했습니다: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ---- 화면 ----
  function mount(): void {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const box = el('div');
    const label = el('p', '공유');
    label.className = 'side-label';
    const controls = el('div');
    controls.className = 'controls';
    const make = el('button', '공유 링크 만들기');
    make.type = 'button';
    make.id = 'share-make';
    make.title = '지금 기간의 화면 전부(검색어·유입 URL 포함)를 암호화해 보기 사이트에 맡기고 짧은 링크를 만듭니다. '
      + '푸는 키는 링크에만 있어 사이트는 내용을 읽을 수 없습니다. ' + KEEP_DAYS + '일 뒤 자동으로 지워집니다.';
    const out = el('p');
    out.id = 'share-out';
    out.className = 'note';
    out.style.margin = '0';
    out.style.overflowWrap = 'anywhere';
    listBox = el('details');
    listBox.className = 'note';
    const settings = el('p');
    settings.className = 'note';
    settings.style.margin = '0';
    const viewer = el('a', '보기 페이지 주소');
    viewer.href = '#';
    viewer.addEventListener('click', (e) => {
      e.preventDefault();
      const u = viewerUrl(true);
      if (u) out.textContent = '보기 페이지: ' + u;
    });
    settings.append(el('span', '설정: '), viewer);
    controls.append(make, out, listBox, settings);
    box.append(label, controls);
    sidebar.append(box);
    make.addEventListener('click', () => void create(make, out));
    renderList();
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
    out.textContent = '암호화해서 올리는 중…';
    try {
      const codec = await import('./core/share-codec.js');
      const responses = codec.pickResponses(Object.fromEntries(recorded));
      const createdAt = new Date().toISOString();
      const { body, key } = await codec.sealShare({ v: codec.SHARE_VERSION, createdAt, from, to, responses });
      // 헤더를 붙이지 않는다(Content-Type 없음): 단순 요청이라 미리 확인 요청(OPTIONS)이 생기지 않아 IP당 업로드 수에 세지 않는다.
      const res = await fetch(new URL('api/share?days=' + KEEP_DAYS, base), {
        method: 'POST', body: body as Uint8Array<ArrayBuffer>, credentials: 'omit',
      });
      if (!res.ok) {
        let detail = '';
        try { detail = ((await res.json()) as { message?: string }).message ?? ''; } catch { /* 본문 없음(Netlify 요청 제한 응답 등) */ }
        if (!detail && res.status === 429) detail = '짧은 시간에 공유를 너무 많이 만들었습니다. 3분쯤 뒤에 다시 눌러 주세요.';
        throw new Error(detail || 'HTTP ' + res.status);
      }
      const r = (await res.json()) as { id: string; deleteToken: string; expiresAt: string };
      const link = codec.shortLink(base, r.id, key);
      saveShares([{ id: r.id, deleteToken: r.deleteToken, link, from, to, createdAt, expiresAt: r.expiresAt }, ...myShares()]);
      renderList();
      let copied = false;
      try {
        await navigator.clipboard.writeText(link);
        copied = true;
      } catch { /* 복사 권한 없음: 아래 링크를 직접 복사 */ }
      out.replaceChildren();
      const msg = (copied ? '링크를 복사했습니다. ' : '') + from + ' ~ ' + to + ' · ' + r.expiresAt.slice(0, 10) + '까지 열립니다. '
        + '링크를 가진 사람은 누구나 이 화면(검색어·유입 URL 포함)을 볼 수 있습니다.';
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
