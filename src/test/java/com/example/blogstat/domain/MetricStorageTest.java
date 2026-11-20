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
    void 행_구분을_주면_같은_날짜의_다른_행_구분은_지우지_않는다() {
        service.replace("ARTICLE_CV", List.of(row(D1, "ARTICLE_CV", "111", "{\"cv\":1}")), "111");
        service.replace("ARTICLE_CV", List.of(row(D1, "ARTICLE_CV", "222", "{\"cv\":2}")), "222");

        service.replace("ARTICLE_CV", List.of(row(D1, "ARTICLE_CV", "111", "{\"cv\":9}")), "111");

        List<MetricRow> rows = repository.findByStatDateBetweenOrderByStatDateAscMetricAscIdAsc(D1, D1);
        assertEquals(2, rows.size());
        assertEquals(Set.of("111", "222"), service.keysWith("ARTICLE_CV", D1));
        assertTrue(rows.stream().anyMatch(r -> r.getRowKey().equals("111") && r.getPayload().equals("{\"cv\":9}")));
        assertTrue(rows.stream().anyMatch(r -> r.getRowKey().equals("222") && r.getPayload().equals("{\"cv\":2}")));
    }

    @Test
    void 순위에_나온_게시글_번호를_모은다() {
        service.replace("RANK_POST", List.of(
                row(D1, "RANK_POST", "r001", "{\"title\":\"a\",\"uri\":\"http://blog.naver.com/me/224476308011\"}"),
                row(D1, "RANK_POST", "r002", "{\"title\":\"b\",\"uri\":\"http://blog.naver.com/me/224440800651\"}")));
        service.replace("RANK_LIKE", List.of(
                row(D2, "RANK_LIKE", "r001", "{\"uri\":\"http://blog.naver.com/me/224476308011\"}"),
                row(D2, "RANK_LIKE", "r002", "{\"uri\":\"http://example.com/x/999\"}")));
        service.replace("HOUR", List.of(row(D2, "HOUR", "00", "{\"uri\":\"http://blog.naver.com/me/1\"}")));

        // 다른 지표(HOUR)와 네이버 블로그가 아닌 주소는 넣지 않는다.
        assertEquals(Set.of("224476308011", "224440800651"), service.postIds(D1, D2));
        assertEquals(Set.of("224476308011", "224440800651"), service.postIds(D1, D1));
        assertEquals(Set.of("224476308011"), service.postIds(D2, D2));
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
