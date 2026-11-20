package com.example.blogstat.domain;

import com.example.blogstat.collector.RefererDay;
import com.example.blogstat.collector.RefererRow;
import com.example.blogstat.collector.SearchQueryRow;
import com.example.blogstat.config.ClockConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.Import;

import java.time.LocalDate;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DataJpaTest
@Import({ReferrerDailyService.class, ClockConfig.class})
class SearchQueryStorageTest {

    private static final LocalDate D1 = LocalDate.of(2026, 1, 2);
    private static final LocalDate D2 = LocalDate.of(2026, 1, 3);
    private static final String ENGINE = "검색엔진A";

    @Autowired
    ReferrerDailyService service;

    @Autowired
    SearchQueryDailyRepository queryRepository;

    private static SearchQueryRow q(LocalDate date, String referrer, String query, int visits) {
        return new SearchQueryRow(date, referrer, query, visits, 0);
    }

    private static RefererDay day(LocalDate date, boolean today, SearchQueryRow... queries) {
        List<RefererRow> rows = List.of(new RefererRow(date, ENGINE, true, 10, 100));
        return new RefererDay(date, rows, 10, today).withQueries(List.of(queries));
    }

    @Test
    void 유입경로와_함께_검색어도_저장된다() {
        service.save(day(D1, false, q(D1, ENGINE, "검색어1", 6), q(D1, ENGINE, "검색어2", 4)));

        assertEquals(2, service.countQueries(D1));
    }

    @Test
    void 재수집하면_검색어도_교체되고_사라진_검색어는_정리된다() {
        service.save(day(D1, false, q(D1, ENGINE, "A", 6), q(D1, ENGINE, "B", 4)));
        service.save(day(D1, false, q(D1, ENGINE, "A", 7), q(D1, ENGINE, "C", 3)));

        List<SearchQueryDaily> rows = queryRepository.findByStatDateBetween(D1, D1);
        assertEquals(2, rows.size());
        assertTrue(rows.stream().anyMatch(r -> r.getSearchQuery().equals("A") && r.getVisits() == 7));
        assertTrue(rows.stream().noneMatch(r -> r.getSearchQuery().equals("B")));
    }

    @Test
    void 같은_검색어를_여러_번_저장해도_중복되지_않는다() {
        RefererDay d = day(D1, false, q(D1, ENGINE, "A", 6));
        service.save(d);
        service.save(d);

        assertEquals(1, service.countQueries(D1));
    }

    @Test
    void 같은_유입처의_같은_검색어가_두_번_오면_합쳐서_저장한다() {
        service.save(day(D1, false, q(D1, ENGINE, "A", 3), q(D1, ENGINE, "A", 2), q(D1, ENGINE, "B", 1)));

        List<SearchQueryDaily> rows = queryRepository.findByStatDateBetween(D1, D1);
        assertEquals(2, rows.size());
        assertEquals(5, rows.stream().filter(r -> r.getSearchQuery().equals("A")).findFirst().orElseThrow().getVisits());
    }

    @Test
    void 같은_검색어라도_유입처가_다르면_따로_저장한다() {
        service.save(day(D1, false, q(D1, "엔진A", "A", 3), q(D1, "엔진B", "A", 2)));

        assertEquals(2, service.countQueries(D1));
    }

    @Test
    void 다른_날짜의_검색어는_건드리지_않는다() {
        service.save(day(D1, false, q(D1, ENGINE, "A", 6)));
        service.save(day(D2, false, q(D2, ENGINE, "A", 1)));
        service.save(day(D1, false, q(D1, ENGINE, "A", 9)));

        assertEquals(1, service.countQueries(D2));
        assertEquals(1, queryRepository.findByStatDateBetween(D2, D2).get(0).getVisits());
    }

    @Test
    void 오늘_데이터는_검색어도_저장하지_않는다() {
        service.save(day(D1, true, q(D1, ENGINE, "A", 6)));

        assertEquals(0, service.countQueries(D1));
    }

    // ---- 검색어만 따로 저장 ----

    @Autowired
    ReferrerDailyRepository referrerRepository;

    @Test
    void 검색어만_저장하면_유입경로는_건드리지_않는다() {
        service.save(day(D1, false, q(D1, ENGINE, "옛 검색어", 6)));

        int saved = service.saveQueries(day(D1, false, q(D1, ENGINE, "새 검색어", 10)));

        assertEquals(1, saved);
        assertEquals(1, referrerRepository.countByStatDate(D1)); // 유입경로 행은 그대로
        List<SearchQueryDaily> rows = queryRepository.findByStatDateBetween(D1, D1);
        assertEquals(1, rows.size());
        assertEquals("새 검색어", rows.get(0).getSearchQuery()); // 검색어는 교체됨
    }

    @Test
    void 검색어만_저장해도_다른_날짜는_그대로다() {
        service.save(day(D2, false, q(D2, ENGINE, "다른 날", 1)));

        service.saveQueries(day(D1, false, q(D1, ENGINE, "A", 5)));

        assertEquals(1, service.countQueries(D2));
    }

    @Test
    void 검색어만_저장도_같은_입력을_두_번_넣어도_중복되지_않는다() {
        RefererDay d = day(D1, false, q(D1, ENGINE, "A", 5));
        service.saveQueries(d);
        service.saveQueries(d);

        assertEquals(1, service.countQueries(D1));
    }

    @Test
    void 검색어만_저장도_오늘_데이터는_건너뛴다() {
        assertEquals(-1, service.saveQueries(day(D1, true, q(D1, ENGINE, "A", 5))));
        assertEquals(0, service.countQueries(D1));
    }

    @Test
    void 검색어가_저장된_날짜만_골라낸다() {
        service.saveQueries(day(D1, false, q(D1, ENGINE, "A", 5)));
        service.saveQueries(day(D2, false)); // 검색어 없는 날

        assertEquals(java.util.Set.of(D1), service.datesWithQueries(D1, D2));
    }

    @Test
    void 검색어가_없는_날도_정상_저장된다() {
        int saved = service.save(day(D1, false));

        assertEquals(1, saved);
        assertEquals(0, service.countQueries(D1));
    }
}
