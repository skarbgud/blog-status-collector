package com.example.blogstat.collector;

/** 저장된 로그인 세션이 만료되어 통계 페이지 대신 로그인 페이지로 이동했을 때 던진다. */
public class SessionExpiredException extends RuntimeException {

    public SessionExpiredException(String message) {
        super(message);
    }
}
