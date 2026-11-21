package com.blogstat.collector.source;

import com.blogstat.collector.RefererDay;
import com.blogstat.collector.RefererParser;
import com.blogstat.collector.SessionExpiredException;
import com.blogstat.collector.core.BudgetExceededException;
import com.blogstat.collector.core.StatHttp;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 합성 픽스처(referer-sample.json, referer-detail-sample.json)로 소스의 요청 순서와 결과를 고정한다. */
class RefererSourceTest {

    private static final LocalDate DATE = LocalDate.of(2026, 1, 2);
    private static final String BASE = "https://stat.example";

    private final RefererSource source = new RefererSource(new RefererParser(), BASE, 100, () -> "n");
    private final List<String> urls = new ArrayList<>();

    private static String resource(String name) {
        try (InputStream in = RefererSourceTest.class.getResourceAsStream(name)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private StatHttp http(String total, StatHttp detail) {
        return (url, label) -> {
            urls.add(url);
            return url.contains("/detail?") ? detail.get(url, label) : total;
        };
    }

    @Test
    void 합계를_받고_검색_유입처마다_검색어를_요청한다() {
        String detail = resource("/referer-detail-sample.json");
        RefererDay day = source.fetch(http(resource("/referer-sample.json"), (u, l) -> detail), DATE);

        // 픽스처의 검색 유입처는 1개 → 합계 1회 + 검색어 1회
        assertEquals(2, urls.size());
        assertEquals(RefererSource.totalUrl(BASE, DATE, "n"), urls.get(0));
        assertTrue(urls.get(1).startsWith(BASE + "/api/blog/daily/referer/total/detail?"));

        assertEquals(3, day.rows().size());
        assertEquals(100, day.sumVisits());
        assertEquals(3, day.queries().size());
        String searchReferrer = day.rows().stream().filter(r -> r.searchEngine()).findFirst().orElseThrow().referrer();
        assertTrue(day.queries().stream().allMatch(q -> q.referrer().equals(searchReferrer)));
    }

    @Test
    void 오늘_데이터면_검색어를_요청하지_않는다() {
        String today = resource("/referer-sample.json").replace("\"isToday\": false", "\"isToday\": true");

        RefererDay day = source.fetch(http(today, (u, l) -> {
            throw new AssertionError("검색어를 요청하면 안 된다");
        }), DATE);

        assertTrue(day.today());
        assertEquals(1, urls.size());
        assertTrue(day.queries().isEmpty());
    }

    @Test
    void 검색어_요청이_실패해도_그날의_유입경로는_살린다() {
        RefererDay day = source.fetch(http(resource("/referer-sample.json"), (u, l) -> {
            throw new IllegalStateException(l + " 수집 실패: HTTP 500");
        }), DATE);

        assertEquals(3, day.rows().size());
        assertTrue(day.queries().isEmpty());
    }

    @Test
    void 세션_만료와_예산_소진은_건너뛰지_않고_그대로_멈춘다() {
        String total = resource("/referer-sample.json");

        assertThrows(SessionExpiredException.class, () -> source.fetch(http(total, (u, l) -> {
            throw new SessionExpiredException("만료");
        }), DATE));
        assertThrows(BudgetExceededException.class, () -> source.fetch(http(total, (u, l) -> {
            throw new BudgetExceededException("예산");
        }), DATE));
    }

    @Test
    void 식별자는_고정이다() {
        assertEquals("REFERER", source.id());
        assertFalse(source.id().isBlank());
    }
}
