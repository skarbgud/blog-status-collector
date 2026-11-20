package com.example.blogstat.collector;

import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** 1회성 로그인 부트스트랩. 사람이 로그인하면 세션이 .playwright-profile에 저장된다. */
@Component
@ConditionalOnProperty(name = "app.mode", havingValue = "login")
public class LoginRunner implements CommandLineRunner {

    private final PlaywrightSessionFactory sessionFactory;
    private final String statUrl;
    private final int loginTimeoutSec;

    public LoginRunner(PlaywrightSessionFactory sessionFactory,
                       @Value("${app.stat-url}") String statUrl,
                       @Value("${app.explore.login-timeout-sec}") int loginTimeoutSec) {
        this.sessionFactory = sessionFactory;
        this.statUrl = statUrl;
        this.loginTimeoutSec = loginTimeoutSec;
    }

    @Override
    public void run(String... args) {
        try (Playwright playwright = Playwright.create();
             BrowserContext context = sessionFactory.open(playwright, false)) {
            Page page = context.pages().isEmpty() ? context.newPage() : context.pages().get(0);
            if (LoginSupport.ensureLoggedIn(context, page, loginTimeoutSec)) {
                page.waitForTimeout(3000); // 로그인 후 리다이렉트로 쿠키가 모두 설정될 때까지
                System.out.println("[완료] 로그인 감지. 쿠키 상태:\n" + LoginSupport.describeSession(context));
            } else {
                throw new SessionExpiredException("로그인 대기 시간이 초과되었습니다.");
            }
        }
    }
}
