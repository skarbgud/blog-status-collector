package com.blogstat.dashboard;

import com.blogstat.dashboard.DashboardService.DailyPoint;
import com.blogstat.dashboard.DashboardService.Period;
import com.blogstat.dashboard.DashboardService.ReferrerShare;
import com.blogstat.dashboard.DashboardService.Summary;
import com.blogstat.domain.ReferrerDaily;
import com.blogstat.domain.ReferrerDailyRepository;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

@DataJpaTest
@Import({DashboardService.class, DashboardServiceTest.FixedClock.class})
class DashboardServiceTest {

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
    ReferrerDailyRepository repository;

    @Autowired
    SearchQueryDailyRepository queryRepository;

    private void row(LocalDate date, String name, boolean search, int visits) {
        repository.save(new ReferrerDaily(date, name, visits, 0, search, NOW));
    }

    private void seed() {
        row(D1, "naver", true, 60);
        row(D1, "direct", false, 40);
        row(D2, "naver", true, 30);
        // D3은 일부러 비워 둔다(수집 안 된 날)
    }

    @Test
    void 요약은_합계와_검색비율을_계산한다() {
        seed();

        Summary s = service.summary(new Period(D1, D3));

        assertEquals(130, s.totalVisits());
        assertEquals(90, s.searchVisits());
        assertEquals(90 * 100.0 / 130, s.searchRatio(), 1e-9);
        assertEquals(2, s.collectedDays());
        assertEquals(3, s.totalDays());
        assertEquals(D2, s.latestDate());
    }

    @Test
    void 일별_추이는_빈_날짜를_null로_채운다() {
        seed();

        List<DailyPoint> points = service.daily(new Period(D1, D3));

        assertEquals(3, points.size());
        assertEquals(100L, points.get(0).visits());
        assertEquals(60L, points.get(0).searchVisits());
        assertEquals(30L, points.get(1).visits());
        assertNull(points.get(2).visits());
    }

    @Test
    void 유입처는_방문_많은_순이고_개수를_제한한다() {
        seed();

        List<ReferrerShare> all = service.referrers(new Period(D1, D3), 10);
        assertEquals("naver", all.get(0).name());
        assertEquals(90, all.get(0).visits());
        assertEquals(true, all.get(0).searchEngine());
        assertEquals("direct", all.get(1).name());

        assertEquals(1, service.referrers(new Period(D1, D3), 1).size());
        // 0이나 음수 limit도 최소 1개로 보정된다
        assertEquals(1, service.referrers(new Period(D1, D3), 0).size());
    }

    @Test
    void 데이터가_없으면_0과_빈_목록을_돌려준다() {
        Summary s = service.summary(new Period(D1, D3));

        assertEquals(0, s.totalVisits());
        assertEquals(0, s.searchRatio());
        assertEquals(0, s.collectedDays());
        assertNull(s.latestDate());
        assertEquals(0, service.referrers(new Period(D1, D3), 10).size());
    }

    @Test
    void 기간을_생략하면_최근_저장일_기준_30일이다() {
        seed();

        Period p = service.resolve(null, null);

        assertEquals(D2, p.to());
        assertEquals(D2.minusDays(29), p.from());
    }

    @Test
    void 저장된_데이터가_없으면_어제를_기준으로_한다() {
        Period p = service.resolve(null, null);

        assertEquals(LocalDate.of(2026, 1, 4), p.to());
    }

    @Test
    void 잘못된_기간은_거부한다() {
        assertThrows(IllegalArgumentException.class, () -> service.resolve(D2, D1));
        assertThrows(IllegalArgumentException.class, () -> service.resolve(D1.minusYears(2), D1));
    }

    @Test
    void 검색어는_실제로_들어온_날짜를_오름차순으로_돌려준다() {
        LocalDateTime collected = LocalDateTime.of(2026, 1, 5, 3, 10);
        queryRepository.save(new SearchQueryDaily(D2, "naver", "팝업", 2, 0, collected));
        queryRepository.save(new SearchQueryDaily(D1, "naver", "팝업", 3, 0, collected));
        queryRepository.save(new SearchQueryDaily(D1, "naver", "후기", 1, 0, collected));

        var report = service.queries(new Period(D1, D3), 10);

        assertEquals(2, report.distinctQueries());
        assertEquals("팝업", report.items().get(0).query());
        assertEquals(5, report.items().get(0).visits());
        assertEquals(List.of(D1, D2), report.items().get(0).dates());
        assertEquals(List.of(D1), report.items().get(1).dates());
    }
}
