package com.example.blogstat.domain;

import com.example.blogstat.collector.RefererDay;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.LocalDateTime;
import java.util.List;

/** 수집 결과를 H2에 저장한다. 날짜 단위로 전부 저장되거나 전부 롤백된다. */
@Service
public class ReferrerDailyService {

    private final ReferrerDailyRepository repository;
    private final Clock clock;

    public ReferrerDailyService(ReferrerDailyRepository repository, Clock clock) {
        this.repository = repository;
        this.clock = clock;
    }

    /**
     * 그 날짜의 기존 행을 지우고 새로 넣는다(멱등). 재수집 사이에 사라진 유입경로도 함께 정리된다.
     * 집계 중인 오늘 데이터는 값이 계속 바뀌므로 저장하지 않는다.
     *
     * @return 저장한 행 수. 오늘 데이터라 건너뛰었으면 -1
     */
    @Transactional
    public int save(RefererDay day) {
        if (day.today()) {
            return -1;
        }
        repository.deleteByStatDate(day.date());

        LocalDateTime now = LocalDateTime.now(clock);
        List<ReferrerDaily> entities = day.rows().stream()
                .map(r -> new ReferrerDaily(r.date(), r.referrer(), r.visits(), r.ratio(), r.searchEngine(), now))
                .toList();
        repository.saveAll(entities);
        return entities.size();
    }

    @Transactional(readOnly = true)
    public long count(java.time.LocalDate date) {
        return repository.countByStatDate(date);
    }
}
