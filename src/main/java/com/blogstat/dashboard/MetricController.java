package com.blogstat.dashboard;

import com.blogstat.dashboard.MetricQueryService.MetricsView;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDate;

/** 읽기 전용 지표 조회 API. from/to(YYYY-MM-DD)를 생략하면 가장 최근 저장일 기준 최근 30일이다. */
@RestController
@RequestMapping("/api/dashboard")
public class MetricController {

    private final MetricQueryService service;

    public MetricController(MetricQueryService service) {
        this.service = service;
    }

    @GetMapping("/metrics")
    public MetricsView metrics(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        try {
            return service.view(from, to);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }
}
