package com.blogstat.collector;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/** 검색어를 거슬러 올라가며 수집할 때, 이번에 실제로 가져올 날짜 목록을 정한다. */
public final class QueryBackfillPlanner {

    static final int MAX_DAYS = 366;

    private QueryBackfillPlanner() {
    }

    /** 끝 날짜(to)에서 days일 전까지. 예: to=11-19, days=30이면 10-21~11-19. */
    public static LocalDate[] range(LocalDate to, int days) {
        if (days < 1 || days > MAX_DAYS) {
            throw new IllegalArgumentException("days는 1~" + MAX_DAYS + " 사이여야 합니다: " + days);
        }
        return new LocalDate[]{to.minusDays(days - 1L), to};
    }

    /**
     * @param existing 이미 검색어가 저장된 날짜
     * @param force    true면 이미 있어도 다시 가져온다
     * @return 가져올 날짜(오래된 순). 이미 있는 날짜는 빠진다
     */
    public static List<LocalDate> plan(LocalDate from, LocalDate to, Set<LocalDate> existing, boolean force) {
        if (from.isAfter(to)) {
            throw new IllegalArgumentException("from이 to보다 늦습니다: " + from + " > " + to);
        }
        List<LocalDate> result = new ArrayList<>();
        for (LocalDate d = from; !d.isAfter(to); d = d.plusDays(1)) {
            if (force || !existing.contains(d)) {
                result.add(d);
            }
        }
        return result;
    }
}
