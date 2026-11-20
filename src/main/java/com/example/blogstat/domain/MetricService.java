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
        return replace(metric, rows, null);
    }

    /**
     * 게시글별 지표처럼 같은 날짜에 여러 행 구분(게시글)이 섞여 있으면 rowKey로 그 행 구분만 교체한다.
     * rowKey가 null이면 그 지표의 해당 날짜 전체를 교체한다.
     */
    @Transactional
    public int replace(String metric, List<MetricRow> rows, String rowKey) {
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
        if (rowKey == null) {
            repository.deleteByMetricAndStatDates(metric, dates);
        } else {
            repository.deleteByMetricAndRowKeyAndStatDates(metric, rowKey, dates);
        }
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

    /** 그 지표의 가장 최근 저장 날짜의 행들. 저장된 것이 없으면 빈 목록. */
    @Transactional(readOnly = true)
    public List<MetricRow> latestOf(String metric) {
        return repository.findLatestStatDateOf(metric)
                .map(d -> repository.findByMetricAndStatDateOrderByIdAsc(metric, d))
                .orElse(List.of());
    }

    /** 그 지표·날짜에 저장된 행 구분값들(게시글별 지표면 게시글 번호). */
    @Transactional(readOnly = true)
    public Set<String> keysWith(String metric, LocalDate date) {
        return new HashSet<>(repository.findRowKeys(metric, date));
    }

    /**
     * 기간 안의 조회수·공감·댓글 순위에 한 번이라도 나온 게시글 번호(contentId)들.
     * 순위의 uri(예: http://blog.naver.com/아이디/224476308011) 마지막 마디가 게시글 번호다.
     */
    @Transactional(readOnly = true)
    public Set<String> postIds(LocalDate from, LocalDate to) {
        Set<String> ids = new java.util.TreeSet<>();
        for (String payload : repository.findPayloads(List.of("RANK_POST", "RANK_LIKE", "RANK_COMMENT"), from, to)) {
            java.util.regex.Matcher m = POST_URI.matcher(payload);
            if (m.find()) {
                ids.add(m.group(1));
            }
        }
        return ids;
    }

    private static final java.util.regex.Pattern POST_URI =
            java.util.regex.Pattern.compile("\"uri\":\"https?://blog\\.naver\\.com/[^/\"]+/(\\d+)\"");

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
