package com.blogstat.collector.core;

/**
 * 재시도·지연 정책 없이 GET 한 번만 보내는 가장 아래 계층.
 * 실제 구현은 Playwright의 APIRequestContext이고, 테스트에서는 가짜로 바꿔 끼운다.
 */
@FunctionalInterface
public interface RawHttp {

    /**
     * @throws TransportException 타임아웃·네트워크 오류(재시도 대상)
     */
    RawResponse get(String url);

    /** retryAfter: Retry-After 헤더 원문(없으면 null) */
    record RawResponse(int status, String retryAfter, String body) {
    }

    /** 응답을 받지 못한 경우(타임아웃, 연결 실패). 재시도 대상이다. */
    class TransportException extends RuntimeException {
        public TransportException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
