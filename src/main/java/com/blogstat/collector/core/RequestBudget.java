package com.blogstat.collector.core;

/**
 * 한 회차(수집 실행 한 번)에 보낼 수 있는 요청 수의 상한. 재시도도 실제 요청이므로 함께 센다.
 * 지표가 늘거나 보충 범위가 길어져도 네이버로 가는 요청이 한 번에 몰리지 않게 한다(저빈도 원칙).
 */
public final class RequestBudget {

    private final int limit;
    private int used;

    public RequestBudget(int limit) {
        if (limit < 1) {
            throw new IllegalArgumentException("요청 예산은 1 이상이어야 합니다: " + limit);
        }
        this.limit = limit;
    }

    /** 요청 하나를 쓴다. 이미 다 썼으면 요청을 보내지 않고 예외를 던진다. */
    public void acquire(String label) {
        if (used >= limit) {
            throw new BudgetExceededException(
                    "이번 회차 요청 예산(" + limit + "회)을 모두 사용해 " + label + "부터는 다음 회차에 수집합니다.");
        }
        used++;
    }

    public int used() {
        return used;
    }

    public int limit() {
        return limit;
    }
}
