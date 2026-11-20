package com.example.blogstat.collector;

import com.microsoft.playwright.APIRequestContext;
import com.microsoft.playwright.APIResponse;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Playwright;
import com.microsoft.playwright.PlaywrightException;
import com.microsoft.playwright.options.RequestOptions;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.Consumer;

/**
 * 저장된 로그인 세션(persistent context 쿠키)으로 유입경로 API를 날짜별로 호출한다.
 * 브라우저 페이지를 띄우지 않고 context.request()로 직접 호출한다.
 */
@Component
public class RefererCollector {

    private static final String API_PATH = "/api/blog/daily/referer/total";

    private final PlaywrightSessionFactory sessionFactory;
    private final SessionStore sessionStore;
    private final RefererParser parser;
    private final String baseUrl;
    private final String refererPage;
    private final long minDelayMs;
    private final long maxDelayMs;
    private final int maxRetries;
    private final long baseBackoffMs;
    private final long capBackoffMs;
    private final long requestTimeoutMs;
    private final boolean headless;
    private final int querySize;

    public RefererCollector(PlaywrightSessionFactory sessionFactory,
                            SessionStore sessionStore,
                            RefererParser parser,
                            @Value("${app.stat-url}") String statUrl,
                            @Value("${app.collect.base-url}") String baseUrl,
                            @Value("${app.collect.min-delay-ms}") long minDelayMs,
                            @Value("${app.collect.max-delay-ms}") long maxDelayMs,
                            @Value("${app.collect.max-retries}") int maxRetries,
                            @Value("${app.collect.base-backoff-ms}") long baseBackoffMs,
                            @Value("${app.collect.cap-backoff-ms}") long capBackoffMs,
                            @Value("${app.collect.request-timeout-ms}") long requestTimeoutMs,
                            @Value("${app.collect.headless}") boolean headless,
                            @Value("${app.collect.query-size}") int querySize) {
        this.querySize = querySize;
        this.headless = headless;
        this.sessionStore = sessionStore;
        this.sessionFactory = sessionFactory;
        this.parser = parser;
        this.refererPage = statUrl;
        this.baseUrl = baseUrl;
        this.minDelayMs = minDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.maxRetries = maxRetries;
        this.baseBackoffMs = baseBackoffMs;
        this.capBackoffMs = capBackoffMs;
        this.requestTimeoutMs = requestTimeoutMs;
    }

    /** from~to(양끝 포함)를 날짜 순으로 수집한다. 날짜 사이에는 2~5초 지연을 둔다. */
    public List<RefererDay> collect(LocalDate from, LocalDate to) {
        List<RefererDay> result = new ArrayList<>();
        collect(from, to, result::add);
        return result;
    }

    /**
     * 날짜 하나를 받을 때마다 onDay를 바로 호출한다. 중간에 실패해도 이미 받은 날짜는 처리된 상태로 남는다.
     */
    public void collect(LocalDate from, LocalDate to, Consumer<RefererDay> onDay) {
        if (from.isAfter(to)) {
            throw new IllegalArgumentException("from이 to보다 늦습니다: " + from + " > " + to);
        }

        try (Playwright playwright = Playwright.create();
             BrowserContext context = sessionFactory.open(playwright, headless)) {

            // persistent profile만으로는 네이버 로그인이 유지되지 않아, 로그인 때 저장한 쿠키를 복원한다.
            if (sessionStore.restore(context) == 0) {
                throw new SessionExpiredException(
                        "저장된 로그인 쿠키가 없습니다. `--app.mode=login`으로 먼저 로그인하세요.");
            }

            APIRequestContext api = context.request();
            boolean first = true;
            for (LocalDate date = from; !date.isAfter(to); date = date.plusDays(1)) {
                if (!first) {
                    sleep(ThreadLocalRandom.current().nextLong(minDelayMs, maxDelayMs + 1));
                }
                first = false;
                onDay.accept(fetchDay(api, date));
            }
            // 서버가 갱신해 준 쿠키가 있으면 다음 실행에서도 쓰도록 되저장한다.
            sessionStore.save(context);
        }
    }

    private RefererDay fetchDay(APIRequestContext api, LocalDate date) {
        String url = baseUrl + API_PATH
                + "?timeDimension=DATE&additionalTimeDimension=WEEK"
                + "&startDate=" + date
                + "&exclude=weekAndMonthAnalysis"
                + "&_=" + nonce();

        RefererDay day = parser.parse(fetchBody(api, url, date.toString()), date);
        if (day.today()) {
            return day; // 집계 중인 오늘 데이터는 저장하지 않으므로 검색어도 가져오지 않는다.
        }
        return day.withQueries(fetchQueries(api, day));
    }

