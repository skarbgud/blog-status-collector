package com.example.blogstat.dashboard;

import com.example.blogstat.domain.ReferrerDailyRepository;
import com.example.blogstat.domain.ReferrerDailyRepository.DailyTotal;
import com.example.blogstat.domain.SearchQueryDaily;
import com.example.blogstat.domain.SearchQueryDailyRepository;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 대시보드용 조회 전용 서비스. 저장된 집계만 읽고 아무것도 쓰지 않는다. */
@Service
@Transactional(readOnly = true)
public class DashboardService {

    static final int DEFAULT_DAYS = 30;
    static final int MAX_DAYS = 366;
    static final int MAX_LIMIT = 50;

    static final int DEFAULT_QUERY_LIMIT = 500;
    static final int MAX_QUERY_LIMIT = 2000;

    private final ReferrerDailyRepository repository;
    private final SearchQueryDailyRepository queryRepository;
    private final Clock clock;

    public DashboardService(ReferrerDailyRepository repository,
                            SearchQueryDailyRepository queryRepository,
                            Clock clock) {
        this.repository = repository;
        this.queryRepository = queryRepository;
        this.clock = clock;
    }

    /**
     * @param days    그 검색어가 들어온 날짜 수
     * @param sources 그 검색어가 들어온 유입처(방문 많은 순)
     */
    public record QueryShare(String query, long visits, int days, List<String> sources) {
    }

    /**
     * @param distinctQueries 기간 내 서로 다른 검색어 수(자르기 전)
     * @param truncated       limit 때문에 items가 전체보다 적은지
     */
    public record QueryReport(LocalDate from, LocalDate to, int distinctQueries, long totalVisits,
                              boolean truncated, List<QueryShare> items) {
    }

    /** 조회 기간. from/to가 없으면 저장된 가장 최근 날짜 기준 최근 30일. */
    public record Period(LocalDate from, LocalDate to) {
    }

    public record Summary(LocalDate from, LocalDate to, long totalVisits, long searchVisits,
                          double searchRatio, int collectedDays, int totalDays, LocalDate latestDate) {
    }

    /** visits가 null이면 그 날짜는 수집된 데이터가 없다는 뜻이다(차트에서 끊어서 보여준다). */
    public record DailyPoint(LocalDate date, Long visits, Long searchVisits) {
    }

    public record ReferrerShare(String name, boolean searchEngine, long visits, double ratio) {
    }

    public Period resolve(LocalDate from, LocalDate to) {
        LocalDate resolvedTo = to != null ? to
                : repository.findLatestStatDate().orElse(LocalDate.now(clock).minusDays(1));
        LocalDate resolvedFrom = from != null ? from : resolvedTo.minusDays(DEFAULT_DAYS - 1L);
        if (resolvedFrom.isAfter(resolvedTo)) {
            throw new IllegalArgumentException("from이 to보다 늦습니다: " + resolvedFrom + " > " + resolvedTo);
        }
        if (ChronoUnit.DAYS.between(resolvedFrom, resolvedTo) + 1 > MAX_DAYS) {
            throw new IllegalArgumentException("조회 기간은 최대 " + MAX_DAYS + "일입니다.");
        }
        return new Period(resolvedFrom, resolvedTo);
    }

    public Summary summary(Period period) {
        List<DailyTotal> totals = repository.findDailyTotals(period.from(), period.to());
        long visits = 0;
        long search = 0;
        for (DailyTotal t : totals) {
            visits += t.getVisits();
            search += t.getSearchVisits();
        }
        double ratio = visits == 0 ? 0 : search * 100.0 / visits;
        int totalDays = (int) (ChronoUnit.DAYS.between(period.from(), period.to()) + 1);
        return new Summary(period.from(), period.to(), visits, search, ratio, totals.size(), totalDays,
                repository.findLatestStatDate().orElse(null));
    }

    /** 기간의 모든 날짜를 돌려준다. 데이터가 없는 날짜는 visits=null로 채운다. */
    public List<DailyPoint> daily(Period period) {
        Map<LocalDate, DailyTotal> byDate = new HashMap<>();
        for (DailyTotal t : repository.findDailyTotals(period.from(), period.to())) {
            byDate.put(t.getStatDate(), t);
        }
        List<DailyPoint> result = new ArrayList<>();
        for (LocalDate d = period.from(); !d.isAfter(period.to()); d = d.plusDays(1)) {
            DailyTotal t = byDate.get(d);
            result.add(t == null
                    ? new DailyPoint(d, null, null)
                    : new DailyPoint(d, t.getVisits(), t.getSearchVisits()));
        }
        return result;
    }

    /**
     * 기간 내 모든 검색 유입처의 검색어를 검색어 기준으로 합쳐 방문 많은 순(같으면 가나다순)으로 돌려준다.
     * 같은 검색어가 여러 날, 여러 유입처에서 들어오면 방문수를 합산한다.
     */
    public QueryReport queries(Period period, int limit) {
        int size = Math.max(1, Math.min(limit, MAX_QUERY_LIMIT));

        Map<String, QueryAgg> byQuery = new HashMap<>();
        for (SearchQueryDaily row : queryRepository.findByStatDateBetween(period.from(), period.to())) {
            QueryAgg agg = byQuery.computeIfAbsent(row.getSearchQuery(), q -> new QueryAgg());
            agg.visits += row.getVisits();
            agg.dates.add(row.getStatDate());
            agg.sourceVisits.merge(row.getReferrerName(), (long) row.getVisits(), Long::sum);
        }

        long total = byQuery.values().stream().mapToLong(a -> a.visits).sum();
        List<QueryShare> sorted = byQuery.entrySet().stream()
                .sorted(Comparator.<Map.Entry<String, QueryAgg>>comparingLong(e -> -e.getValue().visits)
                        .thenComparing(Map.Entry::getKey))
                .map(e -> new QueryShare(e.getKey(), e.getValue().visits, e.getValue().dates.size(),
                        e.getValue().sourcesByVisits()))
                .toList();
        List<QueryShare> items = sorted.size() > size ? sorted.subList(0, size) : sorted;
        return new QueryReport(period.from(), period.to(), sorted.size(), total, sorted.size() > size, items);
    }

    private static final class QueryAgg {
        long visits;
        final Set<LocalDate> dates = new HashSet<>();
        final Map<String, Long> sourceVisits = new HashMap<>();

        List<String> sourcesByVisits() {
            return sourceVisits.entrySet().stream()
                    .sorted(Comparator.<Map.Entry<String, Long>>comparingLong(e -> -e.getValue())
                            .thenComparing(Map.Entry::getKey))
                    .map(Map.Entry::getKey)
                    .toList();
        }
    }

    /** 방문 많은 순 상위 limit개. ratio는 기간 전체 방문 대비 퍼센트다. */
    public List<ReferrerShare> referrers(Period period, int limit) {
        int size = Math.max(1, Math.min(limit, MAX_LIMIT));
        long total = summary(period).totalVisits();
        return repository.findReferrerTotals(period.from(), period.to(), PageRequest.of(0, size)).stream()
                .map(r -> new ReferrerShare(r.getReferrerName(), Boolean.TRUE.equals(r.getSearchEngine()),
                        r.getVisits(), total == 0 ? 0 : r.getVisits() * 100.0 / total))
                .toList();
    }
}
