package com.example.blogstat.collector.core;

/**
 * 소스(StatSource)가 쓰는 GET. 요청 사이 지연, 회차 예산, 재시도, 세션 만료 판정이 모두 적용된 상태다.
 * 소스는 이 정책을 몰라도 되고, URL을 만들고 본문을 파싱하는 일만 한다.
 */
@FunctionalInterface
public interface StatHttp {

    /**
     * @param label 로그·오류 메시지에 쓰는 사람용 이름(예: "2026-11-19 검색어")
     * @return 200 응답 본문
     * @throws com.example.blogstat.collector.SessionExpiredException 401/403
     * @throws BudgetExceededException 이번 회차의 요청 예산을 다 썼을 때
     * @throws IllegalStateException   재시도할 수 없는 상태 코드이거나 재시도를 다 썼을 때
     */
    String get(String url, String label);
}
