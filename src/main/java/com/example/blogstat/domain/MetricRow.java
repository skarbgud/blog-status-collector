package com.example.blogstat.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * 통계 지표 한 행. 유입경로·검색어 말고 나머지 지표(조회수, 방문자, 시간대, 성별·연령, 순위 등)를 모두 이 표 하나에 담는다.
 * 지표마다 컬럼이 달라서 표를 늘리는 대신, 응답의 컬럼들을 JSON 한 덩어리({@link #payload})로 저장한다.
 * (statDate, metric, rowKey)가 유일하다.
 */
@Entity
@Table(name = "metric_row",
        uniqueConstraints = @UniqueConstraint(
                name = "uk_metric_row",
                columnNames = {"stat_date", "metric", "row_key"}))
public class MetricRow {

    /** 그 날짜·지표에 데이터가 없다는 표시. 빈 날짜를 매번 다시 요청하지 않으려고 남긴다. 화면에는 내보내지 않는다. */
    public static final String EMPTY_KEY = "_empty";

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "stat_date", nullable = false)
    private LocalDate statDate;

    @Column(nullable = false, length = 40)
    private String metric;

    /** 같은 날짜·지표 안에서 행을 구분하는 값(연령 코드, 시간, 국가, 순위 번호, 이웃 구분 등). 시계열은 "all". */
    @Column(name = "row_key", nullable = false, length = 200)
    private String rowKey;

    /** 응답 컬럼을 이름→값으로 담은 JSON 객체. */
    @Column(nullable = false, length = 4000)
    private String payload;

    @Column(name = "collected_at", nullable = false)
    private LocalDateTime collectedAt;

    protected MetricRow() {
        // JPA
    }

    public MetricRow(LocalDate statDate, String metric, String rowKey, String payload, LocalDateTime collectedAt) {
        this.statDate = statDate;
        this.metric = metric;
        this.rowKey = rowKey;
        this.payload = payload;
        this.collectedAt = collectedAt;
    }

    public Long getId() {
        return id;
    }

    public LocalDate getStatDate() {
        return statDate;
    }

    public String getMetric() {
        return metric;
    }

    public String getRowKey() {
        return rowKey;
    }

    public String getPayload() {
        return payload;
    }

    public LocalDateTime getCollectedAt() {
        return collectedAt;
    }
}
