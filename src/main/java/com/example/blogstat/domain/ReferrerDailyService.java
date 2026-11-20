package com.example.blogstat.domain;

import com.example.blogstat.collector.RefererDay;
import com.example.blogstat.collector.SearchQueryRow;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** 수집 결과를 H2에 저장한다. 날짜 단위로 전부 저장되거나 전부 롤백된다. */
@Service
public class ReferrerDailyService {

    private final ReferrerDailyRepository repository;
    private final SearchQueryDailyRepository queryRepository;
    private final Clock clock;

    public ReferrerDailyService(ReferrerDailyRepository repository,
                                SearchQueryDailyRepository queryRepository,
                                Clock clock) {
        this.repository = repository;
        this.queryRepository = queryRepository;
        this.clock = clock;
    }

    /**
     * 그 날짜의 기존 행(유입경로와 검색어)을 지우고 새로 넣는다(멱등).
     * 재수집 사이에 사라진 유입경로와 검색어도 함께 정리된다.
     * 집계 중인 오늘 데이터는 값이 계속 바뀌므로 저장하지 않는다.
     *
     * @return 저장한 유입경로 행 수. 오늘 데이터라 건너뛰었으면 -1
     */
    @Transactional
    public int save(RefererDay day) {
        if (day.today()) {
            return -1;
        }
        repository.deleteByStatDate(day.date());
        queryRepository.deleteByStatDate(day.date());

        LocalDateTime now = LocalDateTime.now(clock);
        List<ReferrerDaily> entities = day.rows().stream()
                .map(r -> new ReferrerDaily(r.date(), r.referrer(), r.visits(), r.ratio(), r.searchEngine(), now))
                .toList();
        repository.saveAll(entities);
        queryRepository.saveAll(mergeQueries(day.queries(), now));
        return entities.size();
    }

    /**
     * 검색어만 교체 저장한다. 유입경로(referrer_daily)는 건드리지 않는다.
     * 검색어만 따로 길게 거슬러 올라가 수집할 때 쓴다. 오늘 데이터는 저장하지 않는다.
     *
     * @return 저장한 검색어 수. 오늘 데이터라 건너뛰었으면 -1
     */
    @Transactional
    public int saveQueries(RefererDay day) {
        if (day.today()) {
            return -1;
        }
        queryRepository.deleteByStatDate(day.date());
        List<SearchQueryDaily> entities = mergeQueries(day.queries(), LocalDateTime.now(clock));
        queryRepository.saveAll(entities);
        return entities.size();
    }

    /** 기간 안에서 검색어가 이미 저장된 날짜들. */
    @Transactional(readOnly = true)
    public Set<LocalDate> datesWithQueries(LocalDate from, LocalDate to) {
        return new HashSet<>(queryRepository.findDatesWithQueries(from, to));
    }

    /**
     * 같은 (유입처, 검색어)가 한 날짜에 두 번 오면 유니크 제약에 걸리므로 방문수와 비율을 합쳐서 하나로 만든다.
     * 순서는 처음 나온 순서를 유지한다.
     */
    private static List<SearchQueryDaily> mergeQueries(List<SearchQueryRow> rows, LocalDateTime now) {
        Map<String, SearchQueryRow> merged = new LinkedHashMap<>();
        for (SearchQueryRow r : rows) {
            merged.merge(r.referrer() + "\u0000" + r.query(), r, (a, b) -> new SearchQueryRow(
                    a.date(), a.referrer(), a.query(), a.visits() + b.visits(), a.ratio() + b.ratio()));
        }
        return merged.values().stream()
                .map(r -> new SearchQueryDaily(r.date(), r.referrer(), r.query(), r.visits(), r.ratio(), now))
                .toList();
    }

    @Transactional(readOnly = true)
    public long count(LocalDate date) {
        return repository.countByStatDate(date);
    }

    @Transactional(readOnly = true)
    public long countQueries(LocalDate date) {
        return queryRepository.countByStatDate(date);
    }

    /** 저장된 가장 최근 날짜. 아무것도 없으면 empty. */
    @Transactional(readOnly = true)
    public Optional<LocalDate> latestStatDate() {
        return repository.findLatestStatDate();
    }
}
