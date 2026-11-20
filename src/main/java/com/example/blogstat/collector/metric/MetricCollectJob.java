package com.example.blogstat.collector.metric;

import com.example.blogstat.collector.core.BudgetExceededException;
import com.example.blogstat.collector.core.CollectSettings;
import com.example.blogstat.collector.core.NaverStatClient;
import com.example.blogstat.collector.core.StatHttp;
import com.example.blogstat.domain.MetricRow;
import com.example.blogstat.domain.MetricService;
import com.example.blogstat.replica.SnapshotPublisher;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 블로그 지표(조회수, 방문자, 시간대, 성별·연령, 순위, 게시글별 조회수 등)를 수집해 바로 저장한다.
 * 요청 정책(지연·예산·재시도·세션 판정)은 {@link NaverStatClient}가 맡고, 여기서는 무엇을 몇 번 부를지만 정한다.
 *
 * <ul>
 *   <li>같은 API를 쓰는 지표들은 한 번의 요청으로 함께 받는다(예: user/demoCv 한 번에 성별·연령 4종).</li>
 *   <li>시계열은 한 번에 15일치가 오므로 기간을 15일 창으로 나눠 부른다(주간 지표는 한 번).</li>
 *   <li>하루·주·월 단위 지표는 날짜마다 한 번씩 부르고, 이미 저장된 날짜는 건너뛴다(force가 아니면). 새 날짜부터 받는다.</li>
 *   <li>게시글별 지표는 순위에 나온 게시글마다 부르므로 순위를 받은 뒤 맨 마지막에 한다.</li>
 *   <li>한 요청이 실패해도 나머지는 계속한다. 세션 만료와 예산 소진은 그대로 멈춘다.</li>
 * </ul>
 */
@Component
public class MetricCollectJob {

    /** from~to(양끝 포함)를 specs의 지표로 받는다. force면 이미 받은 날짜도 다시 받는다. */
    public record Plan(List<MetricSpec> specs, LocalDate from, LocalDate to, boolean force) {
    }

    /**
     * @param saved         지표별 저장한 행 수
     * @param failures      실패해서 건너뛴 요청 수
     * @param budgetStopped 요청 예산을 다 써서 멈췄는지(남은 날짜는 다시 실행하면 이어서 받는다)
     */
    public record Result(Map<String, Integer> saved, int failures, boolean budgetStopped) {
    }

    /**
     * 요청 한 번. 같은 응답에서 specs 모두를 읽는다.
     *
     * @param startDate 요청의 startDate
     * @param requested 하루·월 단위 행에 붙일 날짜
     * @param postId    게시글별 요청의 게시글 번호, 아니면 null
     */
    private record Unit(LocalDate startDate, LocalDate requested, String postId, List<MetricSpec> specs) {
    }

    private final NaverStatClient client;
    private final MetricService service;
    private final CollectSettings settings;
    private final Clock clock;
    private final ObjectProvider<SnapshotPublisher> publisher;
    private final MetricParser parser;
    private final int maxRequests;

    public MetricCollectJob(NaverStatClient client, MetricService service, CollectSettings settings, Clock clock,
                            ObjectProvider<SnapshotPublisher> publisher, MetricParser parser,
                            @Value("${app.metrics.max-requests-per-run}") int maxRequests) {
        this.client = client;
        this.service = service;
        this.settings = settings;
        this.clock = clock;
        this.publisher = publisher;
        this.parser = parser;
        this.maxRequests = maxRequests;
    }

    /**
     * 이번 계획이 보낼 요청 수 어림(재시도 제외). 게시글별 요청은 지금 저장된 순위에 나온 게시글 수 기준이다.
     */
    public int estimateRequests(Plan plan) {
        return plainUnits(plan).size() + postUnits(plan).size();
    }

    public int maxRequests() {
        return maxRequests;
    }

    public Result run(Plan plan) {
        Map<String, Integer> saved = new LinkedHashMap<>();
        int[] failures = {0};
        boolean[] stopped = {false};
        try {
            client.run(maxRequests, session -> {
                Result r = execute(session, plan);
                r.saved().forEach((k, v) -> saved.merge(k, v, Integer::sum));
                failures[0] += r.failures();
                stopped[0] = r.budgetStopped();
            });
        } finally {
            publishSnapshot();
        }
        return new Result(saved, failures[0], stopped[0]);
    }

