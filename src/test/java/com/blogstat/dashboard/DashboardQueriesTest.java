package com.blogstat.dashboard;

import com.blogstat.dashboard.DashboardService.Period;
import com.blogstat.dashboard.DashboardService.QueryReport;
import com.blogstat.domain.SearchQueryDaily;
import com.blogstat.domain.SearchQueryDailyRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DataJpaTest
@Import({DashboardService.class, DashboardQueriesTest.FixedClock.class})
class DashboardQueriesTest {

    private static final LocalDate D1 = LocalDate.of(2026, 1, 2);
    private static final LocalDate D2 = LocalDate.of(2026, 1, 3);
    private static final LocalDate D3 = LocalDate.of(2026, 1, 4);
    private static final LocalDateTime NOW = LocalDateTime.of(2026, 1, 5, 3, 0);

    @TestConfiguration
    static class FixedClock {
        @Bean
        Clock clock() {
            return Clock.fixed(Instant.parse("2026-01-05T00:00:00Z"), ZoneId.of("Asia/Seoul"));
        }
    }

    @Autowired
    DashboardService service;

    @Autowired
    SearchQueryDailyRepository repository;

    private void q(LocalDate date, String referrer, String query, int visits) {
        repository.save(new SearchQueryDaily(date, referrer, query, visits, 0, NOW));
    }

    @Test
    void 같은_검색어는_날짜와_유입처를_넘어_합산한다() {
        q(D1, "통합검색", "팝업", 3);
        q(D2, "통합검색", "팝업", 2);
        q(D2, "블로그검색", "팝업", 1);

        QueryReport report = service.queries(new Period(D1, D3), 100);

        assertEquals(1, report.items().size());
        assertEquals(6, report.items().get(0).visits());
        assertEquals(2, report.items().get(0).days());
    }

    @Test
    void 방문_많은_순이고_같으면_가나다순이다() {
        q(D1, "통합검색", "나", 2);
        q(D1, "통합검색", "가", 2);
        q(D1, "통합검색", "다", 5);

        List<String> order = service.queries(new Period(D1, D1), 100).items().stream()
                .map(DashboardService.QueryShare::query).toList();

        assertEquals(List.of("다", "가", "나"), order);
    }

    @Test
    void 유입처는_방문_많은_순으로_나열한다() {
        q(D1, "적은곳", "팝업", 1);
        q(D1, "많은곳", "팝업", 5);

        List<String> sources = service.queries(new Period(D1, D1), 100).items().get(0).sources();

        assertEquals(List.of("많은곳", "적은곳"), sources);
    }

    @Test
    void 기간_밖의_검색어는_제외한다() {
        q(D1, "통합검색", "범위밖", 9);
        q(D2, "통합검색", "범위안", 1);

        QueryReport report = service.queries(new Period(D2, D3), 100);

        assertEquals(List.of("범위안"), report.items().stream().map(DashboardService.QueryShare::query).toList());
    }

    @Test
    void limit보다_많으면_자르고_truncated를_알린다() {
        q(D1, "통합검색", "a", 3);
        q(D1, "통합검색", "b", 2);
        q(D1, "통합검색", "c", 1);

        QueryReport report = service.queries(new Period(D1, D1), 2);

        assertEquals(2, report.items().size());
        assertEquals(3, report.distinctQueries());
        assertEquals(6, report.totalVisits());
        assertTrue(report.truncated());
    }

    @Test
    void limit이_충분하면_truncated가_아니다() {
        q(D1, "통합검색", "a", 3);

        assertFalse(service.queries(new Period(D1, D1), 10).truncated());
    }

    @Test
    void 검색어가_없으면_빈_목록() {
        QueryReport report = service.queries(new Period(D1, D3), 100);

        assertEquals(0, report.distinctQueries());
        assertTrue(report.items().isEmpty());
    }

    @Test
    void limit은_1_이상_최대치_이하로_보정된다() {
        q(D1, "통합검색", "a", 3);
        q(D1, "통합검색", "b", 2);

        assertEquals(1, service.queries(new Period(D1, D1), 0).items().size());
        assertEquals(2, service.queries(new Period(D1, D1), 1_000_000).items().size());
    }
}
