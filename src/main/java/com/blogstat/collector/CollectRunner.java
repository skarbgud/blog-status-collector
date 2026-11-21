package com.blogstat.collector;

import com.blogstat.domain.ReferrerDailyService;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;

/**
 * `--app.mode=collect [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]`
 * 기본값은 어제 하루. 수집 결과를 콘솔에 출력하고 H2에 저장한다.
 */
@Component
@ConditionalOnProperty(name = "app.mode", havingValue = "collect")
public class CollectRunner implements ApplicationRunner {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");

    private final CollectJob job;
    private final ReferrerDailyService service;

    public CollectRunner(CollectJob job, ReferrerDailyService service) {
        this.job = job;
        this.service = service;
    }

    @Override
    public void run(ApplicationArguments args) {
        LocalDate yesterday = LocalDate.now(KST).minusDays(1);
        LocalDate from = option(args, "from", yesterday);
        LocalDate to = option(args, "to", from);

        for (CollectJob.DayResult result : job.run(from, to)) {
            RefererDay day = result.day();
            System.out.println("== " + day.date() + (day.today() ? " (오늘, 집계 중)" : "")
                    + " 합계 " + day.sumVisits() + " / API 합계 " + day.totalCount());
            for (RefererRow row : day.rows()) {
                System.out.printf("   %-24s %5d  %6.2f%%%s%n", row.referrer(), row.visits(), row.ratio(),
                        row.searchEngine() ? "  [검색]" : "");
            }
            if (!day.queries().isEmpty()) {
                System.out.println("   검색어 " + day.queries().size() + "건:");
                for (SearchQueryRow q : day.queries()) {
                    System.out.printf("     %-24s %3d  %s%n", q.referrer(), q.visits(), q.query());
                }
            }
            System.out.println(result.saved() < 0
                    ? "   → 집계 중인 오늘 데이터라 저장하지 않음"
                    : "   → H2 저장 " + result.saved() + "행, 검색어 " + service.countQueries(day.date())
                    + "건 (DB의 해당 날짜 유입경로 행 수: " + service.count(day.date()) + ")");
        }
    }

    private static LocalDate option(ApplicationArguments args, String name, LocalDate defaultValue) {
        List<String> values = args.getOptionValues(name);
        return values == null || values.isEmpty() ? defaultValue : LocalDate.parse(values.get(0));
    }
}
