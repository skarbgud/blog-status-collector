// 서비스 워커: 트리거를 받고 오프스크린 문서를 띄워 일을 넘긴다. 직접 오래 걸리는 일은 하지 않는다.

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: '통계 수집 루프와 SQLite(WASM) 워커를 서비스 워커 수명 제약 없이 실행',
  });
}

chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string }, _sender, sendResponse) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'poc') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'poc' }))
      .then(sendResponse, (e) => sendResponse({ fatal: String(e) }));
    return true;
  }
});
