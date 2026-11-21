package com.blogstat.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.LocalDate;
import java.time.LocalDateTime;

/** 날짜별, 검색 유입처별 검색어. (statDate, referrerName, searchQuery)가 유일하다. */
@Entity
@Table(name = "search_query_daily",
        uniqueConstraints = @UniqueConstraint(
                name = "uk_search_query_daily",
                columnNames = {"stat_date", "referrer_name", "search_query"}))
public class SearchQueryDaily {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "stat_date", nullable = false)
    private LocalDate statDate;

    @Column(name = "referrer_name", nullable = false)
    private String referrerName;

    @Column(name = "search_query", nullable = false, length = 500)
    private String searchQuery;

    @Column(nullable = false)
    private int visits;

    /** 그 유입처 안에서의 비율(퍼센트). */
    @Column(nullable = false)
    private double ratio;

    @Column(name = "collected_at", nullable = false)
    private LocalDateTime collectedAt;

    protected SearchQueryDaily() {
        // JPA
    }

    public SearchQueryDaily(LocalDate statDate, String referrerName, String searchQuery, int visits,
                            double ratio, LocalDateTime collectedAt) {
        this.statDate = statDate;
        this.referrerName = referrerName;
        this.searchQuery = searchQuery;
        this.visits = visits;
        this.ratio = ratio;
        this.collectedAt = collectedAt;
    }

    public Long getId() {
        return id;
    }

    public LocalDate getStatDate() {
        return statDate;
    }

    public String getReferrerName() {
        return referrerName;
    }

    public String getSearchQuery() {
        return searchQuery;
    }

    public int getVisits() {
        return visits;
    }

    public double getRatio() {
        return ratio;
    }

    public LocalDateTime getCollectedAt() {
        return collectedAt;
    }
}
