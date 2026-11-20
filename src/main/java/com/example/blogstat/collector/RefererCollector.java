package com.example.blogstat.collector;

import com.microsoft.playwright.APIRequestContext;
import com.microsoft.playwright.APIResponse;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Playwright;
import com.microsoft.playwright.PlaywrightException;
import com.microsoft.playwright.options.RequestOptions;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 저장된 로그인 세션(persistent context 쿠키)으로 유입경로 API를 날짜별로 호출한다.
 * 브라우저 페이지를 띄우지 않고 context.request()로 직접 호출한다.
 */
@Component
public class RefererCollector {

    private static final String API_PATH = "/api/blog/daily/referer/total";

    private final PlaywrightSessionFactory sessionFactory;
    private final RefererParser parser;
    private final String baseUrl;
    private final String refererPage;
    private final long minDelayMs;
    private final long maxDelayMs;
    private final int maxRetries;
    private final long baseBackoffMs;
    private final long capBackoffMs;
    private final long requestTimeoutMs;

    public RefererCollector(PlaywrightSessionFactory sessionFactory,
                            RefererParser parser,
                            @Value("${app.stat-url}") String statUrl,
                            @Value("${app.collect.base-url}") String baseUrl,
                            @Value("${app.collect.min-delay-ms}") long minDelayMs,
                            @Value("${app.collect.max-delay-ms}") long maxDelayMs,
                            @Value("${app.collect.max-retries}") int maxRetries,
                            @Value("${app.collect.base-backoff-ms}") long baseBackoffMs,
                            @Value("${app.collect.cap-backoff-ms}") long capBackoffMs,
                            @Value("${app.collect.request-timeout-ms}") long requestTimeoutMs) {
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
        if (from.isAfter(to)) {
            throw new IllegalArgumentException("from이 to보다 늦습니다: " + from + " > " + to);
        }

        try (Playwright playwright = Playwright.create();
             BrowserContext context = sessionFactory.open(playwright, true)) {

            if (!LoginSupport.hasSession(context)) {
                throw new SessionExpiredException(
                        "저장된 로그인 세션이 없습니다. `--app.mode=login`으로 먼저 로그인하세요.");
            }

            APIRequestContext api = context.request();
            List<RefererDay> result = new ArrayList<>();
            for (LocalDate date = from; !date.isAfter(to); date = date.plusDays(1)) {
                if (!result.isEmpty()) {
                    sleep(ThreadLocalRandom.current().nextLong(minDelayMs, maxDelayMs + 1));
                }
                result.add(fetchDay(api, date));
            }
            return result;
        }
    }

    private RefererDay fetchDay(APIRequestContext api, LocalDate date) {
        String url = baseUrl + API_PATH
                + "?timeDimension=DATE&additionalTimeDimension=WEEK"
                + "&startDate=" + date
                + "&exclude=weekAndMonthAnalysis"
                + "&_=" + System.currentTimeMillis() + "_" + ThreadLocalRandom.current().nextInt(10_000);

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
                    return parser.parse(response.text(), date);
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
                    throw new IllegalStateException(date + " 수집 실패: HTTP " + status);
                }
            } catch (SessionExpiredException | RefererParseException | IllegalStateException e) {
                throw e;
            } catch (PlaywrightException e) {
                failure = "타임아웃/네트워크 오류: " + firstLine(e.getMessage());
            }

            if (attempt >= maxRetries) {
                throw new IllegalStateException(
                        date + " 수집 실패: 재시도 " + maxRetries + "회 소진 (" + failure + ")");
            }
            long delay = retryAfterMs >= 0
                    ? Math.min(retryAfterMs, capBackoffMs)
                    : Backoff.delayMillis(attempt, baseBackoffMs, capBackoffMs, ThreadLocalRandom.current().nextDouble());
            System.out.println("[재시도] " + date + " " + failure + " → " + delay + "ms 후 재시도 ("
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
