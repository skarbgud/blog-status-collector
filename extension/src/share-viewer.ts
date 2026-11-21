// 공유 링크 보기 페이지(Netlify)의 데이터 계층. 확장의 dashboard-api.js 자리에 들어가서
// 화면 스크립트의 fetch('/api/dashboard/<이름>')에 링크 # 뒤의 데이터로 답한다. 네트워크 요청은 없다.
// - 링크(#s=<데이터>)를 열면 데이터를 이 탭의 sessionStorage로 옮기고 주소를 #/overview로 바꾼다.
//   화면 전환(dashboard-router.js)이 # 를 쓰기 때문이다. 새로고침해도 같은 탭에서는 계속 보인다.
// - 기간 바꾸기는 막는다(링크에 든 기간만 있다). 확장 전용 표시(수집 상태, 백업 링크)는 공유 안내로 바꾼다.
(() => {
  const PREFIX = '/api/dashboard/';
  const STORE_KEY = 'blog_share_data';
  const HASH_PREFIX = '#s=';

  // ---- 링크에서 데이터 꺼내기(라우터보다 먼저) ----
  let text: string | null = null;
  if (location.hash.startsWith(HASH_PREFIX)) {
    text = location.hash.slice(HASH_PREFIX.length);
    try { sessionStorage.setItem(STORE_KEY, text); } catch { /* 저장 못 하면 새로고침 때 다시 링크로 열어야 함 */ }
    history.replaceState(null, '', location.pathname + location.search + '#/overview');
  } else {
    try { text = sessionStorage.getItem(STORE_KEY); } catch { text = null; }
  }

  type Payload = { createdAt: string; from: string; to: string; responses: Record<string, unknown> };
  const data: Promise<Payload> = text
    ? import('./core/share-codec.js').then((c) => c.decodeShare(text!))
    : Promise.reject(new Error('공유 데이터가 없습니다. 받은 공유 링크 전체로 다시 열어 주세요.'));
  data.catch(() => {}); // 오류는 화면 안내에서 보여 준다

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const original = window.fetch.bind(window);
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

  function setup(): void {
    document.title = '블로그 통계 (공유)';
    // 기간은 링크에 든 것 하나뿐이다.
    document.querySelectorAll<HTMLElement>('.presets, #apply').forEach((e) => { e.hidden = true; e.style.display = 'none'; });
    document.querySelectorAll<HTMLInputElement>('#from, #to').forEach((e) => { e.disabled = true; });

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
      banner.className = 'banner danger';
      banner.textContent = e instanceof Error ? e.message : String(e);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();
