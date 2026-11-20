package com.example.blogstat.collector;

import com.example.blogstat.collector.core.BudgetExceededException;
import com.example.blogstat.domain.ReferrerDailyService;
import com.example.blogstat.replica.SnapshotPublisher;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/**
 * 수집하고 바로 저장한다. CLI 러너와 스케줄러가 함께 쓴다.
 * 저장이 끝나면(중간에 실패해도 그때까지 저장된 것을) 읽기 전용 대시보드가 가져갈 스냅샷을 내보낸다.
 */
@Component
public class CollectJob {

    /** saved: 저장한 행 수, 집계 중인 오늘 데이터라 건너뛰었으면 -1 */
    public record DayResult(RefererDay day, int saved) {
    }

    /** 검색어만 수집한 날짜 하나의 결과. saved: 저장한 검색어 수, 오늘 데이터라 건너뛰었으면 -1 */
    public record QueryDayResult(LocalDate date, int saved, int domains) {
    }

    private final RefererCollector collector;
    private final ReferrerDailyService service;
    // 대시보드 프로필에는 없는 빈이라 ObjectProvider로 받는다.
    private final ObjectProvider<SnapshotPublisher> publisher;

    public CollectJob(RefererCollector collector, ReferrerDailyService service,
                      ObjectProvider<SnapshotPublisher> publisher) {
        this.collector = collector;
        this.service = service;
        this.publisher = publisher;
    }

    /**
     * 날짜를 받는 즉시 저장하므로, 중간에 예외가 나도 앞 날짜들은 DB에 남는다.
     * 요청 예산을 다 쓰면 거기서 멈추고 지금까지의 결과를 돌려준다(남은 날짜는 다음 회차의 보충 수집이 가져간다).
     */
    public List<DayResult> run(LocalDate from, LocalDate to) {
        List<DayResult> results = new ArrayList<>();
        try {
            collector.collect(from, to, day -> results.add(new DayResult(day, service.save(day))));
        } catch (BudgetExceededException e) {
            System.out.println("[예산] " + e.getMessage());
        } finally {
            publishSnapshot();
        }
        return results;
    }

    /**
     * 검색어만 교체 저장한다(유입경로 표는 건드리지 않는다).
     * 어떤 유입처가 검색 유입인지 알아야 하므로 날짜마다 유입처 합계 API도 한 번 호출하지만 저장은 하지 않는다.
     *
     * @param dates 수집할 날짜(오래된 순). 이미 가진 날짜를 뺄지는 호출한 쪽이 {@link QueryBackfillPlanner}로 정한다
     */
    public List<QueryDayResult> runQueriesOnly(List<LocalDate> dates) {
        List<QueryDayResult> results = new ArrayList<>();
        try {
            collector.collect(dates, day -> {
                int searchDomains = (int) day.rows().stream().filter(RefererRow::searchEngine).count();
                results.add(new QueryDayResult(day.date(), service.saveQueries(day), searchDomains));
            });
        } catch (BudgetExceededException e) {
            System.out.println("[예산] " + e.getMessage());
        } finally {
            publishSnapshot();
        }
        return results;
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
