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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 블로그 지표(조회수, 방문자, 시간대, 성별·연령, 순위 등)를 수집해 바로 저장한다.
 * 요청 정책(지연·예산·재시도·세션 판정)은 {@link NaverStatClient}가 맡고, 여기서는 무엇을 몇 번 부를지만 정한다.
 *
 * <ul>
 *   <li>시계열은 한 번에 15일치가 오므로 기간을 15일 창으로 나눠 부른다(주간 지표는 한 번).</li>
 *   <li>하루 단위 지표는 날짜마다 한 번씩 부르고, 이미 저장된 날짜는 건너뛴다(force가 아니면). 새 날짜부터 받는다.</li>
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

    /** 이번 계획이 보낼 요청 수 어림(재시도 제외). 시작 전에 사용자에게 보여 주려고 쓴다. */
    public int estimateRequests(Plan plan) {
        int count = 0;
        for (MetricSpec spec : plan.specs()) {
            count += spec.isSeries() ? seriesStarts(spec, plan).size() : daysToFetch(spec, plan).size();
        }
        return count;
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
            for (MetricSpec spec : plan.specs()) {
                if (!spec.isSeries()) {
                    continue;
                }
                for (LocalDate start : seriesStarts(spec, plan)) {
                    collectOne(http, spec, start, start, today, saved, failures);
                }
            }
            // 하루 단위는 날짜별로 묶어(최신 날짜부터) 받는다. 예산이 모자라면 오래된 날짜가 다음 회차로 밀린다.
            Map<MetricSpec, Set<LocalDate>> missing = new LinkedHashMap<>();
            List<LocalDate> dates = new ArrayList<>();
            for (MetricSpec spec : plan.specs()) {
                if (!spec.isSeries()) {
                    List<LocalDate> need = daysToFetch(spec, plan);
                    missing.put(spec, Set.copyOf(need));
                    need.stream().filter(d -> !dates.contains(d)).forEach(dates::add);
                }
            }
            dates.sort(java.util.Comparator.reverseOrder());
            for (LocalDate date : dates) {
                for (Map.Entry<MetricSpec, Set<LocalDate>> e : missing.entrySet()) {
                    if (e.getValue().contains(date)) {
                        collectOne(http, e.getKey(), date, date, today, saved, failures);
                    }
                }
            }
        } catch (BudgetExceededException e) {
            System.out.println("[예산] " + e.getMessage());
            return new Result(saved, failures[0], true);
        }
        return new Result(saved, failures[0], false);
    }

    private void collectOne(StatHttp http, MetricSpec spec, LocalDate requested, LocalDate startDate,
                            LocalDate today, Map<String, Integer> saved, int[] failures) {
        String label = spec.id() + " " + startDate;
        try {
            String body = http.get(url(spec, startDate), label);
            List<MetricRow> rows = parser.parse(body, spec, requested, today, LocalDateTime.now(clock));
            if (rows.isEmpty() && !spec.isSeries()) {
                // 네이버가 아직 집계하지 않은 날. 저장하지 않고(다음 실행에서 다시 받는다), 앞서 저장된 잠정값은 지운다.
                service.clear(spec.id(), requested);
                System.out.println("[집계 전] " + label + " 아직 확정되지 않아 저장하지 않습니다. 나중에 다시 실행하면 받습니다.");
                return;
            }
            saved.merge(spec.id(), service.replace(spec.id(), rows), Integer::sum);
        } catch (IllegalStateException | MetricParseException e) {
            if (Thread.currentThread().isInterrupted()) {
                throw new IllegalStateException(e);
            }
            failures[0]++;
            System.out.println("[경고] " + label + " 수집 실패, 건너뜁니다: " + e.getMessage());
        }
    }

    /** 시계열을 부를 startDate들. 일별은 to에서 15일씩 거슬러 from을 덮을 때까지, 주간은 마지막으로 끝난 주 한 번. */
    private List<LocalDate> seriesStarts(MetricSpec spec, Plan plan) {
        List<LocalDate> starts = new ArrayList<>();
        if ("WEEK".equals(spec.timeDim())) {
            // 화면은 마지막으로 끝난 주의 월요일을 startDate로 보낸다(15주치가 거꾸로 온다).
            starts.add(plan.to().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).minusWeeks(1));
            return starts;
        }
        for (LocalDate end = plan.to(); !end.isBefore(plan.from()); end = end.minusDays(MetricSpec.SERIES_WINDOW_DAYS)) {
            starts.add(end);
        }
        return starts;
    }

    /** 하루 단위 지표를 받아야 하는 날짜(최신순). */
    private List<LocalDate> daysToFetch(MetricSpec spec, Plan plan) {
        Set<LocalDate> have = plan.force() ? Set.of() : service.datesWith(spec.id(), plan.from(), plan.to());
        List<LocalDate> dates = new ArrayList<>();
        for (LocalDate d = plan.to(); !d.isBefore(plan.from()); d = d.minusDays(1)) {
            if (!have.contains(d)) {
                dates.add(d);
            }
        }
        return dates;
    }

    String url(MetricSpec spec, LocalDate startDate) {
        return settings.baseUrl() + spec.path()
                + "?timeDimension=" + spec.timeDim()
                + "&startDate=" + startDate
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
