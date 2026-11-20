package com.example.blogstat.collector;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class QueryBackfillPlannerTest {

    private static final LocalDate TO = LocalDate.of(2026, 11, 19);

    @Test
    void 끝_날짜에서_days일을_거슬러_올라간다() {
        LocalDate[] range = QueryBackfillPlanner.range(TO, 30);

        assertArrayEquals(new LocalDate[]{LocalDate.of(2026, 10, 21), TO}, range);
    }

    @Test
    void days가_1이면_끝_날짜_하루() {
        assertArrayEquals(new LocalDate[]{TO, TO}, QueryBackfillPlanner.range(TO, 1));
    }

    @Test
    void days가_범위를_벗어나면_예외() {
        assertThrows(IllegalArgumentException.class, () -> QueryBackfillPlanner.range(TO, 0));
        assertThrows(IllegalArgumentException.class, () -> QueryBackfillPlanner.range(TO, 367));
    }

    @Test
    void 이미_검색어가_있는_날짜는_건너뛴다() {
        Set<LocalDate> existing = Set.of(TO.minusDays(1), TO.minusDays(3));

        List<LocalDate> dates = QueryBackfillPlanner.plan(TO.minusDays(3), TO, existing, false);

        assertEquals(List.of(TO.minusDays(2), TO), dates);
    }

    @Test
    void force면_이미_있어도_모두_다시_받는다() {
        Set<LocalDate> existing = Set.of(TO.minusDays(1));

        List<LocalDate> dates = QueryBackfillPlanner.plan(TO.minusDays(2), TO, existing, true);

        assertEquals(3, dates.size());
    }

    @Test
    void 날짜는_오래된_순이다() {
        List<LocalDate> dates = QueryBackfillPlanner.plan(TO.minusDays(2), TO, Set.of(), false);

        assertEquals(List.of(TO.minusDays(2), TO.minusDays(1), TO), dates);
    }

    @Test
    void 모두_이미_있으면_빈_목록() {
        Set<LocalDate> all = Set.of(TO.minusDays(1), TO);

        assertEquals(List.of(), QueryBackfillPlanner.plan(TO.minusDays(1), TO, all, false));
    }

    @Test
    void from이_to보다_늦으면_예외() {
        assertThrows(IllegalArgumentException.class, () -> QueryBackfillPlanner.plan(TO, TO.minusDays(1), Set.of(), false));
    }

    @Test
    void 예상_소요시간은_짧으면_초_길면_분으로_보여준다() {
        assertEquals("60초", QueryCollectRunner.formatSeconds(60));
        assertEquals("10분", QueryCollectRunner.formatSeconds(600));
    }
}
