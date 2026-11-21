package com.blogstat.dashboard;

import com.blogstat.domain.SearchQueryDailyRepository;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDate;
import java.util.List;

/**
 * 검색어 변화: 지난주 대비 오르고 내린 검색어, 새로 뜬 검색어.
 * /api/dashboard/ 아래라 대시보드 프로필에서는 스냅샷 자동 반영과 읽기 잠금이 그대로 적용된다.
 */
@RestController
@RequestMapping("/api/dashboard")
public class KeywordTrendController {

    static final int DEFAULT_LOOKBACK = 28;
    static final int MAX_LOOKBACK = 365;
    static final int MAX_LIMIT = 100;

    private final SearchQueryDailyRepository repository;

    public KeywordTrendController(SearchQueryDailyRepository repository) {
        this.repository = repository;
    }

    /**
     * @param to       기준일(이번 주의 마지막 날). 생략하면 검색어가 저장된 가장 최근 날짜
     * @param lookback "새로 뜬" 판정에 쓰는 과거 일수(지난주 포함). 기본 28일
     * @param limit    목록마다 최대 개수. 기본 20
     */
    @GetMapping("/keyword-trends")
    @Transactional(readOnly = true)
    public KeywordTrends.Report trends(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
            @RequestParam(defaultValue = "" + DEFAULT_LOOKBACK) int lookback,
            @RequestParam(defaultValue = "20") int limit) {
        if (lookback < KeywordTrends.WINDOW_DAYS || lookback > MAX_LOOKBACK) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "lookback은 " + KeywordTrends.WINDOW_DAYS + "~" + MAX_LOOKBACK + "일이어야 합니다.");
        }
        if (limit < 1 || limit > MAX_LIMIT) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "limit은 1~" + MAX_LIMIT + "이어야 합니다.");
        }
        LocalDate anchor = to != null ? to : repository.findLatestStatDate().orElse(null);
        if (anchor == null) {
            // 검색어가 하나도 없으면 빈 결과(화면은 "데이터 없음"을 보여준다).
            LocalDate today = LocalDate.now();
            return KeywordTrends.compute(List.of(), today, lookback, limit);
        }
        List<KeywordTrends.Row> rows = repository
                .findByStatDateBetween(KeywordTrends.historyFrom(anchor, lookback), anchor).stream()
                .map(q -> new KeywordTrends.Row(q.getStatDate(), q.getSearchQuery(), q.getVisits()))
                .toList();
        return KeywordTrends.compute(rows, anchor, lookback, limit);
    }
}
