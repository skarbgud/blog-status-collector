package com.blogstat.dashboard;

import com.blogstat.dashboard.KeywordTrends.Change;
import com.blogstat.dashboard.KeywordTrends.NewQuery;
import com.blogstat.dashboard.KeywordTrends.Report;
import com.blogstat.dashboard.KeywordTrends.Row;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class KeywordTrendsTest {

    // 기준일 11-20 → 이번 주 11-14~11-20, 지난주 11-07~11-13, 과거(28일) 10-17~11-13
    private static final LocalDate ANCHOR = LocalDate.of(2026, 11, 20);

    private static Row row(String date, String query, int visits) {
        return new Row(LocalDate.parse(date), query, visits);
    }

    private static Report compute(List<Row> rows) {
        return KeywordTrends.compute(rows, ANCHOR, 28, 20);
    }

    @Test
    void 기간_경계() {
        Report r = compute(List.of());

        assertThat(r.thisFrom()).isEqualTo("2026-11-14");
        assertThat(r.thisTo()).isEqualTo("2026-11-20");
        assertThat(r.lastFrom()).isEqualTo("2026-11-07");
        assertThat(r.lastTo()).isEqualTo("2026-11-13");
        assertThat(r.historyFrom()).isEqualTo("2026-10-17");
        assertThat(r.rising()).isEmpty();
        assertThat(r.falling()).isEmpty();
        assertThat(r.fresh()).isEmpty();
    }

    @Test
    void 지난주보다_늘면_상승_줄면_하락() {
        Report r = compute(List.of(
                row("2026-11-10", "오른 검색어", 1), row("2026-11-18", "오른 검색어", 4),
                row("2026-11-08", "내린 검색어", 5), row("2026-11-19", "내린 검색어", 2),
                row("2026-11-09", "그대로", 3), row("2026-11-15", "그대로", 3)));

        assertThat(r.rising()).containsExactly(new Change("오른 검색어", 4, 1, 3));
        assertThat(r.falling()).containsExactly(new Change("내린 검색어", 2, 5, -3));
    }

    @Test
    void 이번_주에_안_들어온_검색어도_하락이다() {
        Report r = compute(List.of(row("2026-11-12", "끊긴 검색어", 6)));

        assertThat(r.falling()).containsExactly(new Change("끊긴 검색어", 0, 6, -6));
    }

    @Test
    void 과거에_한_번도_없던_검색어만_새로_뜬_검색어다() {
        Report r = compute(List.of(
                row("2026-11-16", "새 검색어", 2), row("2026-11-19", "새 검색어", 3),
                // 지난주에는 없었지만 3주 전에 있었다 → 새 검색어가 아니라 다시 온 검색어(상승)
                row("2026-10-25", "돌아온 검색어", 1), row("2026-11-18", "돌아온 검색어", 2)));

        assertThat(r.fresh()).containsExactly(new NewQuery("새 검색어", 5, LocalDate.parse("2026-11-16"), 2));
        assertThat(r.rising()).containsExactly(new Change("돌아온 검색어", 2, 0, 2));
    }

    @Test
    void 과거_구간보다_오래된_기록은_보지_않는다() {
        // 10-16은 28일 과거 구간(10-17~) 밖이라, 그때 있었어도 이번 주에는 새 검색어다.
        Report r = compute(List.of(row("2026-10-16", "아주 옛날 검색어", 9), row("2026-11-20", "아주 옛날 검색어", 1)));

        assertThat(r.fresh()).extracting(NewQuery::query).containsExactly("아주 옛날 검색어");
    }

    @Test
    void 띄어쓰기와_대소문자만_다른_검색어는_같은_검색어다() {
        Report r = compute(List.of(
                row("2026-11-09", "스프링 부트", 2),
                row("2026-11-17", "스프링부트", 3), row("2026-11-18", "스프링 부트", 1),
                row("2026-11-19", "Claude Code", 1), row("2026-11-20", "claudecode", 2)));

        // 띄어쓰기만 바꾼 "스프링부트"는 새 검색어가 아니다. 표시는 가장 많이 들어온 표기다.
        assertThat(r.rising()).containsExactly(new Change("스프링 부트", 4, 2, 2));
        assertThat(r.fresh()).containsExactly(new NewQuery("claudecode", 3, LocalDate.parse("2026-11-19"), 2));
    }

    @Test
    void 같은_날_여러_유입처의_같은_검색어는_합친다() {
        Report r = compute(List.of(
                row("2026-11-19", "같은 검색어", 2), row("2026-11-19", "같은 검색어", 3)));

        assertThat(r.fresh()).containsExactly(new NewQuery("같은 검색어", 5, LocalDate.parse("2026-11-19"), 1));
    }

    @Test
    void 정렬은_변화량_순이고_limit만큼_자른다() {
        List<Row> rows = new ArrayList<>();
        for (int i = 1; i <= 5; i++) {
            rows.add(row("2026-11-10", "q" + i, 1));
            rows.add(row("2026-11-18", "q" + i, 1 + i));
        }
        Report r = KeywordTrends.compute(rows, ANCHOR, 28, 3);

        assertThat(r.rising()).extracting(Change::query).containsExactly("q5", "q4", "q3");
    }

    @Test
    void 과거_데이터가_있는_날짜_수를_알려준다() {
        Report r = compute(List.of(
                row("2026-11-01", "a", 1), row("2026-11-01", "b", 1), row("2026-11-12", "a", 1),
                row("2026-11-19", "a", 1)));

        assertThat(r.historyDays()).isEqualTo(2);
    }
}