    /** 실제 수집 로직. 테스트에서 가짜 {@link StatHttp}로 부를 수 있게 클라이언트 실행과 분리했다. */
    Result execute(StatHttp http, Plan plan) {
        Map<String, Integer> saved = new LinkedHashMap<>();
        int[] failures = {0};
        LocalDate today = LocalDate.now(clock);
        try {
            for (Unit unit : plainUnits(plan)) {
                fetch(http, unit, today, saved, failures);
            }
            // 게시글 번호는 위에서 받은 순위에서 나오므로 그 뒤에 계획한다.
            for (Unit unit : postUnits(plan)) {
                fetch(http, unit, today, saved, failures);
            }
        } catch (BudgetExceededException e) {
            System.out.println("[예산] " + e.getMessage());
            return new Result(saved, failures[0], true);
        }
        return new Result(saved, failures[0], false);
    }

    private void fetch(StatHttp http, Unit unit, LocalDate today, Map<String, Integer> saved, int[] failures) {
        MetricSpec first = unit.specs().get(0);
        String label = first.id() + (unit.specs().size() > 1 ? "+" + (unit.specs().size() - 1) : "")
                + " " + unit.startDate() + (unit.postId() != null ? " 글 " + unit.postId() : "");
        String body;
        try {
            body = http.get(url(first, unit.startDate(), unit.postId()), label);
        } catch (IllegalStateException e) {
            if (Thread.currentThread().isInterrupted()) {
                throw e;
            }
            failures[0]++;
            System.out.println("[경고] " + label + " 수집 실패, 건너뜁니다: " + e.getMessage());
            return;
        }
        for (MetricSpec spec : unit.specs()) {
            try {
                List<MetricRow> rows = parser.parse(body, spec, unit.requested(), today, LocalDateTime.now(clock),
                        unit.postId());
                if (rows.isEmpty() && !spec.isSeries() && !spec.isValue()) {
                    // 네이버가 아직 집계하지 않은 날. 저장하지 않고(다음 실행에서 다시 받는다), 앞서 저장된 잠정값은 지운다.
                    service.clear(spec.id(), unit.requested());
                    System.out.println("[집계 전] " + spec.id() + " " + unit.requested()
                            + " 아직 확정되지 않아 저장하지 않습니다. 나중에 다시 실행하면 받습니다.");
                    continue;
                }
                saved.merge(spec.id(), service.replace(spec.id(), rows, unit.postId()), Integer::sum);
            } catch (MetricParseException e) {
                failures[0]++;
                System.out.println("[경고] " + spec.id() + " " + unit.startDate() + " 응답을 읽지 못해 건너뜁니다: "
                        + e.getMessage());
            }
        }
    }

    // ---- 계획: 어떤 요청을 몇 번 보낼지 ----

    /** 게시글과 무관한 요청들: 시계열 → 하루 단위(최신 날짜부터) → 주 단위 → 월 단위 순. */
    private List<Unit> plainUnits(Plan plan) {
        List<Unit> series = new ArrayList<>();
        Map<LocalDate, Map<String, List<MetricSpec>>> byDate = new java.util.TreeMap<>(Comparator.reverseOrder());
        List<Unit> weekly = new ArrayList<>();
        List<Unit> values = new ArrayList<>();

        Map<String, List<MetricSpec>> seriesGroups = new LinkedHashMap<>();
        for (MetricSpec spec : plan.specs()) {
            if (spec.perPost()) {
                continue;
            }
            if (spec.isSeries()) {
                seriesGroups.computeIfAbsent(spec.requestKey(), k -> new ArrayList<>()).add(spec);
            } else if (spec.isValue()) {
                LocalDate month = lastMonthStart(plan.to());
                if (needs(spec, month, month, plan)) {
                    values.add(new Unit(month, month, null, List.of(spec)));
                }
            } else if ("WEEK".equals(spec.timeDim())) {
                for (LocalDate week : weekStarts(plan)) {
                    if (needs(spec, week, week, plan)) {
                        weekly.add(new Unit(week, week, null, List.of(spec)));
                    }
                }
            } else {
                Set<LocalDate> have = plan.force() ? Set.of() : service.datesWith(spec.id(), plan.from(), plan.to());
                for (LocalDate d = plan.to(); !d.isBefore(plan.from()); d = d.minusDays(1)) {
                    if (!have.contains(d)) {
                        byDate.computeIfAbsent(d, k -> new LinkedHashMap<>())
                                .computeIfAbsent(spec.requestKey(), k -> new ArrayList<>()).add(spec);
                    }
                }
            }
        }
        for (List<MetricSpec> group : seriesGroups.values()) {
            for (LocalDate start : seriesStarts(group.get(0), plan)) {
                series.add(new Unit(start, start, null, group));
            }
        }
        List<Unit> days = new ArrayList<>();
        byDate.forEach((date, groups) -> groups.values().forEach(g -> days.add(new Unit(date, date, null, g))));

        List<Unit> all = new ArrayList<>(series);
        all.addAll(days);
        all.addAll(weekly);
        all.addAll(values);
        return all;
    }

