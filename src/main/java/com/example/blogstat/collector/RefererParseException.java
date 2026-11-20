package com.example.blogstat.collector;

/** 응답 구조가 예상과 다르거나 검증(합계 일치 등)에 실패했을 때. 잘못된 데이터를 저장하지 않으려고 던진다. */
public class RefererParseException extends RuntimeException {

    public RefererParseException(String message) {
        super(message);
    }

    public RefererParseException(String message, Throwable cause) {
        super(message, cause);
    }
}
