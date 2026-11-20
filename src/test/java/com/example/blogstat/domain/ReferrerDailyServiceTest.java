package com.example.blogstat.domain;

import com.example.blogstat.collector.RefererDay;
import com.example.blogstat.collector.RefererRow;
import com.example.blogstat.config.ClockConfig;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DataJpaTest
@Import({ReferrerDailyService.class, ClockConfig.class})
class ReferrerDailyServiceTest {

    private static final LocalDate D1 = LocalDate.of(2026, 1, 2);
    private static final LocalDate D2 = LocalDate.of(2026, 1, 3);

    @Autowired
    ReferrerDailyService service;

    @Autowired
    ReferrerDailyRepository repository;

    private static RefererDay day(LocalDate date, boolean today, Object... nameVisitsPairs) {
        List<RefererRow> rows = new java.util.ArrayList<>();
        int sum = 0;
        for (int i = 0; i < nameVisitsPairs.length; i += 2) {
            int visits = (int) nameVisitsPairs[i + 1];
            sum += visits;
            rows.add(new RefererRow(date, (String) nameVisitsPairs[i], false, visits, 0));
        }
        return new RefererDay(date, rows, sum, today);
    }

    @Test
    void 저장하면_행이_들어간다() {
        int saved = service.save(day(D1, false, "A", 60, "B", 40));

        assertEquals(2, saved);
        List<ReferrerDaily> rows = repository.findByStatDateOrderByVisitsDesc(D1);
        assertEquals("A", rows.get(0).getReferrerName());
        assertEquals(60, rows.get(0).getVisits());
    }

    @Test
    void 같은_날짜를_다시_저장해도_중복되지_않는다() {
        service.save(day(D1, false, "A", 60, "B", 40));
        service.save(day(D1, false, "A", 60, "B", 40));

        assertEquals(2, repository.countByStatDate(D1));
    }

    @Test
    void 재수집하면_값이_갱신되고_사라진_유입경로는_정리된다() {
        service.save(day(D1, false, "A", 60, "B", 40));
        service.save(day(D1, false, "A", 70, "C", 5));

        List<ReferrerDaily> rows = repository.findByStatDateOrderByVisitsDesc(D1);
        assertEquals(2, rows.size());
        assertEquals("A", rows.get(0).getReferrerName());
        assertEquals(70, rows.get(0).getVisits());
        assertTrue(rows.stream().noneMatch(r -> r.getReferrerName().equals("B")));
    }

    @Test
    void 다른_날짜_데이터는_건드리지_않는다() {
        service.save(day(D1, false, "A", 60));
        service.save(day(D2, false, "A", 10));
        service.save(day(D1, false, "A", 61));

        assertEquals(1, repository.countByStatDate(D2));
        assertEquals(10, repository.findByStatDateOrderByVisitsDesc(D2).get(0).getVisits());
    }

    @Test
    void 집계_중인_오늘_데이터는_저장하지_않는다() {
        int saved = service.save(day(D1, true, "A", 60));

        assertEquals(-1, saved);
        assertEquals(0, repository.countByStatDate(D1));
    }

    @Test
    void 같은_날짜_같은_유입경로를_직접_두_번_넣으면_유니크_제약_위반() {
        repository.saveAndFlush(new ReferrerDaily(D1, "A", 1, 1.0, false, LocalDateTime.now()));

        assertThrows(DataIntegrityViolationException.class,
                () -> repository.saveAndFlush(new ReferrerDaily(D1, "A", 2, 2.0, false, LocalDateTime.now())));
    }
}