    /** 순위에 나온 게시글마다 시계열 창 수만큼. 이미 받은 게시글은 건너뛴다(force가 아니면). */
    private List<Unit> postUnits(Plan plan) {
        List<MetricSpec> specs = plan.specs().stream().filter(MetricSpec::perPost).toList();
        if (specs.isEmpty()) {
            return List.of();
        }
        MetricSpec series = specs.stream().filter(MetricSpec::isSeries).findFirst().orElse(specs.get(0));
        // 게시글마다 요청 한 번에 시계열과 정보를 함께 읽으므로, 첫 창에만 정보 지표를 붙인다.
        Set<String> have = plan.force() ? Set.of() : service.keysWith(specs.get(0).id(), plan.to());
        List<Unit> units = new ArrayList<>();
        for (String post : service.postIds(plan.from(), plan.to())) {
            if (have.contains(post)) {
                continue;
            }
            boolean firstWindow = true;
            for (LocalDate start : seriesStarts(series, plan)) {
                List<MetricSpec> forWindow = firstWindow ? specs
                        : specs.stream().filter(MetricSpec::isSeries).toList();
                units.add(new Unit(start, plan.to(), post, forWindow));
                firstWindow = false;
            }
        }
        return units;
    }

    private boolean needs(MetricSpec spec, LocalDate checkFrom, LocalDate date, Plan plan) {
        if (plan.force()) {
            return true;
        }
        return !service.datesWith(spec.id(), checkFrom, date).contains(date);
    }

    /** 시계열을 부를 startDate들. 일별은 to에서 15일씩 거슬러 from을 덮을 때까지, 주간은 마지막으로 끝난 주 한 번. */
    private List<LocalDate> seriesStarts(MetricSpec spec, Plan plan) {
        List<LocalDate> starts = new ArrayList<>();
        if ("WEEK".equals(spec.timeDim())) {
            // 화면은 마지막으로 끝난 주의 월요일을 startDate로 보낸다(15주치가 거꾸로 온다).
            starts.add(lastCompleteWeekStart(plan.to()));
            return starts;
        }
        for (LocalDate end = plan.to(); !end.isBefore(plan.from()); end = end.minusDays(MetricSpec.SERIES_WINDOW_DAYS)) {
            starts.add(end);
        }
        return starts;
    }

    /** to를 포함해 끝난 마지막 주의 월요일. to가 일요일이면 그 주도 끝난 주다. */
    static LocalDate lastCompleteWeekStart(LocalDate to) {
        LocalDate monday = to.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
        return to.getDayOfWeek() == DayOfWeek.SUNDAY ? monday : monday.minusWeeks(1);
    }

    /** 기간과 겹치는 끝난 주들의 월요일(최신순). */
    private List<LocalDate> weekStarts(Plan plan) {
        List<LocalDate> weeks = new ArrayList<>();
        for (LocalDate w = lastCompleteWeekStart(plan.to()); !w.plusDays(6).isBefore(plan.from()); w = w.minusWeeks(1)) {
            weeks.add(w);
        }
        return weeks;
    }

    /** 화면이 월간 비교에 보내는 startDate: 마지막으로 끝난 달의 1일. */
    static LocalDate lastMonthStart(LocalDate to) {
        return to.withDayOfMonth(1).minusMonths(1);
    }

    String url(MetricSpec spec, LocalDate startDate, String postId) {
        return settings.baseUrl() + spec.path()
                + "?timeDimension=" + spec.timeDim()
                + "&startDate=" + startDate
                + (postId != null ? "&contentId=" + postId : "")
                + spec.extraQuery()
                + "&exclude="
                + "&_=" + System.currentTimeMillis() + "_" + ThreadLocalRandom.current().nextInt(10_000);
    }

    /** finally에서 호출되므로, 발행 실패가 수집 중 발생한 원래 예외를 가리지 않게 경고만 남긴다. */
    private void publishSnapshot() {
        SnapshotPublisher p = publisher.getIfAvailable();
        if (p == null) {
            return;
        }
        try {
            p.publish();
        } catch (RuntimeException e) {
            System.out.println("[경고] 대시보드용 스냅샷을 내보내지 못했습니다: " + e.getMessage()
                    + " (`--app.mode=publish`로 다시 내보낼 수 있습니다)");
        }
    }
}
