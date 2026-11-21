package com.blogstat.collector.core;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** `app.collect.*` 설정 묶음. 수집 클라이언트와 소스가 함께 쓴다. */
@Component
public class CollectSettings {

    private final String baseUrl;
    private final String refererPage;
    private final long minDelayMs;
    private final long maxDelayMs;
    private final int maxRetries;
    private final long baseBackoffMs;
    private final long capBackoffMs;
    private final long requestTimeoutMs;
    private final boolean headless;
    private final int querySize;
    private final int maxRequestsPerRun;

    public CollectSettings(@Value("${app.stat-url}") String statUrl,
                           @Value("${app.collect.base-url}") String baseUrl,
                           @Value("${app.collect.min-delay-ms}") long minDelayMs,
                           @Value("${app.collect.max-delay-ms}") long maxDelayMs,
                           @Value("${app.collect.max-retries}") int maxRetries,
                           @Value("${app.collect.base-backoff-ms}") long baseBackoffMs,
                           @Value("${app.collect.cap-backoff-ms}") long capBackoffMs,
                           @Value("${app.collect.request-timeout-ms}") long requestTimeoutMs,
                           @Value("${app.collect.headless}") boolean headless,
                           @Value("${app.collect.query-size}") int querySize,
                           @Value("${app.collect.max-requests-per-run}") int maxRequestsPerRun) {
        if (minDelayMs > maxDelayMs) {
            throw new IllegalArgumentException("min-delay-ms가 max-delay-ms보다 큽니다.");
        }
        this.refererPage = statUrl;
        this.baseUrl = baseUrl;
        this.minDelayMs = minDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.maxRetries = maxRetries;
        this.baseBackoffMs = baseBackoffMs;
        this.capBackoffMs = capBackoffMs;
        this.requestTimeoutMs = requestTimeoutMs;
        this.headless = headless;
        this.querySize = querySize;
        this.maxRequestsPerRun = maxRequestsPerRun;
    }

    public String baseUrl() {
        return baseUrl;
    }

    /** API 요청의 Referer 헤더로 보내는 통계 화면 주소. */
    public String refererPage() {
        return refererPage;
    }

    public long minDelayMs() {
        return minDelayMs;
    }

    public long maxDelayMs() {
        return maxDelayMs;
    }

    public int maxRetries() {
        return maxRetries;
    }

    public long baseBackoffMs() {
        return baseBackoffMs;
    }

    public long capBackoffMs() {
        return capBackoffMs;
    }

    public long requestTimeoutMs() {
        return requestTimeoutMs;
    }

    public boolean headless() {
        return headless;
    }

    public int querySize() {
        return querySize;
    }

    public int maxRequestsPerRun() {
        return maxRequestsPerRun;
    }
}
