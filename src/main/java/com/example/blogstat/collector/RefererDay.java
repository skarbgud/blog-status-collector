package com.example.blogstat.collector;

import java.time.LocalDate;
import java.util.List;

/**
 * 하루치 수집 결과.
 *
 * @param totalCount API가 알려준 유입 합계(refererTotalCount). 없으면 -1
 * @param today      아직 집계 중인 오늘 데이터인지. true면 값이 계속 바뀌므로 확정 데이터로 취급하지 않는다.
 */
public record RefererDay(LocalDate date, List<RefererRow> rows, int totalCount, boolean today) {

    public int sumVisits() {
        return rows.stream().mapToInt(RefererRow::visits).sum();
    }
}
