package com.example.blogstat.schedule;

import com.example.blogstat.collector.CollectJob;
import com.example.blogstat.collector.SessionExpiredException;
import com.example.blogstat.domain.ReferrerDailyService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDate;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * `--app.mode=schedule`: 매일 정해진 시각에 어제까지의 빠진 날짜를 수집해 저장한다.
 * 앱을 켠 직후에도 한 번 실행해서, PC가 꺼져 있던 날을 보충한다.
 * 세션이 만료되면 재로그인 안내만 남기고 그 회차를 중단한다(다음 회차에 다시 시도).
 */
@Component
@ConditionalOnProperty(name = "app.mode", havingValue = "schedule")
public class ScheduledCollector {

    private static final Logger log = LoggerFactory.getLogger(ScheduledCollector.class);

    private final CollectJob job;
    private final ReferrerDailyService service;
    private final Clock clock;
    private final int maxCatchUpDays;
    private final boolean runOnStart;

    // 시작 시 실행과 cron 실행이 겹쳐 같은 날짜를 동시에 수집하지 않도록 막는다.
    private final AtomicBoolean running = new AtomicBoolean(false);

    public ScheduledCollector(CollectJob job,
                              ReferrerDailyService service,
                              Clock clock,
                              @Value("${app.schedule.max-catchup-days}") int maxCatchUpDays,
                              @Value("${app.schedule.run-on-start}") boolean runOnStart) {
        this.job = job;
        this.service = service;
        this.clock = clock;
        this.maxCatchUpDays = maxCatchUpDays;
        this.runOnStart = runOnStart;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onStart() {
        if (runOnStart) {
            log.info("시작 시 보충 수집을 실행합니다.");
            runOnce();
        }
    }

    @Scheduled(cron = "${app.schedule.cron}", zone = "Asia/Seoul")
    public void onSchedule() {
        runOnce();
    }

    void runOnce() {
        if (!running.compareAndSet(false, true)) {
            log.warn("이전 수집이 아직 진행 중이라 이번 회차는 건너뜁니다.");
            return;
        }
        try {
            LocalDate yesterday = LocalDate.now(clock).minusDays(1);
            Optional<CatchUpPlanner.Range> plan =
                    CatchUpPlanner.plan(service.latestStatDate().orElse(null), yesterday, maxCatchUpDays);
            if (plan.isEmpty()) {
                log.info("수집할 날짜가 없습니다. 어제({})까지 저장되어 있습니다.", yesterday);
                return;
            }
            CatchUpPlanner.Range range = plan.get();
            log.info("수집 시작: {} ~ {}", range.from(), range.to());
            var results = job.run(range.from(), range.to());
            log.info("수집 완료: {}일 처리", results.size());
        } catch (SessionExpiredException e) {
            log.error("로그인 세션이 만료되어 수집을 중단합니다. `--app.mode=login`으로 다시 로그인하세요. ({})",
                    e.getMessage());
        } catch (Exception e) {
            // 한 회차의 실패가 스케줄러 전체를 죽이지 않도록 로그만 남기고, 다음 회차에 다시 시도한다.
            log.error("수집 중 오류가 발생했습니다. 다음 회차에 다시 시도합니다.", e);
        } finally {
            running.set(false);
        }
    }
}
