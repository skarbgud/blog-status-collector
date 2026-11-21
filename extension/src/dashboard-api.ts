// 대시보드 페이지의 fetch 가로채기. 화면 스크립트(Java 대시보드에서 가져옴)는 그대로 fetch('/api/dashboard/...')를 부르고,
// 이 스크립트가 그 요청을 오프스크린 문서의 로컬 조회 계층(DashboardQuery)으로 돌려 같은 모양의 JSON을 돌려준다.
// 네트워크로 나가는 요청은 없다. 다른 스크립트보다 먼저 일반 스크립트로 불러온다(모듈 아님).
(() => {
  const original = window.fetch.bind(window);
  const PREFIX = '/api/dashboard/';
  let ready: Promise<void> | null = null;

  function ensureOffscreen(): Promise<void> {
    ready ??= (chrome.runtime.sendMessage({ target: 'background', type: 'ensure-offscreen' }) as Promise<{ ok: boolean; error?: string }>)
      .then((r) => {
        if (!r?.ok) throw new Error(r?.error ?? '오프스크린 문서를 띄우지 못했습니다');
      })
      .catch((e: unknown) => {
        ready = null;
        throw e;
      });
    return ready;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith(PREFIX)) return original(input, init);
    try {
      await ensureOffscreen();
      const r = (await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'api', name: url.pathname.slice(PREFIX.length), params: Object.fromEntries(url.searchParams),
      })) as { status: number; body: unknown } | undefined;
      if (!r) return json(503, { message: '저장소가 응답하지 않습니다' });
      return json(r.status, r.body);
    } catch (e) {
      return json(500, { message: String(e) });
    }
  };
})();
