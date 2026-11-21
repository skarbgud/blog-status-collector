package com.blogstat.collector;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import com.microsoft.playwright.PlaywrightException;
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
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ThreadLocalRandom;

/**
 * `--app.mode=catalog`: 통계 메뉴를 돌며 각 화면이 부르는 API와 응답 구조를 목록으로 만든다.
 * 다른 통계(조회수, 게시물 순위 등)를 수집 대상으로 고르기 전에 무엇이 있는지 보려는 1회성 탐색이다.
 *
 * 저장된 로그인 쿠키로 headless로 돈다. 페이지 사이 2~5초 쉬고, 최대 페이지 수를 넘지 않는다.
 * 응답 원문은 explore-output/catalog/(gitignore)에만 저장하고, 콘솔에는 구조만 출력한다.
 */
@Component
@ConditionalOnProperty(name = "app.mode", havingValue = "catalog")
public class StatCatalogExplorer implements CommandLineRunner {

    private final PlaywrightSessionFactory sessionFactory;
    private final SessionStore sessionStore;
    private final List<String> seeds;
    private final Path outDir;
    private final int maxPages;
    private final boolean headless;
    private final ObjectMapper mapper = new ObjectMapper();

    public StatCatalogExplorer(PlaywrightSessionFactory sessionFactory,
                               SessionStore sessionStore,
                               @Value("${app.stat-url}") String statUrl,
                               @Value("${app.catalog.output-dir:explore-output/catalog}") String outDir,
                               @Value("${app.catalog.max-pages:40}") int maxPages,
                               @Value("${app.catalog.headless:true}") boolean headless) {
        this.sessionFactory = sessionFactory;
        this.sessionStore = sessionStore;
        this.seeds = List.of("https://" + CatalogSupport.STAT_HOST + "/m/blog", statUrl);
        this.outDir = Paths.get(outDir);
        this.maxPages = maxPages;
        this.headless = headless;
    }

    /** API 하나의 기록. 같은 경로는 처음 본 것만 저장하고, 이후에는 어느 화면에서 불렸는지만 더한다. */
    private record ApiEntry(String path, int status, Map<String, String> params, String shape,
                            String file, Set<String> pages) {
    }

    @Override
    public void run(String... args) throws IOException {
        Files.createDirectories(outDir);
        Queue<Request> finished = new ConcurrentLinkedQueue<>();
        Map<String, ApiEntry> apis = new LinkedHashMap<>();
        Map<String, List<String>> menuTexts = new LinkedHashMap<>();
        Set<String> seen = new LinkedHashSet<>();
        seeds.forEach(s -> seen.add(CatalogSupport.pagePattern(s)));
        Deque<String> todo = new ArrayDeque<>(seeds);
        long started = System.currentTimeMillis();
        int visited = 0;

        try (Playwright playwright = Playwright.create();
             BrowserContext context = sessionFactory.open(playwright, headless)) {

            if (sessionStore.restore(context) == 0) {
                throw new SessionExpiredException("저장된 로그인 쿠키가 없습니다. `--app.mode=login`으로 먼저 로그인하세요.");
            }
            // 본문은 완료된 요청에서만 읽는다(미완료 응답의 text()는 끝없이 기다린다).
            context.onRequestFinished(req -> {
                if (CatalogSupport.isStatApi(req.url())) {
                    finished.add(req);
                }
            });
            Page page = context.pages().isEmpty() ? context.newPage() : context.pages().get(0);

            while (!todo.isEmpty() && visited < maxPages) {
                String url = todo.poll();
                if (visited > 0) {
                    page.waitForTimeout(ThreadLocalRandom.current().nextLong(2000, 5001));
                }
                visited++;
                System.out.println("[페이지 " + visited + "] " + url);
                try {
                    page.navigate(url);
                    try {
                        page.waitForLoadState(LoadState.NETWORKIDLE, new Page.WaitForLoadStateOptions().setTimeout(15000));
                    } catch (com.microsoft.playwright.TimeoutError e) {
                        // 폴링/트래킹으로 idle이 안 되는 화면이 있다. 탐색이므로 계속 진행.
                    }
                    page.waitForTimeout(1500);
                } catch (PlaywrightException e) {
                    System.out.println("  [건너뜀] 이동 실패: " + firstLine(e.getMessage()));
                    continue;
                }
                if (page.url().contains("nid.naver.com")) {
                    throw new SessionExpiredException("로그인 화면으로 이동했습니다. `--app.mode=login`으로 다시 로그인하세요.");
                }

                drain(finished, apis, url);
                menuTexts.put(url, menuTexts(page));

                @SuppressWarnings("unchecked")
                List<String> hrefs = (List<String>) page.evalOnSelectorAll("a[href]", "els => els.map(e => e.href)");
                for (String link : CatalogSupport.statPageLinks(hrefs)) {
                    // 글마다 있는 화면(article/{id}/cv)은 하나만 본다. 같은 API를 글 번호만 바꿔 부른다.
                    if (seen.add(CatalogSupport.pagePattern(link))) {
                        todo.add(link);
                    }
                }
            }
            drain(finished, apis, "(마지막)");
            // 탐색 중 서버가 갱신해 준 쿠키를 다음 실행에서도 쓰도록 되저장한다.
            sessionStore.save(context);
        }

        long sec = (System.currentTimeMillis() - started) / 1000;
        Path summary = outDir.resolve("catalog.md");
        Files.writeString(summary, render(apis, menuTexts, visited, todo.size(), sec), StandardCharsets.UTF_8);
        System.out.println();
        System.out.println("[완료] 페이지 " + visited + "개, API " + apis.size() + "종, " + sec + "초"
                + (todo.isEmpty() ? "" : " (방문 못 한 링크 " + todo.size() + "개 남음, app.catalog.max-pages로 늘릴 수 있음)"));
        System.out.println("[완료] 요약: " + summary.toAbsolutePath());
    }