    /**
     * 검색 유입처(searchEngine=true)마다 하위 검색어를 가져온다.
     * 한 유입처의 검색어를 못 가져와도 그 날의 나머지 데이터는 살린다(세션 만료는 예외로 그대로 중단).
     */
    private List<SearchQueryRow> fetchQueries(APIRequestContext api, RefererDay day) {
        List<SearchQueryRow> all = new ArrayList<>();
        for (RefererRow row : day.rows()) {
            if (!row.searchEngine()) {
                continue;
            }
            sleep(ThreadLocalRandom.current().nextLong(minDelayMs, maxDelayMs + 1));
            String label = day.date() + " " + row.referrer() + " 검색어";
            try {
                String url = detailUrl(baseUrl, day.date(), row.referrer(), querySize, nonce());
                List<SearchQueryRow> queries = parser.parseQueries(fetchBody(api, url, label), day.date(), row.referrer());
                int sum = queries.stream().mapToInt(SearchQueryRow::visits).sum();
                if (sum != row.visits()) {
                    System.out.println("[경고] " + label + " 합계 " + sum + " != 유입처 방문수 " + row.visits()
                            + " (상한 size=" + querySize + " 때문에 일부만 왔을 수 있음)");
                }
                all.addAll(queries);
            } catch (IllegalStateException | RefererParseException e) {
                if (Thread.currentThread().isInterrupted()) {
                    throw e;
                }
                System.out.println("[경고] " + label + " 수집 실패, 이 유입처의 검색어는 건너뜁니다: " + e.getMessage());
            }
        }
        return all;
    }

    /** 검색 유입처 하나의 하위 항목(검색어) API 주소. 공백은 화면과 같이 %20으로 인코딩한다. */
    static String detailUrl(String baseUrl, LocalDate date, String referrer, int size, String nonce) {
        String encoded = URLEncoder.encode(referrer, StandardCharsets.UTF_8).replace("+", "%20");
        return baseUrl + API_PATH + "/detail"
                + "?timeDimension=DATE&additionalTimeDimension=WEEK"
                + "&startDate=" + date
                + "&searchEngine=1"
                + "&refererDomain=" + encoded
                + "&size=" + size
                + "&exclude="
                + "&_=" + nonce;
    }

    private static String nonce() {
        return System.currentTimeMillis() + "_" + ThreadLocalRandom.current().nextInt(10_000);
    }

    /** 재시도 정책(타임아웃/429/5xx 백오프, 401/403은 세션 만료)을 적용해 GET하고 본문을 돌려준다. */
    private String fetchBody(APIRequestContext api, String url, String label) {
        for (int attempt = 0; ; attempt++) {
            long retryAfterMs = -1;
            String failure;
            try {
                APIResponse response = api.get(url, RequestOptions.create()
                        .setTimeout(requestTimeoutMs)
                        .setHeader("Accept", "application/json")
                        .setHeader("Referer", refererPage));
                int status = response.status();

                if (status == 200) {
                    return response.text();
                }
                if (status == 401 || status == 403) {
                    // 재시도해도 소용없다. 세션을 다시 만들어야 한다.
                    throw new SessionExpiredException(
                            "세션이 만료되었습니다(HTTP " + status + "). 다시 로그인하세요.");
                }
                if (status == 429) {
                    retryAfterMs = parseRetryAfterMs(response.headers().get("retry-after"));
                    failure = "HTTP 429";
                } else if (status == 502 || status == 503 || status == 504) {
                    failure = "HTTP " + status;
                } else {
                    // 400/404 등은 재시도 대상이 아니다.
                    throw new IllegalStateException(label + " 수집 실패: HTTP " + status);
                }
            } catch (SessionExpiredException | RefererParseException | IllegalStateException e) {
                throw e;
            } catch (PlaywrightException e) {
                failure = "타임아웃/네트워크 오류: " + firstLine(e.getMessage());
            }

            if (attempt >= maxRetries) {
                throw new IllegalStateException(
                        label + " 수집 실패: 재시도 " + maxRetries + "회 소진 (" + failure + ")");
            }
            long delay = retryAfterMs >= 0
                    ? Math.min(retryAfterMs, capBackoffMs)
                    : Backoff.delayMillis(attempt, baseBackoffMs, capBackoffMs, ThreadLocalRandom.current().nextDouble());
            System.out.println("[재시도] " + label + " " + failure + " → " + delay + "ms 후 재시도 ("
                    + (attempt + 1) + "/" + maxRetries + ")");
            sleep(delay);
        }
    }

    /** Retry-After는 초 단위 숫자인 경우만 처리한다. 날짜 형식이나 없음이면 -1(백오프 공식 사용). */
    static long parseRetryAfterMs(String header) {
        if (header == null) {
            return -1;
        }
        try {
            return Long.parseLong(header.trim()) * 1000;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String firstLine(String message) {
        if (message == null) {
            return "";
        }
        int idx = message.indexOf('\n');
        return idx < 0 ? message : message.substring(0, idx);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("수집 중 인터럽트", e);
        }
    }
}
