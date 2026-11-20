package com.example.blogstat.collector;

import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.BrowserType;
import com.microsoft.playwright.Playwright;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 로그인 세션이 디스크(userDataDir)에 유지되는 persistent context를 만든다.
 * 호출자가 Playwright와 BrowserContext를 닫을 책임이 있다.
 */
@Component
public class PlaywrightSessionFactory {

    // 모바일 통계 페이지(/m/)라 모바일 UA로 연다.
    private static final String MOBILE_UA =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
                    + "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

    private final Path profileDir;

    public PlaywrightSessionFactory(@Value("${app.profile-dir}") String profileDir) {
        this.profileDir = Paths.get(profileDir).toAbsolutePath();
    }

    public BrowserContext open(Playwright playwright, boolean headless) {
        BrowserType.LaunchPersistentContextOptions options =
                new BrowserType.LaunchPersistentContextOptions()
                        .setHeadless(headless)
                        .setUserAgent(MOBILE_UA)
                        .setViewportSize(390, 844)
                        .setIsMobile(true)
                        .setHasTouch(true)
                        .setLocale("ko-KR");
        return playwright.chromium().launchPersistentContext(profileDir, options);
    }
}
