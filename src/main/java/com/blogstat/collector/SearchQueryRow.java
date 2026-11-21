package com.blogstat.collector;

import java.time.LocalDate;

/**
 * 검색 유입처(예: 네이버 통합검색_모바일) 아래에서 들어온 검색어 한 줄.
 *
 * @param ratio 그 유입처 안에서의 비율(퍼센트). 전체 방문 대비가 아니다.
 */
public record SearchQueryRow(LocalDate date, String referrer, String query, int visits, double ratio) {
}
