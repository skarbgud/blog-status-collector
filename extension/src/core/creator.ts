// 크리에이터 어드바이저 전송 어댑터(크롬 전용, 오프스크린에서 쓴다). StatClient의 extraHeaders·onForbidden 훅을 채운다.
// - 서명(x-ca-*): 네이버가 심어 준 __ca_key 쿠키로 요청에 서명한다(core/ca-sign.ts). 본인 세션·본인 데이터 전용.
// - 키 갱신: __ca_key가 없거나 403이면, 네이버 화면과 같은 방식으로 accounts/channels를 한 번 불러 쿠키를 새로 받는다.
// - Referer: 크리에이터 어드바이저는 채널ID 경로 Referer를 요구한다(네트워크 헤더라 fetch로 못 바꿈) → 백그라운드가
//   declarativeNetRequest 세션 규칙으로 우리 확장 요청(tabId -1)에만 설정한다.
// 비밀값(__ca_key·서명)은 로그에 남기지 않는다.
import { CREATOR_ORIGIN, type StatClientOptions } from './naver.js';
import { caSignHeaders, signKeyOf } from './ca-sign.js';

type Log = (level: 'info' | 'warn', message: string) => void;

/** 네이버 화면이 쓰는 키 갱신 경로. 서명 없이 credentials로 부르면 네이버가 __ca_key 쿠키를 새로 내려 준다. */
const KEY_REFRESH_URL = CREATOR_ORIGIN + '/api/v6/accounts/channels';

async function caKeyValue(): Promise<string | null> {
  try {
    const c = await chrome.cookies.get({ url: CREATOR_ORIGIN, name: '__ca_key' });
    return c?.value ?? null;
  } catch {
    return null;
  }
}

async function refreshKey(): Promise<void> {
  try {
    await fetch(KEY_REFRESH_URL, { method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch { /* 성공 여부는 쿠키가 생겼는지로 판정한다 */ }
}

/** StatClient에 넣을 서명·403 처리 훅. 클라이언트 하나당 키 갱신은 최대 maxRefresh번(기본 2)만. */
export function creatorSigner(log: Log = () => {}, maxRefresh = 2): Pick<StatClientOptions, 'extraHeaders' | 'onForbidden'> {
  let refreshed = 0;
  return {
    async extraHeaders(url) {
      let value = await caKeyValue();
      if (!value && refreshed < maxRefresh) {
        refreshed++;
        await refreshKey();
        value = await caKeyValue();
        log('info', '[사용시간] 서명키가 없어 새로 받았습니다(' + (value ? '성공' : '실패') + ').');
      }
      return caSignHeaders(url, signKeyOf(value));
    },
    async onForbidden() {
      if (refreshed >= maxRefresh) return false; // 더 갱신해도 안 되면 거절로 본다
      refreshed++;
      await refreshKey();
      log('info', '[사용시간] 403을 받아 서명키를 새로 받았습니다. 다시 시도합니다.');
      return true;
    },
  };
}

/** 크리에이터 어드바이저 요청에 채널ID 경로 Referer를 붙이도록 백그라운드에 부탁한다. 실패해도 수집은 계속 시도한다. */
export async function ensureCreatorReferer(channelId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ target: 'background', type: 'creator-referer', channelId });
  } catch { /* 규칙 등록 실패는 403으로 드러난다 */ }
}
