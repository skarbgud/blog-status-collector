package com.example.blogstat.collector.core;

import com.example.blogstat.collector.Backoff;
import com.example.blogstat.collector.SessionExpiredException;

import java.util.function.DoubleSupplier;
import java.util.function.LongConsumer;

/**
 * 한 회차 동안 쓰는 요청 창구. 모든 소스의 요청이 이곳을 지나므로 정책이 한 군데에서 강제된다.
 * <ul>
 *   <li>요청 사이 지연: 회차의 첫 요청을 빼고, 새 요청 앞마다 min~max 사이 무작위로 쉰다(재시도는 백오프로 대신한다)</li>
 *   <li>회차 예산: 재시도를 포함한 실제 요청 수를 {@link RequestBudget}으로 센다</li>
 *   <li>재시도: 타임아웃·429·502/503/504는 지수 백오프 + 풀 지터. 429의 Retry-After(초)를 우선한다</li>
 *   <li>401/403은 재시도 없이 {@link SessionExpiredException}. 그 밖의 상태 코드는 재시도 없이 실패</li>
 * </ul>
 */
public final class StatSession implements StatHttp {

    private final RawHttp http;
    private final CollectSettings settings;
    private final RequestBudget budget;
    private final LongConsumer sleeper;
    private final DoubleSupplier random;
    private boolean first = true;

    public StatSession(RawHttp http, CollectSettings settings, RequestBudget budget,
                       LongConsumer sleeper, DoubleSupplier random) {
        this.http = http;
        this.settings = settings;
        this.budget = budget;
        this.sleeper = sleeper;
        this.random = random;
    }

    public RequestBudget budget() {
        return budget;
    }

    @Override
    public String get(String url, String label) {
        if (!first) {
            sleeper.accept(paceDelay());
        }
        first = false;

        int maxRetries = settings.maxRetries();
        for (int attempt = 0; ; attempt++) {
            budget.acquire(label);
            long retryAfterMs = -1;
            String failure;
            try {
                RawHttp.RawResponse response = http.get(url);
                int status = response.status();
                if (status == 200) {
                    return response.body();
                }
                if (status == 401 || status == 403) {
                    // 재시도해도 소용없다. 세션을 다시 만들어야 한다.
                    throw new SessionExpiredException(
                            "세션이 만료되었습니다(HTTP " + status + "). 다시 로그인하세요.");
                }
                if (status == 429) {
                    retryAfterMs = parseRetryAfterMs(response.retryAfter());
                    failure = "HTTP 429";
                } else if (status == 502 || status == 503 || status == 504) {
                    failure = "HTTP " + status;
                } else {
                    // 400/404 등은 재시도 대상이 아니다.
                    throw new IllegalStateException(label + " 수집 실패: HTTP " + status);
                }
            } catch (RawHttp.TransportException e) {
                failure = "타임아웃/네트워크 오류: " + firstLine(e.getMessage());
            }

            if (attempt >= maxRetries) {
                throw new IllegalStateException(
                        label + " 수집 실패: 재시도 " + maxRetries + "회 소진 (" + failure + ")");
            }
            long delay = retryAfterMs >= 0
                    ? Math.min(retryAfterMs, settings.capBackoffMs())
                    : Backoff.delayMillis(attempt, settings.baseBackoffMs(), settings.capBackoffMs(),
                    random.getAsDouble());
            System.out.println("[재시도] " + label + " " + failure + " → " + delay + "ms 후 재시도 ("
                    + (attempt + 1) + "/" + maxRetries + ")");
            sleeper.accept(delay);
        }
    }

    private long paceDelay() {
        long min = settings.minDelayMs();
        long span = settings.maxDelayMs() - min;
        return min + (long) (random.getAsDouble() * (span + 1));
    }

    /** Retry-After는 초 단위 숫자인 경우만 처리한다. 날짜 형식이나 없음이면 -1(백오프 공식 사용). */
    public static long parseRetryAfterMs(String header) {
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

    /** 실제 대기. 인터럽트되면 플래그를 복원하고 수집을 멈춘다. */
    public static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("수집 중 인터럽트", e);
        }
    }
}
