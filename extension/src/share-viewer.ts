// 공유 링크 보기 페이지(Netlify)의 데이터 계층. 확장의 dashboard-api.js 자리에 들어가서
// 화면 스크립트의 fetch('/api/dashboard/<이름>')에 공유 데이터로 답한다.
// - 짧은 링크(#k=<번호>.<키>): 이 사이트의 /api/share/<번호>에서 암호문을 받아 링크의 키로 브라우저에서 푼다.
//   키는 서버로 보내지 않는다. 사이트가 하는 요청은 이것 하나뿐이다(CSP connect-src 'self').
// - 옛 링크(#s=<데이터>): 데이터가 링크 안에 있다. 요청 없음.
// - 링크를 열면 # 부분을 이 탭의 sessionStorage로 옮기고 주소를 #/overview로 바꾼다.
//   화면 전환(dashboard-router.js)이 # 를 쓰기 때문이다. 새로고침해도 같은 탭에서는 계속 보인다.
// - 기간 바꾸기는 막는다(링크에 든 기간만 있다). 확장 전용 표시(수집 상태, 백업 링크)는 공유 안내로 바꾼다.
(() => {
  const PREFIX = '/api/dashboard/';
  const STORE_KEY = 'blog_share_ref';

  // ---- 링크에서 공유 정보 꺼내기(라우터보다 먼저) ----
  let ref: string | null = null;
  if (/^#[ks]=/.test(location.hash)) {
    ref = location.hash.slice(1);
    try { sessionStorage.setItem(STORE_KEY, ref); } catch { /* 저장 못 하면 새로고침 때 다시 링크로 열어야 함 */ }
    history.replaceState(null, '', location.pathname + location.search + '#/overview');
  } else {
    try { ref = sessionStorage.getItem(STORE_KEY); } catch { ref = null; }
  }
  const text = ref;

  const original = window.fetch.bind(window);

  type Payload = { createdAt: string; from: string; to: string; responses: Record<string, unknown> };
  async function loadShare(r: string): Promise<Payload> {
    const c = await import('./core/share-codec.js');
    if (r.startsWith(c.SHARE_PREFIX)) return c.decodeShare(r.slice(c.SHARE_PREFIX.length));
    const k = c.refFromHash(r);
    if (!k) throw new c.ShareDecodeError('공유 링크가 잘렸거나 바뀌었습니다.');
    let res: Response;
    try {
      res = await original('/api/share/' + k.id, { cache: 'no-store', credentials: 'omit' });
    } catch {
      throw new Error('공유 데이터를 받지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.');
    }
    if (res.status === 404) throw new Error('없거나 기간이 지나 지워진 공유입니다. 보낸 사람에게 새 링크를 받아 주세요.');
    if (!res.ok) throw new Error('공유 데이터를 받지 못했습니다(HTTP ' + res.status + '). 잠시 뒤 새로고침해 주세요.');
    return c.openShare(new Uint8Array(await res.arrayBuffer()), k.key);
  }

  const data: Promise<Payload> = text
    ? loadShare(text)
    : Promise.reject(new Error('공유 데이터가 없습니다. 받은 공유 링크 전체로 다시 열어 주세요.'));
  data.catch(() => {}); // 오류는 화면 안내에서 보여 준다

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(PREFIX)) return original(input, init);
    try {
      const p = await data;
      const body = p.responses[url.pathname.slice(PREFIX.length)];
      if (body === undefined) return json(404, { message: '공유된 화면에 없는 데이터입니다.' });
      return json(200, body);
    } catch (e) {
      return json(400, { message: e instanceof Error ? e.message : String(e) });
    }
  };

  // ---- 화면: 읽기 전용 안내 ----
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  };

  /** 링크 없이 열었거나 링크가 잘렸을 때: 빈 대시보드 대신 안내 화면만 보여 준다. */
  function landing(title: string, detail: string): void {
    const layout = document.querySelector<HTMLElement>('.layout');
    if (layout) layout.style.display = 'none';
    const card = document.createElement('div');
    Object.assign(card.style, {
      maxWidth: '520px', margin: '15vh auto 0', padding: '28px 24px', background: 'var(--card)',
      border: '1px solid var(--line)', borderRadius: '12px', textAlign: 'center',
    });
    const h = document.createElement('h1');
    h.textContent = title;
    h.style.fontSize = '18px';
    h.style.margin = '0 0 10px';
    const p = document.createElement('p');
    p.textContent = detail;
    Object.assign(p.style, { color: 'var(--muted)', margin: '0', lineHeight: '1.6' });
    card.append(h, p);
    const wrap = document.createElement('div');
    wrap.style.padding = '0 16px';
    wrap.append(card);
    document.body.append(wrap);
  }

  function setup(): void {
    document.title = '블로그 통계 (공유)';
    if (!text) {
      landing('블로그 통계 공유 페이지',
        '이 페이지는 공유 링크로 여는 곳입니다. 받은 링크 전체(주소 끝의 #s=… 까지)를 그대로 열어 주세요. '
        + '데이터는 링크 안에만 있고 이 사이트에는 저장되지 않습니다.');
      return;
    }
    // 기간은 링크에 든 것 하나뿐이다.
    document.querySelectorAll<HTMLElement>('.presets, #apply').forEach((e) => { e.hidden = true; e.style.display = 'none'; });
    document.querySelectorAll<HTMLInputElement>('#from, #to').forEach((e) => { e.disabled = true; });
    // 오늘 유입(집계 중)은 공유에 들어 있지 않고, 사용시간은 공유할 때 보던 단위 하나만 들어 있다.
    document.querySelectorAll<HTMLElement>('#r-when, #r-today-refresh, #du-unit, #du-refresh').forEach((e) => { e.hidden = true; e.style.display = 'none'; });

    // 확장 전용 줄(수집 상태, 백업·가져오기)만 숨긴다. 최근 수집일(#s-latest)은 화면 스크립트가 채우므로 둔다.
    const status = document.querySelector('.status');
    document.querySelectorAll('.status .row').forEach((r) => {
      if (r.querySelector('#s-session, a[href="options.html"]')) (r as HTMLElement).style.display = 'none';
    });
    const banner = document.createElement('div');
    banner.className = 'banner warn';
    banner.setAttribute('role', 'status');
    banner.textContent = '공유 링크를 여는 중…';
    document.querySelector('main')?.prepend(banner);

    data.then((p) => {
      banner.textContent = '읽기 전용 공유 화면 · ' + p.from + ' ~ ' + p.to + ' · ' + fmt(p.createdAt) + '에 만든 스냅샷';
      if (status) {
        const row = (k: string, v: string) => {
          const r = document.createElement('div');
          r.className = 'row';
          const a = document.createElement('span');
          a.textContent = k;
          const b = document.createElement('span');
          b.textContent = v;
          r.append(a, b);
          return r;
        };
        status.append(row('보기', '공유(읽기 전용)'), row('만든 시각', fmt(p.createdAt)));
      }
    }, (e: unknown) => {
      banner.remove();
      // 링크 형식·키 문제(ShareDecodeError)는 잘린 링크일 때가 많다. 만료·네트워크는 메시지가 이미 안내한다.
      const msg = e instanceof Error ? e.message : String(e);
      const cut = e instanceof Error && e.constructor.name === 'ShareDecodeError';
      landing('공유 링크를 열 수 없습니다', msg + (cut ? ' 받은 링크 전체를 다시 복사해서 열어 주세요.' : ''));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
