package com.blogstat.dashboard;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

/**
 * 검색어 변화 계산. DB 없이 행 목록만 받아 계산하는 순수 함수라, 규칙을 테스트로 고정한다.
 *
 * 기간(기준일 = 검색어가 저장된 가장 최근 날짜):
 *   이번 주 = 기준일 포함 최근 7일, 지난주 = 그 앞 7일, 과거 = 이번 주 앞 lookbackDays일(지난주 포함).
 *
 * 규칙:
 *   - 새로 뜬 검색어: 이번 주에 들어왔고, 과거 lookbackDays일 동안 한 번도 없던 검색어.
 *   - 상승: 이번 주 방문 > 지난주 방문, 그리고 새로 뜬 검색어가 아님(예전에 있다가 다시 온 검색어 포함).
 *   - 하락: 이번 주 방문 < 지난주 방문(이번 주 0회 포함).
 *   - 띄어쓰기와 대소문자만 다른 검색어는 같은 검색어로 본다("스프링부트" = "스프링 부트").
 *     그래야 띄어쓰기만 바꾼 검색어가 "새로 뜬 검색어"로 잘못 잡히지 않는다. 표시는 가장 많이 들어온 표기로 한다.
 */
public final class KeywordTrends {

    public static final int WINDOW_DAYS = 7;

    private KeywordTrends() {
    }

    /** 입력 행: 날짜, 검색어, 방문(유입처별 행이어도 된다. 같은 검색어는 합친다). */
    public record Row(LocalDate date, String query, int visits) {
    }

    public record Change(String query, long thisWeek, long lastWeek, long delta) {
    }

    /**
     * @param firstSeen 이번 주 중 처음 들어온 날
     * @param days      이번 주에 들어온 날짜 수
     */
    public record NewQuery(String query, long visits, LocalDate firstSeen, int days) {
    }

    /**
     * @param historyDays 과거 구간 중 검색어가 실제로 저장된 날짜 수. 적으면 "새로 뜬" 판정의 근거가 약하다
     */
    public record Report(LocalDate thisFrom, LocalDate thisTo, LocalDate lastFrom, LocalDate lastTo,
                         LocalDate historyFrom, int historyDays,
                         List<Change> rising, List<Change> falling, List<NewQuery> fresh) {
    }

    public static LocalDate historyFrom(LocalDate anchor, int lookbackDays) {
        return anchor.minusDays(WINDOW_DAYS - 1L + lookbackDays);
    }

    /** 띄어쓰기·대소문자 무시 키. */
    static String key(String query) {
        return query.replaceAll("\\s+", "").toLowerCase();
    }

    public static Report compute(List<Row> rows, LocalDate anchor, int lookbackDays, int limit) {
        LocalDate thisFrom = anchor.minusDays(WINDOW_DAYS - 1L);
        LocalDate lastTo = thisFrom.minusDays(1);
        LocalDate lastFrom = lastTo.minusDays(WINDOW_DAYS - 1L);
        LocalDate historyFrom = historyFrom(anchor, lookbackDays);

        Map<String, Acc> byKey = new HashMap<>();
        TreeSet<LocalDate> historyDates = new TreeSet<>();
        for (Row r : rows) {
            LocalDate d = r.date();
            if (d.isBefore(historyFrom) || d.isAfter(anchor) || r.visits() <= 0) {
                continue;
            }
            Acc acc = byKey.computeIfAbsent(key(r.query()), k -> new Acc());
            acc.spellings.merge(r.query(), (long) r.visits(), Long::sum);
            if (!d.isBefore(thisFrom)) {
                acc.thisWeek += r.visits();
                acc.thisDates.add(d);
            } else {
                historyDates.add(d);
                acc.seenBefore = true;
                if (!d.isBefore(lastFrom)) {
                    acc.lastWeek += r.visits();
                }
            }
        }

        List<Change> rising = new ArrayList<>();
        List<Change> falling = new ArrayList<>();
        List<NewQuery> fresh = new ArrayList<>();
        for (Acc acc : byKey.values()) {
            String shown = acc.display();
            if (acc.thisWeek > 0 && !acc.seenBefore) {
                fresh.add(new NewQuery(shown, acc.thisWeek, acc.thisDates.first(), acc.thisDates.size()));
                continue;
            }
            long delta = acc.thisWeek - acc.lastWeek;
            if (delta > 0) {
                rising.add(new Change(shown, acc.thisWeek, acc.lastWeek, delta));
            } else if (delta < 0) {
                falling.add(new Change(shown, acc.thisWeek, acc.lastWeek, delta));
            }
        }
        rising.sort(Comparator.comparingLong(Change::delta).reversed()
                .thenComparing(Comparator.comparingLong(Change::thisWeek).reversed())
                .thenComparing(Change::query));
        falling.sort(Comparator.comparingLong(Change::delta)
                .thenComparing(Comparator.comparingLong(Change::lastWeek).reversed())
                .thenComparing(Change::query));
        fresh.sort(Comparator.comparingLong(NewQuery::visits).reversed()
                .thenComparing(NewQuery::firstSeen, Comparator.reverseOrder())
                .thenComparing(NewQuery::query));

        return new Report(thisFrom, anchor, lastFrom, lastTo, historyFrom, historyDates.size(),
                head(rising, limit), head(falling, limit), head(fresh, limit));
    }

    private static <T> List<T> head(List<T> list, int limit) {
        return List.copyOf(list.size() <= limit ? list : list.subList(0, limit));
    }

    private static final class Acc {
        final Map<String, Long> spellings = new HashMap<>();
        final TreeSet<LocalDate> thisDates = new TreeSet<>();
        long thisWeek;
        long lastWeek;
        boolean seenBefore;

        /** 가장 많이 들어온 표기. 같으면 사전순 앞의 것(결과가 매번 같도록). */
        String display() {
            return spellings.entrySet().stream()
                    .max(Map.Entry.<String, Long>comparingByValue()
                            .thenComparing(Map.Entry.comparingByKey(Comparator.reverseOrder())))
                    .orElseThrow().getKey();
        }
    }
}
