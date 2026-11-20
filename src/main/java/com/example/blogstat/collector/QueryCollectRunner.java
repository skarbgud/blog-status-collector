package com.example.blogstat.collector;

import com.example.blogstat.domain.ReferrerDailyService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Set;

/**
 * `--app.mode=collect-queries [--days=30] [--from=YYYY-MM-DD --to=YYYY-MM-DD] [--force]`
 *
 * 검색어만 따로, 길게 거슬러 올라가며 수집한다. 유입경로 표는 건드리지 않는다.
 * - 끝 날짜 기본값은 어제(오늘은 집계 중이라 제외), 일수 기본값은 app.queries.default-days(30).
 * - 이미 검색어가 저장된 날짜는 건너뛴다. 다시 받으려면 --force.
 * 사람이 직접 실행하는 용도라 scripts/collect-queries.cmd로 감싸 두었다.
 */
@Component
@ConditionalOnProperty(name = "app.mode", havingValue = "collect-queries")
public class QueryCollectRunner implements ApplicationRunner {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    /** 날짜 하나당 대략 걸리는 시간(초). 검색 유입처 수와 지연 설정에 따라 달라지는 어림값이다. */
    private static final int SECONDS_PER_DAY = 20;

    private final CollectJob job;
    private final ReferrerDailyService service;
    private final int defaultDays;

    public QueryCollectRunner(CollectJob job, ReferrerDailyService service,
                              @Value("${app.queries.default-days}") int defaultDays) {
        this.job = job;
        this.service = service;
        this.defaultDays = defaultDays;
    }

    @Override
    public void run(ApplicationArguments args) {
        LocalDate to = date(args, "to", LocalDate.now(KST).minusDays(1));
        LocalDate from = args.containsOption("from")
                ? date(args, "from", to)
                : QueryBackfillPlanner.range(to, intOption(args, "days", defaultDays))[0];
        boolean force = args.containsOption("force");

        Set<LocalDate> existing = service.datesWithQueries(from, to);
        List<LocalDate> dates = QueryBackfillPlanner.plan(from, to, existing, force);

        int total = (int) (java.time.temporal.ChronoUnit.DAYS.between(from, to) + 1);
        System.out.println("[검색어 수집] " + from + " ~ " + to + " (" + total + "일)"
                + (force ? ", --force: 이미 있는 날짜도 다시 받음" : ""));
        if (dates.isEmpty()) {
            System.out.println("  모든 날짜에 이미 검색어가 있습니다. 다시 받으려면 --force를 주세요.");
            return;
        }
        System.out.println("  이번에 받을 날짜 " + dates.size() + "일 (이미 있어서 건너뜀 " + (total - dates.size())
                + "일), 예상 소요 약 " + formatSeconds((long) dates.size() * SECONDS_PER_DAY));

        List<CollectJob.QueryDayResult> results = job.runQueriesOnly(dates);

        int totalSaved = 0;
        for (CollectJob.QueryDayResult r : results) {
            System.out.println("  " + r.date() + "  " + (r.saved() < 0 ? "오늘 데이터라 건너뜀"
                    : "검색어 " + r.saved() + "건 (검색 유입처 " + r.domains() + "곳)"));
            totalSaved += Math.max(0, r.saved());
        }
        System.out.println("[완료] " + results.size() + "일 처리, 검색어 " + totalSaved + "건 저장. "
                + "대시보드는 새로고침하면 반영됩니다.");
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
