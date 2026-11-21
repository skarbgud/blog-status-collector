package com.blogstat.schedule;

import java.time.LocalDate;
import java.util.Optional;

/** 마지막 저장일과 어제를 보고 이번에 수집할 날짜 범위를 정한다. */
public final class CatchUpPlanner {

    private CatchUpPlanner() {
    }

    public record Range(LocalDate from, LocalDate to) {
    }

    /**
     * @param lastSaved 마지막으로 저장된 날짜. 없으면 null(최초 실행이면 어제 하루만 수집)
     * @param yesterday 수집 대상의 마지막 날. 오늘은 집계 중이라 제외한다.
     * @param maxDays   한 번에 보충할 최대 일수. PC가 오래 꺼져 있었어도 과도한 호출을 막는다.
     * @return 수집할 범위. 이미 최신이면 empty
     */
    public static Optional<Range> plan(LocalDate lastSaved, LocalDate yesterday, int maxDays) {
        if (maxDays < 1) {
            throw new IllegalArgumentException("maxDays는 1 이상이어야 합니다: " + maxDays);
        }
        LocalDate from = lastSaved == null ? yesterday : lastSaved.plusDays(1);
        if (from.isAfter(yesterday)) {
            return Optional.empty();
        }
        LocalDate earliest = yesterday.minusDays(maxDays - 1L);
        if (from.isBefore(earliest)) {
            from = earliest;
        }
        return Optional.of(new Range(from, yesterday));
    }
}
