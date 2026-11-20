package com.example.blogstat.schedule;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class CatchUpPlannerTest {

    private static final LocalDate YESTERDAY = LocalDate.of(2026, 11, 19);

    @Test
    void 저장된_데이터가_없으면_어제_하루만_수집한다() {
        Optional<CatchUpPlanner.Range> range = CatchUpPlanner.plan(null, YESTERDAY, 7);

        assertEquals(new CatchUpPlanner.Range(YESTERDAY, YESTERDAY), range.orElseThrow());
    }

    @Test
    void 어제까지_저장돼_있으면_수집할_게_없다() {
        assertEquals(Optional.empty(), CatchUpPlanner.plan(YESTERDAY, YESTERDAY, 7));
    }

    @Test
    void 마지막_저장일이_어제보다_미래여도_수집하지_않는다() {
        assertEquals(Optional.empty(), CatchUpPlanner.plan(YESTERDAY.plusDays(1), YESTERDAY, 7));
    }

    @Test
    void 빠진_날짜만_보충한다() {
        LocalDate last = YESTERDAY.minusDays(3);

        CatchUpPlanner.Range range = CatchUpPlanner.plan(last, YESTERDAY, 7).orElseThrow();

        assertEquals(last.plusDays(1), range.from());
        assertEquals(YESTERDAY, range.to());
    }

    @Test
    void 보충_일수는_최대치로_제한된다() {
        LocalDate last = YESTERDAY.minusDays(30);

        CatchUpPlanner.Range range = CatchUpPlanner.plan(last, YESTERDAY, 7).orElseThrow();

        assertEquals(YESTERDAY.minusDays(6), range.from());
        assertEquals(YESTERDAY, range.to());
    }

    @Test
    void 최대치가_1이면_어제만_수집한다() {
        CatchUpPlanner.Range range = CatchUpPlanner.plan(YESTERDAY.minusDays(5), YESTERDAY, 1).orElseThrow();

        assertEquals(YESTERDAY, range.from());
    }

    @Test
    void 최대치가_1_미만이면_예외() {
        assertThrows(IllegalArgumentException.class, () -> CatchUpPlanner.plan(null, YESTERDAY, 0));
    }
}
