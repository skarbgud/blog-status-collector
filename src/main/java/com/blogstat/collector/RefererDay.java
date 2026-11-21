package com.blogstat.collector;

import java.time.LocalDate;
import java.util.List;

/**
 * 하루치 수집 결과.
 *
 * @param totalCount API가 알려준 유입 합계(refererTotalCount). 없으면 -1
 * @param today      아직 집계 중인 오늘 데이터인지. true면 값이 계속 바뀌므로 확정 데이터로 취급하지 않는다.
 * @param queries    검색 유입처별 검색어. 검색어를 가져오지 못한 유입처는 빠져 있을 수 있다.
 */
public record RefererDay(LocalDate date, List<RefererRow> rows, int totalCount, boolean today,
                         List<SearchQueryRow> queries) {

    /** 검색어 없이 만드는 경우(파서 단계). */
    public RefererDay(LocalDate date, List<RefererRow> rows, int totalCount, boolean today) {
        this(date, rows, totalCount, today, List.of());
    }

    public RefererDay withQueries(List<SearchQueryRow> queries) {
        return new RefererDay(date, rows, totalCount, today, List.copyOf(queries));
    }

    public int sumVisits() {
        return rows.stream().mapToInt(RefererRow::visits).sum();
    }
}
