// 서비스 워커: 오프스크린 문서를 띄우는 일만 한다. 오래 걸리는 일의 결과를 기다리지 않는다
// (기다리는 동안 30초 유휴 타이머가 연장되지 않아 서비스 워커가 끊길 수 있다).
// 팝업과 이후 트리거는 문서가 뜬 것을 확인한 뒤 오프스크린과 직접 통신한다.

const OFFSCREEN_URL = 'offscreen.html';

/** 생성 중인 Promise를 공유해 createDocument가 두 번 불리지 않게 한다. */
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: '통계 수집 루프와 SQLite(WASM) 워커를 서비스 워커 수명 제약 없이 실행',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string }, _sender, sendResponse) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'ensure-offscreen') {
    ensureOffscreen().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
