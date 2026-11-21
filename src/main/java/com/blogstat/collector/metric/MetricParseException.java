package com.blogstat.collector.metric;

/** 지표 응답의 구조가 예상과 다를 때. 잘못된 값을 저장하지 않으려고 던진다. */
public class MetricParseException extends RuntimeException {

    public MetricParseException(String message) {
        super(message);
    }

    public MetricParseException(String message, Throwable cause) {
        super(message, cause);
    }
}
