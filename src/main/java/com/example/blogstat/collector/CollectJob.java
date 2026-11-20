package com.example.blogstat.collector;

import com.example.blogstat.domain.ReferrerDailyService;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;

/** 수집하고 바로 저장한다. CLI 러너와 스케줄러가 함께 쓴다. */
@Component
public class CollectJob {

    /** saved: 저장한 행 수, 집계 중인 오늘 데이터라 건너뛰었으면 -1 */
    public record DayResult(RefererDay day, int saved) {
    }

    private final RefererCollector collector;
    private final ReferrerDailyService service;

    public CollectJob(RefererCollector collector, ReferrerDailyService service) {
        this.collector = collector;
        this.service = service;
    }

    /** 날짜를 받는 즉시 저장하므로, 중간에 예외가 나도 앞 날짜들은 DB에 남는다. */
    public List<DayResult> run(LocalDate from, LocalDate to) {
        List<DayResult> results = new ArrayList<>();
        collector.collect(from, to, day -> results.add(new DayResult(day, service.save(day))));
        return results;
    }
}
