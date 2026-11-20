package com.example.blogstat.collector.core;

/**
 * 한 회차의 요청 예산을 다 써서 수집을 멈출 때 던진다. 오류가 아니라 "나머지는 다음 회차에"라는 신호다.
 * 소스가 IllegalStateException을 잡아 건너뛰는 경우가 있어서, 거기에 걸리지 않도록 RuntimeException을 직접 상속한다.
 */
public class BudgetExceededException extends RuntimeException {

    public BudgetExceededException(String message) {
        super(message);
    }
}
