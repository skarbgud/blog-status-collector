package com.blogstat.collector.core;

import com.blogstat.collector.PlaywrightSessionFactory;
import com.blogstat.collector.SessionExpiredException;
import com.blogstat.collector.SessionStore;
import com.microsoft.playwright.APIRequestContext;
import com.microsoft.playwright.APIResponse;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Playwright;
import com.microsoft.playwright.PlaywrightException;
import com.microsoft.playwright.options.RequestOptions;
import org.springframework.stereotype.Component;

import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Consumer;

/**
 * 저장된 로그인 쿠키로 브라우저 컨텍스트를 열고, 회차 하나 동안 쓸 {@link StatSession}을 빌려준다.
 * 페이지는 띄우지 않고 context.request()로 API만 호출한다.
 */
@Component
public class NaverStatClient {

    private final PlaywrightSessionFactory sessionFactory;
    private final SessionStore sessionStore;
    private final CollectSettings settings;

    public NaverStatClient(PlaywrightSessionFactory sessionFactory, SessionStore sessionStore,
                           CollectSettings settings) {
        this.sessionFactory = sessionFactory;
        this.sessionStore = sessionStore;
        this.settings = settings;
    }

    /**
     * 회차 하나를 실행한다. work가 정상으로 끝나면 서버가 갱신해 준 쿠키를 되저장한다.
     *
     * @throws SessionExpiredException 저장된 쿠키가 없거나 API가 401/403을 줄 때
     */
    public void run(Consumer<StatSession> work) {
        run(settings.maxRequestsPerRun(), work);
    }

    /**
     * 회차의 요청 예산을 따로 정해 실행한다. 지표를 30일치 한꺼번에 받는 수집처럼 기본 예산보다 요청이 많은 작업용이다.
     */
    public void run(int maxRequests, Consumer<StatSession> work) {
        try (Playwright playwright = Playwright.create();
             BrowserContext context = sessionFactory.open(playwright, settings.headless())) {

            // persistent profile만으로는 네이버 로그인이 유지되지 않아, 로그인 때 저장한 쿠키를 복원한다.
            if (sessionStore.restore(context) == 0) {
                throw new SessionExpiredException(
                        "저장된 로그인 쿠키가 없습니다. `--app.mode=login`으로 먼저 로그인하세요.");
            }

            StatSession session = new StatSession(playwrightHttp(context.request()), settings,
                    new RequestBudget(maxRequests),
                    StatSession::sleep, () -> ThreadLocalRandom.current().nextDouble());
            work.accept(session);
            System.out.println("[요청] 이번 회차 " + session.budget().used() + "/" + session.budget().limit() + "회");

            // 서버가 갱신해 준 쿠키가 있으면 다음 실행에서도 쓰도록 되저장한다.
            sessionStore.save(context);
        }
    }

    private RawHttp playwrightHttp(APIRequestContext api) {
        return url -> {
            try {
                APIResponse response = api.get(url, RequestOptions.create()
                        .setTimeout(settings.requestTimeoutMs())
                        .setHeader("Accept", "application/json")
                        .setHeader("Referer", settings.refererPage()));
                int status = response.status();
                // 본문은 성공일 때만 읽는다(실패 응답 본문은 쓰지 않는다).
                return new RawHttp.RawResponse(status, response.headers().get("retry-after"),
                        status == 200 ? response.text() : null);
            } catch (PlaywrightException e) {
                throw new RawHttp.TransportException(e.getMessage(), e);
            }
        };
    }
}
