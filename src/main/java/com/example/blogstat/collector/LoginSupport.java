package com.example.blogstat.collector;

import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Page;

/** 로그인은 사람이 브라우저에서 직접 한다. 여기서는 로그인 쿠키가 생길 때까지 기다리기만 한다. */
final class LoginSupport {

    private static final String LOGIN_URL = "https://nid.naver.com/nidlogin.login";
    private static final String SESSION_COOKIE = "NID_SES";

    private LoginSupport() {
    }

    static boolean hasSession(BrowserContext context) {
        return context.cookies().stream().anyMatch(c -> SESSION_COOKIE.equals(c.name));
    }

    /**
     * 로그인 쿠키가 디스크에 남는 종류인지 확인하려고 이름과 만료 정보만 보여 준다. 값은 절대 출력하지 않는다.
     * expires가 -1이면 세션 쿠키라서 브라우저를 닫으면 사라진다.
     */
    static String describeSession(BrowserContext context) {
        StringBuilder sb = new StringBuilder();
        context.cookies().stream()
                .filter(c -> c.name.equals("NID_SES") || c.name.equals("NID_AUT"))
                .forEach(c -> sb.append(c.name).append(": ")
                        .append(c.expires == null || c.expires < 0 ? "세션 쿠키(종료 시 삭제)"
                                : "영속 쿠키(만료 " + java.time.Instant.ofEpochSecond(c.expires.longValue()) + ")")
                        .append("\n"));
        return sb.length() == 0 ? "로그인 쿠키 없음" : sb.toString().trim();
    }

    /**
     * 세션 쿠키가 없으면 네이버 로그인 페이지를 열고 사람이 로그인할 때까지 대기한다.
     * 통계 페이지는 비로그인 시 로그인 화면이 아니라 401 오류 화면을 보여주므로 URL이 아니라 쿠키로 판단한다.
     */
    static boolean ensureLoggedIn(BrowserContext context, Page page, int timeoutSec) {
        if (hasSession(context)) {
            return true;
        }
        page.navigate(LOGIN_URL);
        System.out.println("[로그인 필요] 열린 브라우저에서 네이버에 직접 로그인하세요. (최대 "
                + timeoutSec + "초 대기)");
        for (int i = 0; i < timeoutSec; i++) {
            if (hasSession(context)) {
                return true;
            }
            page.waitForTimeout(1000);
        }
        return false;
    }
}