    private void drain(Queue<Request> finished, Map<String, ApiEntry> apis, String pageUrl) throws IOException {
        Request req;
        while ((req = finished.poll()) != null) {
            String path = CatalogSupport.apiPath(req.url());
            ApiEntry known = apis.get(path);
            if (known != null) {
                known.pages().add(pageUrl);
                continue;
            }
            Response r = req.response();
            if (r == null) {
                continue;
            }
            String body;
            String shape;
            try {
                body = r.text();
                JsonNode json = mapper.readTree(body);
                shape = CatalogSupport.shape(json);
                body = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(json);
            } catch (RuntimeException | IOException e) {
                body = "(본문 읽기/파싱 실패)";
                shape = "(JSON 아님)";
            }
            String file = String.format("%02d%s.json", apis.size() + 1, path.replace('/', '_'));
            Files.writeString(outDir.resolve(file), "URL: " + req.url() + "\nSTATUS: " + r.status()
                    + "\n-----\n" + body, StandardCharsets.UTF_8);
            Set<String> pages = new LinkedHashSet<>();
            pages.add(pageUrl);
            ApiEntry entry = new ApiEntry(path, r.status(), CatalogSupport.params(req.url()), shape, file, pages);
            apis.put(path, entry);
            System.out.println("  [API] " + r.status() + " " + path + " " + entry.params().keySet());
            System.out.println("        " + abbreviate(shape, 300));
        }
    }

    /** 화면의 메뉴/탭 이름 후보(짧은 링크·버튼 텍스트). 링크가 없는 SPA 메뉴를 사람이 확인하는 용도. */
    @SuppressWarnings("unchecked")
    private static List<String> menuTexts(Page page) {
        try {
            List<String> texts = (List<String>) page.evalOnSelectorAll("a, button, [role=tab]",
                    "els => els.map(e => (e.innerText || '').trim()).filter(t => t && t.length <= 20)");
            return new ArrayList<>(new LinkedHashSet<>(texts));
        } catch (PlaywrightException e) {
            return List.of();
        }
    }

    private static String render(Map<String, ApiEntry> apis, Map<String, List<String>> menuTexts,
                                 int visited, int remaining, long sec) {
        StringBuilder sb = new StringBuilder("# 통계 API 목록\n\n");
        sb.append("- 방문 페이지 ").append(visited).append("개, API ").append(apis.size()).append("종, ")
                .append(sec).append("초").append(remaining > 0 ? ", 방문 못 한 링크 " + remaining + "개" : "").append("\n\n");
        sb.append("## API\n\n");
        for (ApiEntry e : apis.values()) {
            sb.append("### `").append(e.path()).append("` (").append(e.status()).append(")\n");
            sb.append("- 파라미터: ").append(e.params()).append("\n");
            sb.append("- 불린 화면: ").append(e.pages()).append("\n");
            sb.append("- 원문: `").append(e.file()).append("`\n");
            sb.append("- 구조: `").append(e.shape()).append("`\n\n");
        }
        sb.append("## 화면별 메뉴/탭 텍스트\n\n");
        menuTexts.forEach((url, texts) -> sb.append("- ").append(url).append(": ").append(texts).append("\n"));
        return sb.toString();
    }

    private static String abbreviate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    private static String firstLine(String s) {
        if (s == null) {
            return "";
        }
        int nl = s.indexOf('\n');
        return nl < 0 ? s : s.substring(0, nl);
    }
}
