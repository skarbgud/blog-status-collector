// 서비스 워커: 트리거를 받아 오프스크린 문서를 띄우고 "수집해 봐"라고 알리는 일만 한다.
// 결과를 기다리지 않는다(기다리는 동안 30초 유휴 타이머가 연장되지 않아 서비스 워커가 끊길 수 있다).
//
// 트리거: 설치·업데이트, 브라우저 시작, 30분마다 알람, 팝업의 "지금 수집".
// 로그인 쿠키(NID_AUT)가 없으면 오프스크린을 띄우지 않아 네이버 요청이 0회다.
// 쿠키는 "있는지"만 본다. 값은 쓰지도, 저장하지도, 출력하지도 않는다.

const OFFSCREEN_URL = 'offscreen.html';
const ALARM = 'collect';
const PERIOD_MIN = 30;

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

async function hasLoginCookie(): Promise<boolean> {
  const cookie = await chrome.cookies.get({ url: 'https://blog.stat.naver.com/', name: 'NID_AUT' });
  return cookie !== null;
}

async function ensureAlarm(): Promise<void> {
  // 알람은 브라우저를 다시 켜면 사라질 수 있어 시작할 때마다 확인한다.
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MIN });
  }
}

/** 회차를 시작한다. 사람이 누른 수집(manual)은 days만큼 다시 받아 덮어쓴다. 오프스크린의 수락 여부를 돌려준다. */
async function kick(trigger: string, days?: number): Promise<{ accepted: boolean; reason?: string }> {
  if (trigger !== 'manual' && !(await hasLoginCookie())) {
    await setBadge('!', '네이버 로그인이 필요합니다');
    return { accepted: false, reason: 'no-login-cookie' };
  }
  await ensureOffscreen();
  const r = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'collect', trigger, days })) as
    { accepted: boolean; reason?: string } | undefined;
  return r ?? { accepted: false, reason: 'no-reply' };
}

async function setBadge(text: string, title: string): Promise<void> {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#b91c1c' : '#6b7280' });
  await chrome.action.setTitle({ title: title ? '블로그 통계 · ' + title : '블로그 통계' });
}

const warn = (trigger: string) => (e: unknown) => console.warn('[트리거] ' + trigger + ' 실패:', e);

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm().then(() => kick('installed')).catch(warn('installed'));
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm().then(() => kick('startup')).catch(warn('startup'));
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) kick('alarm').catch(warn('alarm'));
});

type BgMsg = { target?: string; type?: string; text?: string; title?: string; days?: number };

chrome.runtime.onMessage.addListener((msg: BgMsg, _sender, sendResponse) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'ensure-offscreen') {
    ensureOffscreen().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'collect-now') {
    // 사람이 누른 수집: 빠진 것을 채우고 최근 days일(기본 어제 하루)을 다시 받아 덮어쓴다.
    kick('manual', msg.days).then(
      (r) => sendResponse({ ok: r.accepted, reason: r.reason }),
      (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'badge') {
    setBadge(msg.text ?? '', msg.title ?? '').catch(() => {});
  }
});
