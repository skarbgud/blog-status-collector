package com.blogstat.collector.source;

import com.blogstat.collector.core.StatHttp;

import java.time.LocalDate;

/**
 * 네이버 통계의 지표 하나(유입경로, 조회수, 게시글 순위 등)를 날짜 단위로 가져오는 소스.
 * 소스는 URL 생성과 응답 파싱만 맡는다. 지연·예산·재시도·세션 판정은 {@link StatHttp}가 맡는다.
 *
 * @param <T> 하루치 결과
 */
public interface StatSource<T> {

    /** 수집 기록·로그에 쓰는 고정 식별자(예: REFERER). 바꾸면 기존 수집 기록과 연결이 끊긴다. */
    String id();

    /** 하루치를 가져온다. 이 날의 요청은 모두 http로 보낸다. */
    T fetch(StatHttp http, LocalDate date);
}
