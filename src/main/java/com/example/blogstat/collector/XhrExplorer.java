package com.example.blogstat.collector;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import com.microsoft.playwright.Request;
import com.microsoft.playwright.Response;
import com.microsoft.playwright.options.LoadState;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * 3단계: 통계 페이지가 호출하는 XHR/fetch 요청을 기록한다.
 * URL/메서드/상태/응답 본문을 explore-output/에 저장해 데이터 소스와 날짜 파라미터를 확정하는 데 쓴다.
 */
@Component
@ConditionalOnProperty(name = "app.mode", havingValue = "explore")
public class XhrExplorer implements CommandLineRunner {

    private final PlaywrightSessionFactory sessionFactory;
    private final SessionStore sessionStore;
    private final String statUrl;
    private final Path outDir;
    private final int loginTimeoutSec;
    private final int extraObserveSec;
    private final ObjectMapper mapper = new ObjectMapper();

    private int seq = 0;

    public XhrExplorer(PlaywrightSessionFactory sessionFactory,
                       SessionStore sessionStore,
                       @Value("${app.explore.url:${app.stat-url}}") String statUrl,
                       @Value("${app.explore.output-dir}") String outDir,
                       @Value("${app.explore.login-timeout-sec}") int loginTimeoutSec,
                       @Value("${app.explore.extra-observe-sec}") int extraObserveSec) {
        this.sessionFactory = sessionFactory;
        this.sessionStore = sessionStore;
        this.statUrl = statUrl;
        this.outDir = Paths.get(outDir);
        this.loginTimeoutSec = loginTimeoutSec;
        this.extraObserveSec = extraObserveSec;
    }

    @Override
    public void run(String... args) throws IOException {
        Files.createDirectories(outDir);
        Queue<Request> captured = new ConcurrentLinkedQueue<>();

        try (Playwright playwright = Playwright.create();
             BrowserContext context = sessionFactory.open(playwright, false)) {

            // 시작되는 요청은 URL만 즉시 출력한다. 끝나지 않는 요청(스트리밍/롱폴링)도 URL은 알 수 있다.
            context.onRequest(req -> {
                if (isInteresting(req)) {
                    System.out.println("  [요청] " + req.method() + " " + req.url());
                }
            });
            // 본문은 요청이 "완료된 뒤"에만 읽는다. 미완료 응답의 text()는 타임아웃 없이 영원히 대기한다.
            // 읽기는 이벤트 핸들러 밖(메인 스레드)에서 하려고 큐에만 담는다.
            context.onRequestFinished(req -> {
                if (isInteresting(req)) {
                    captured.add(req);
                }
            });

            Page page = context.pages().isEmpty() ? context.newPage() : context.pages().get(0);
            // 저장해 둔 로그인 쿠키를 복원한다. 쿠키 파일이 없을 때만 수동 로그인을 기다린다.
            if (sessionStore.restore(context) == 0
                    && !LoginSupport.ensureLoggedIn(context, page, loginTimeoutSec)) {
                throw new SessionExpiredException("로그인 대기 시간이 초과되었습니다.");
            }

            // 로그인 과정의 요청이 섞이지 않도록 비우고 통계 페이지를 로드한다.
            captured.clear();
            page.navigate(statUrl);
            try {
                page.waitForLoadState(LoadState.NETWORKIDLE);
            } catch (com.microsoft.playwright.TimeoutError e) {
                // 통계 페이지가 폴링/트래킹으로 idle이 안 될 수 있다. 탐색 목적이므로 계속 진행.
                System.out.println("[진단] networkidle 대기 시간 초과, 계속 진행");
            }
            page.waitForTimeout(3000);
            System.out.println("[탐색] 초기 로드 캡처");
            drain(captured);
            System.out.println("[진단] 최종 URL: " + page.url() + " / 제목: " + page.title());
            Files.writeString(outDir.resolve("page-text.txt"),
                    page.url() + "\n-----\n" + page.innerText("body"), StandardCharsets.UTF_8);
            Files.writeString(outDir.resolve("page.html"), page.content(), StandardCharsets.UTF_8);

            System.out.println("[탐색] 이제 " + extraObserveSec
                    + "초 동안 추가 관찰합니다. 브라우저에서 직접 조작하세요. 이 시간 동안의 요청이 모두 기록됩니다.");
            for (int i = 0; i < extraObserveSec; i++) {
                page.waitForTimeout(1000);
                drain(captured);
            }
            drain(captured);
            // 사용자가 조작한 뒤의 화면 텍스트도 남겨 둔다(펼친 검색어가 DOM에 있는지 확인용).
            try {
                Files.writeString(outDir.resolve("final-page-text.txt"),
                        page.url() + "\n-----\n" + page.innerText("body"), StandardCharsets.UTF_8);
            } catch (RuntimeException e) {
                System.out.println("[진단] 최종 화면 텍스트 저장 실패: " + e.getMessage());
            }
            System.out.println("[완료] 결과: " + outDir.toAbsolutePath());
        }
    }

    private static boolean isInteresting(Request req) {
        String type = req.resourceType();
        if (!("xhr".equals(type) || "fetch".equals(type) || "document".equals(type))) {
            return false;
        }
        // 광고/트래킹 도메인 잡음을 줄이려고 블로그·통계 도메인만 본다.
        String url = req.url();
        int hostEnd = url.indexOf('/', 8);
        String host = hostEnd < 0 ? url : url.substring(0, hostEnd);
        return host.contains("blog") || host.contains("stat");
    }

    private void drain(Queue<Request> queue) throws IOException {
        Request req;
        while ((req = queue.poll()) != null) {
            Response r = req.response();
            if (r == null) {
                continue;
            }
            String contentType = r.headers().getOrDefault("content-type", "");
            String body;
            try {
                body = r.text();
            } catch (RuntimeException e) {
                body = "(본문 읽기 실패: " + e.getMessage() + ")";
            }
            boolean json = contentType.contains("json");
            if (json) {
                try {
                    body = mapper.writerWithDefaultPrettyPrinter()
                            .writeValueAsString(mapper.readTree(body));
                } catch (IOException ignored) {
                    // JSON 헤더지만 파싱 실패하면 원문 그대로 저장
                }
            }

            String postData = r.request().postData();
            String header = "URL: " + r.url() + "\n"
                    + "METHOD: " + r.request().method() + "\n"
                    + "STATUS: " + r.status() + "\n"
                    + "CONTENT-TYPE: " + contentType + "\n"
                    + (postData != null ? "POST-DATA: " + postData + "\n" : "")
                    + "-----\n";

            String name = String.format("%02d-%d%s.txt", ++seq, r.status(), json ? "-json" : "");
            Files.writeString(outDir.resolve(name), header + body, StandardCharsets.UTF_8);
            System.out.println("  #" + seq + " " + r.status() + " " + r.request().method() + " "
                    + r.url() + (json ? "  [JSON]" : ""));
        }
    }
}
