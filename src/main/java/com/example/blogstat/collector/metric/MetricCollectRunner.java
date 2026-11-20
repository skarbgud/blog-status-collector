package com.example.blogstat.collector.metric;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * `--app.mode=collect-metrics [--days=30] [--from=YYYY-MM-DD --to=YYYY-MM-DD] [--only=VIEWS,HOUR] [--force]`
 *
 * 유입경로·검색어 말고 나머지 통계 지표를 모두 받는다. 끝 날짜 기본값은 어제(오늘은 집계 중이라 제외),
 * 일수 기본값은 app.metrics.default-days(30). 하루 단위 지표는 이미 받은 날짜를 건너뛰고, --force면 다시 받는다.
 * 요청이 많아(30일이면 200회 안팎) 시간이 걸리므로 시작 전에 예상 요청 수를 보여 준다.
 */
@Component
@ConditionalOnProperty(name = "app.mode", havingValue = "collect-metrics")
public class MetricCollectRunner implements ApplicationRunner {

    private final MetricCollectJob job;
    private final Clock clock;
    private final int defaultDays;
    private final long avgDelayMs;

    public MetricCollectRunner(MetricCollectJob job, Clock clock,
                               @Value("${app.metrics.default-days}") int defaultDays,
                               @Value("${app.collect.min-delay-ms}") long minDelayMs,
                               @Value("${app.collect.max-delay-ms}") long maxDelayMs) {
        this.job = job;
        this.clock = clock;
        this.defaultDays = defaultDays;
        this.avgDelayMs = (minDelayMs + maxDelayMs) / 2;
    }

    @Override
    public void run(ApplicationArguments args) {
        LocalDate to = date(args, "to", LocalDate.now(clock).minusDays(1));
        LocalDate from = args.containsOption("from")
                ? date(args, "from", to)
                : to.minusDays(intOption(args, "days", defaultDays) - 1L);
        if (from.isAfter(to)) {
            throw new IllegalArgumentException("from이 to보다 늦습니다: " + from + " > " + to);
        }
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(specs(args), from, to, args.containsOption("force"));

        int repaired = job.repairMarkers(plan);
        if (repaired > 0) {
            System.out.println("[정리] 시계열 지표에 잘못 남은 '조회 불가' 표시 " + repaired + "행을 지웠습니다.");
        }
        int estimate = job.estimateRequests(plan);
        System.out.println("[지표 수집] " + from + " ~ " + to + ", 지표 " + plan.specs().size() + "종"
                + (plan.force() ? ", --force: 이미 있는 날짜도 다시 받음" : ""));
        if (estimate == 0) {
            System.out.println("  받을 것이 없습니다(모두 이미 저장됨). 다시 받으려면 --force를 주세요.");
            if (repaired > 0) {
                job.publish(); // 정리한 결과를 대시보드가 보도록 스냅샷을 다시 내보낸다.
            }
            return;
        }
        System.out.println("  예상 요청 " + estimate + "회 (요청 사이 " + avgDelayMs / 1000.0 + "초 안팎), 예상 소요 약 "
                + formatSeconds(estimate * avgDelayMs / 1000) + ", 한 회차 상한 " + job.maxRequests() + "회");

        MetricCollectJob.Result result = job.run(plan);

        result.saved().forEach((id, rows) -> System.out.println("  " + id + "  " + rows + "행"));
        System.out.println("[완료] 저장 " + result.saved().values().stream().mapToInt(Integer::intValue).sum() + "행"
                + (result.failures() > 0 ? ", 실패 " + result.failures() + "건(위 경고 참고)" : "")
                + (result.budgetStopped() ? ". 요청 상한에서 멈췄습니다. 같은 명령을 다시 실행하면 남은 날짜부터 이어서 받습니다." : "")
                + " 대시보드는 새로고침하면 반영됩니다.");
    }

    private static List<MetricSpec> specs(ApplicationArguments args) {
        List<String> only = args.getOptionValues("only");
        if (only == null || only.isEmpty()) {
            return MetricSpecs.ALL;
        }
        List<MetricSpec> specs = new ArrayList<>();
        for (String id : only.get(0).split(",")) {
            specs.add(MetricSpecs.find(id.trim()).orElseThrow(() -> new IllegalArgumentException(
                    "알 수 없는 지표: " + id + " (가능: " + MetricSpecs.ALL.stream().map(MetricSpec::id).toList() + ")")));
        }
        return specs;
    }

    private static LocalDate date(ApplicationArguments args, String name, LocalDate defaultValue) {
        List<String> values = args.getOptionValues(name);
        return values == null || values.isEmpty() ? defaultValue : LocalDate.parse(values.get(0));
    }

    private static int intOption(ApplicationArguments args, String name, int defaultValue) {
        List<String> values = args.getOptionValues(name);
        return values == null || values.isEmpty() ? defaultValue : Integer.parseInt(values.get(0));
    }

    static String formatSeconds(long seconds) {
        return seconds < 90 ? seconds + "초" : (seconds + 30) / 60 + "분";
    }
}
