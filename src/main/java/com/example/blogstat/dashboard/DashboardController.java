package com.example.blogstat.dashboard;

import com.example.blogstat.dashboard.DashboardService.DailyPoint;
import com.example.blogstat.dashboard.DashboardService.Period;
import com.example.blogstat.dashboard.DashboardService.ReferrerShare;
import com.example.blogstat.dashboard.DashboardService.Summary;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDate;
import java.util.List;

/** 읽기 전용 조회 API. from/to(YYYY-MM-DD)를 생략하면 가장 최근 저장일 기준 최근 30일이다. */
@RestController
@RequestMapping("/api/dashboard")
public class DashboardController {

    private final DashboardService service;

    public DashboardController(DashboardService service) {
        this.service = service;
    }

    @GetMapping("/summary")
    public Summary summary(@RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
                           @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        return service.summary(period(from, to));
    }

    @GetMapping("/daily")
    public List<DailyPoint> daily(@RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
                                  @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        return service.daily(period(from, to));
    }

    @GetMapping("/referrers")
    public List<ReferrerShare> referrers(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
            @RequestParam(defaultValue = "10") int limit) {
        return service.referrers(period(from, to), limit);
    }

    private Period period(LocalDate from, LocalDate to) {
        try {
            return service.resolve(from, to);
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
        }
    }
}
