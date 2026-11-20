package com.example.blogstat.collector;

import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * 1회성 로그인 부트스트랩. 사람이 직접 로그인하면 쿠키를 session-cookies.json에 저장한다.
 * (persistent profile만으로는 네이버 로그인이 다음 실행에 유지되지 않았다.)
 */
@Component
@ConditionalOnProperty(name = "app.mode", havingValue = "login")
public class LoginRunner implements CommandLineRunner {

    private final PlaywrightSessionFactory sessionFactory;
    private final SessionStore sessionStore;
    private final int loginTimeoutSec;

    public LoginRunner(PlaywrightSessionFactory sessionFactory,
                       SessionStore sessionStore,
                       @Value("${app.explore.login-timeout-sec}") int loginTimeoutSec) {
        this.sessionFactory = sessionFactory;
        this.sessionStore = sessionStore;
        this.loginTimeoutSec = loginTimeoutSec;
    }

    @Override
    public void run(String... args) {
        try (Playwright playwright = Playwright.create();
             BrowserContext context = sessionFactory.open(playwright, false)) {
            Page page = context.pages().isEmpty() ? context.newPage() : context.pages().get(0);
            if (!LoginSupport.ensureLoggedIn(context, page, loginTimeoutSec)) {
                throw new SessionExpiredException("로그인 대기 시간이 초과되었습니다.");
            }
            page.waitForTimeout(3000); // 로그인 후 리다이렉트로 쿠키가 모두 설정될 때까지
            sessionStore.save(context);
            System.out.println("[완료] 로그인 감지, 쿠키 저장됨. 쿠키 상태:\n" + LoginSupport.describeSession(context));
        }
    }
}
