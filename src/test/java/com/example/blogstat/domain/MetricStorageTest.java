package com.example.blogstat.domain;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.Import;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DataJpaTest
@Import(MetricService.class)
class MetricStorageTest {

    private static final LocalDate D1 = LocalDate.of(2026, 11, 18);
    private static final LocalDate D2 = LocalDate.of(2026, 11, 19);
    private static final LocalDateTime NOW = LocalDateTime.of(2026, 11, 21, 9, 0);

    @Autowired
    MetricService service;

    @Autowired
    MetricRowRepository repository;

    private static MetricRow row(LocalDate date, String metric, String key, String payload) {
        return new MetricRow(date, metric, key, payload, NOW);
    }

    @Test
    void 저장하면_행_수를_돌려준다() {
        int saved = service.replace("HOUR", List.of(row(D1, "HOUR", "00", "{\"cv\":1}"), row(D1, "HOUR", "01", "{\"cv\":2}")));

        assertEquals(2, saved);
        assertEquals(2, repository.count());
    }

    @Test
    void 같은_날짜를_다시_저장하면_교체되고_사라진_행은_정리된다() {
        service.replace("HOUR", List.of(row(D1, "HOUR", "00", "{\"cv\":1}"), row(D1, "HOUR", "01", "{\"cv\":2}")));

        service.replace("HOUR", List.of(row(D1, "HOUR", "00", "{\"cv\":9}")));

        List<MetricRow> rows = repository.findByStatDateBetweenOrderByStatDateAscMetricAscIdAsc(D1, D1);
        assertEquals(1, rows.size());
        assertEquals("{\"cv\":9}", rows.get(0).getPayload());
    }

    @Test
    void 다른_날짜와_다른_지표는_건드리지_않는다() {
        service.replace("HOUR", List.of(row(D1, "HOUR", "00", "{}"), row(D2, "HOUR", "00", "{}")));
        service.replace("DEMO", List.of(row(D1, "DEMO", "total", "{}")));

        service.replace("HOUR", List.of(row(D1, "HOUR", "00", "{\"cv\":5}")));

        assertEquals(3, repository.count());
        assertEquals(Set.of(D1, D2), service.datesWith("HOUR", D1, D2));
        assertEquals(Set.of(D1), service.datesWith("DEMO", D1, D2));
    }

    @Test
    void 시계열은_여러_날짜를_한_번에_교체한다() {
        service.replace("VISITS", List.of(row(D1, "VISITS", "all", "{\"visit\":1}"), row(D2, "VISITS", "all", "{\"visit\":2}")));

        service.replace("VISITS", List.of(row(D1, "VISITS", "all", "{\"visit\":10}"), row(D2, "VISITS", "all", "{\"visit\":20}")));

        assertEquals(2, repository.count());
        assertTrue(repository.findAll().stream().anyMatch(r -> r.getPayload().equals("{\"visit\":20}")));
    }

    @Test
    void 빈_표시는_저장_행_수에_세지_않지만_받은_날짜로_인정된다() {
        int saved = service.replace("RANK_LIKE", List.of(row(D1, "RANK_LIKE", MetricRow.EMPTY_KEY, "{}")));

        assertEquals(0, saved);
        assertEquals(Set.of(D1), service.datesWith("RANK_LIKE", D1, D2));
        // 현황 집계에는 빈 표시를 넣지 않는다.
        assertTrue(service.summary().isEmpty());
    }

    @Test
    void 다른_지표의_행이_섞이면_저장하지_않는다() {
        assertThrows(IllegalArgumentException.class,
                () -> service.replace("HOUR", List.of(row(D1, "DEMO", "total", "{}"))));
        assertEquals(0, repository.count());
    }

    @Test
    void 가장_최근_저장일과_지표별_현황을_돌려준다() {
        service.replace("HOUR", List.of(row(D1, "HOUR", "00", "{}"), row(D2, "HOUR", "00", "{}")));

        assertEquals(D2, service.latestDate().orElseThrow());
        MetricRowRepository.MetricSummary s = service.summary().iterator().next();
        assertEquals("HOUR", s.getMetric());
        assertEquals(2L, s.getRows());
        assertEquals(D1, s.getFirstDate());
        assertEquals(D2, s.getLastDate());
    }
}
