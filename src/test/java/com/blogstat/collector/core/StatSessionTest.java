package com.blogstat.collector.core;

import com.blogstat.collector.SessionExpiredException;
import org.junit.jupiter.api.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StatSessionTest {

    private static final long MIN = 2000;
    private static final long MAX = 5000;
    private static final long CAP = 30_000;

    /** 정해 둔 응답을 차례로 돌려주고, 받은 URL을 기록한다. */
    private static final class FakeHttp implements RawHttp {
        final Deque<Object> script = new ArrayDeque<>();
        final List<String> urls = new ArrayList<>();

        FakeHttp then(int status) {
            script.add(new RawResponse(status, null, status == 200 ? "body" + script.size() : null));
            return this;
        }

        FakeHttp then429(String retryAfter) {
            script.add(new RawResponse(429, retryAfter, null));
            return this;
        }

        FakeHttp thenTimeout() {
            script.add(new TransportException("Timeout 10000ms exceeded\nstack", null));
            return this;
        }

        @Override
        public RawResponse get(String url) {
            urls.add(url);
            Object next = script.poll();
            if (next instanceof TransportException e) {
                throw e;
            }
            return (RawResponse) next;
        }
    }

    private final List<Long> sleeps = new ArrayList<>();

    private StatSession session(FakeHttp http, int maxRetries, int budget) {
        CollectSettings settings = new CollectSettings("https://stat.example/page", "https://stat.example",
                MIN, MAX, maxRetries, 1000, CAP, 10_000, true, 100, budget);
        // random=0.5 고정: 지연은 MIN + 0.5*(span+1), 백오프는 상한의 절반
        return new StatSession(http, settings, new RequestBudget(budget), sleeps::add, () -> 0.5);
    }

    @Test
    void 첫_요청은_바로_보내고_다음_요청부터_지연을_둔다() {
        FakeHttp http = new FakeHttp().then(200).then(200);
        StatSession s = session(http, 3, 10);

        assertEquals("body0", s.get("u1", "a"));
        assertTrue(sleeps.isEmpty());

        assertEquals("body1", s.get("u2", "b"));
        assertEquals(1, sleeps.size());
        long pace = sleeps.get(0);
        assertTrue(pace >= MIN && pace <= MAX, "지연은 min~max 사이: " + pace);
    }

    @Test
    void 일시_오류는_백오프로_재시도하고_예산에_재시도도_센다() {
        FakeHttp http = new FakeHttp().then(503).thenTimeout().then(200);
        StatSession s = session(http, 3, 10);

        assertEquals("body2", s.get("u", "x"));

        assertEquals(3, http.urls.size());
        assertEquals(3, s.budget().used());
        // 첫 요청이라 지연 없음, 재시도 백오프만 두 번(attempt 0 → 500, attempt 1 → 1000)
        assertEquals(List.of(500L, 1000L), sleeps);
    }

    @Test
    void 요청_429는_RetryAfter를_우선하되_cap을_넘지_않는다() {
        FakeHttp http = new FakeHttp().then429("7").then429("120").then(200);
        StatSession s = session(http, 3, 10);

        s.get("u", "x");

        assertEquals(List.of(7000L, CAP), sleeps);
    }

    @Test
    void 인증_실패는_재시도하지_않고_세션_만료로_멈춘다() {
        FakeHttp http = new FakeHttp().then(401).then(200);
        StatSession s = session(http, 3, 10);

        assertThrows(SessionExpiredException.class, () -> s.get("u", "x"));
        assertEquals(1, http.urls.size());
    }

    @Test
    void 재시도_대상이_아닌_상태코드는_바로_실패한다() {
        FakeHttp http = new FakeHttp().then(404);
        StatSession s = session(http, 3, 10);

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> s.get("u", "x"));
        assertTrue(e.getMessage().contains("HTTP 404"));
        assertEquals(1, http.urls.size());
    }

    @Test
    void 재시도를_다_쓰면_실패한다() {
        FakeHttp http = new FakeHttp().thenTimeout().thenTimeout().thenTimeout();
        StatSession s = session(http, 2, 10);

        IllegalStateException e = assertThrows(IllegalStateException.class, () -> s.get("u", "x"));
        assertTrue(e.getMessage().contains("재시도 2회 소진"));
        assertTrue(e.getMessage().contains("Timeout 10000ms exceeded"));
        assertTrue(!e.getMessage().contains("stack"), "오류 메시지는 첫 줄만 남긴다");
        assertEquals(3, http.urls.size());
    }

    @Test
    void 예산을_넘으면_요청을_보내지_않고_멈춘다() {
        FakeHttp http = new FakeHttp().then(200).then(200).then(200);
        StatSession s = session(http, 3, 2);

        s.get("u1", "a");
        s.get("u2", "b");
        BudgetExceededException e = assertThrows(BudgetExceededException.class, () -> s.get("u3", "c"));

        assertTrue(e.getMessage().contains("c"));
        assertEquals(2, http.urls.size());
    }

    @Test
    void 예산_소진은_재시도_중에도_적용된다() {
        FakeHttp http = new FakeHttp().then(503).then(503).then(200);
        StatSession s = session(http, 3, 2);

        assertThrows(BudgetExceededException.class, () -> s.get("u", "x"));
        assertEquals(2, http.urls.size());
    }
}
