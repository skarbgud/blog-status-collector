package com.example.blogstat.dashboard;

import com.example.blogstat.domain.MetricRow;
import com.example.blogstat.domain.MetricRowRepository.MetricSummary;
import com.example.blogstat.domain.MetricService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 대시보드가 읽는 지표(조회수, 방문자, 시간대, 성별·연령, 순위 등). 조회 전용이다. */
@Service
public class MetricQueryService {

    /** 한 번에 내보낼 수 있는 최대 기간. 하루 단위 지표가 날짜당 수십 행이라 응답이 너무 커지지 않게 막는다. */
    static final int MAX_DAYS = 366;
    static final int DEFAULT_DAYS = 30;

    public record Item(String date, String metric, String key, Map<String, Object> values) {
    }

    /** 지표별 저장 현황(어느 날짜까지 몇 행). 수집이 빠진 지표를 화면에서 알아보게 한다. */
    public record Coverage(String metric, long rows, String firstDate, String lastDate) {
    }

    /**
     * @param ready false면 아직 지표가 한 번도 수집되지 않았거나 스냅샷에 지표 표가 없다
     */
    public record MetricsView(boolean ready, String from, String to, String latest,
                              List<Coverage> coverage, List<Item> items) {
    }

    private final MetricService service;
    private final ObjectMapper mapper = new ObjectMapper();

    public MetricQueryService(MetricService service) {
        this.service = service;
    }

    /** from/to를 생략하면 가장 최근 저장일 기준 최근 30일. */
    public MetricsView view(LocalDate from, LocalDate to) {
        LocalDate latest;
        try {
            latest = service.latestDate().orElse(null);
        } catch (DataAccessException e) {
            return new MetricsView(false, null, null, null, List.of(), List.of());
        }
        if (latest == null) {
            return new MetricsView(false, null, null, null, List.of(), List.of());
        }
        LocalDate end = to != null ? to : latest;
        LocalDate start = from != null ? from : end.minusDays(DEFAULT_DAYS - 1L);
        if (start.isAfter(end)) {
            throw new IllegalArgumentException("from이 to보다 늦습니다: " + start + " > " + end);
        }
        if (start.plusDays(MAX_DAYS).isBefore(end)) {
            throw new IllegalArgumentException("기간은 최대 " + MAX_DAYS + "일까지 조회할 수 있습니다.");
        }

        List<Item> items = new ArrayList<>();
        for (MetricRow row : service.find(start, end)) {
            if (MetricRow.EMPTY_KEY.equals(row.getRowKey())) {
                continue;
            }
            items.add(new Item(row.getStatDate().toString(), row.getMetric(), row.getRowKey(), values(row)));
        }
        List<Coverage> coverage = new ArrayList<>();
        for (MetricSummary s : service.summary()) {
            coverage.add(new Coverage(s.getMetric(), s.getRows(), s.getFirstDate().toString(),
                    s.getLastDate().toString()));
        }
        return new MetricsView(true, start.toString(), end.toString(), latest.toString(), coverage, items);
    }

    private Map<String, Object> values(MetricRow row) {
        try {
            return mapper.readValue(row.getPayload(), new TypeReference<LinkedHashMap<String, Object>>() {
            });
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("저장된 지표 값을 읽지 못했습니다: " + row.getMetric() + " " + row.getStatDate(), e);
        }
    }
}
