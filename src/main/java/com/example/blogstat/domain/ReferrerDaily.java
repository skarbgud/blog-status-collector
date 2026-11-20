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

/** 날짜별 유입경로 통계 한 줄. (statDate, referrerName)이 유일하다. */
@Entity
@Table(name = "referrer_daily",
        uniqueConstraints = @UniqueConstraint(
                name = "uk_referrer_daily_date_name", columnNames = {"stat_date", "referrer_name"}))
public class ReferrerDaily {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "stat_date", nullable = false)
    private LocalDate statDate;

    @Column(name = "referrer_name", nullable = false)
    private String referrerName;

    @Column(nullable = false)
    private int visits;

    /** 유입 비율(퍼센트). */
    @Column(nullable = false)
    private double ratio;

    @Column(name = "search_engine", nullable = false)
    private boolean searchEngine;

    @Column(name = "collected_at", nullable = false)
    private LocalDateTime collectedAt;

    protected ReferrerDaily() {
        // JPA
    }

    public ReferrerDaily(LocalDate statDate, String referrerName, int visits, double ratio,
                         boolean searchEngine, LocalDateTime collectedAt) {
        this.statDate = statDate;
        this.referrerName = referrerName;
        this.visits = visits;
        this.ratio = ratio;
        this.searchEngine = searchEngine;
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

    public int getVisits() {
        return visits;
    }

    public double getRatio() {
        return ratio;
    }

    public boolean isSearchEngine() {
        return searchEngine;
    }

    public LocalDateTime getCollectedAt() {
        return collectedAt;
    }
}
