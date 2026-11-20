package com.example.blogstat.domain;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** 지표 행을 저장한다. 같은 지표·날짜를 다시 저장하면 교체되므로 몇 번 수집해도 결과가 같다(멱등). */
@Service
public class MetricService {

    private final MetricRowRepository repository;

    public MetricService(MetricRowRepository repository) {
        this.repository = repository;
    }

    /**
     * 한 지표에서 rows가 가진 날짜들의 기존 행을 지우고 rows를 넣는다. 다른 날짜와 다른 지표는 건드리지 않는다.
     * 날짜 단위로 전부 저장되거나 전부 롤백된다.
     *
     * @return 저장한 행 수
     */
    @Transactional
    public int replace(String metric, List<MetricRow> rows) {
        if (rows.isEmpty()) {
            return 0;
        }
        Set<LocalDate> dates = new HashSet<>();
        for (MetricRow row : rows) {
            if (!row.getMetric().equals(metric)) {
                throw new IllegalArgumentException("다른 지표의 행이 섞여 있습니다: " + row.getMetric() + " != " + metric);
            }
            dates.add(row.getStatDate());
        }
        repository.deleteByMetricAndStatDates(metric, dates);
        repository.saveAll(rows);
        return (int) rows.stream().filter(r -> !MetricRow.EMPTY_KEY.equals(r.getRowKey())).count();
    }

    /**
     * 그 지표의 그 날짜 행을 지운다. 집계 전이라 값이 아직 확정되지 않은 날을 다시 받았을 때,
     * 앞서 저장된 잠정값(예: 모두 0)이 남아 화면에 잘못 보이지 않게 정리한다.
     */
    @Transactional
    public int clear(String metric, LocalDate date) {
        return repository.deleteByMetricAndStatDates(metric, Set.of(date));
    }

    /** 그 지표가 이미 저장된(빈 표시 포함) 날짜들. */
    @Transactional(readOnly = true)
    public Set<LocalDate> datesWith(String metric, LocalDate from, LocalDate to) {
        return new HashSet<>(repository.findDatesWithMetric(metric, from, to));
    }

    @Transactional(readOnly = true)
    public List<MetricRow> find(LocalDate from, LocalDate to) {
        return repository.findByStatDateBetweenOrderByStatDateAscMetricAscIdAsc(from, to);
    }

    @Transactional(readOnly = true)
    public java.util.Optional<LocalDate> latestDate() {
        return repository.findLatestStatDate();
    }

    @Transactional(readOnly = true)
    public Collection<MetricRowRepository.MetricSummary> summary() {
        return repository.summarize();
    }
}
