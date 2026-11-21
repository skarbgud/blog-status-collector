package com.blogstat.collector;

/** 지수 백오프 + 풀 지터: delay = random(0, min(cap, base * 2^attempt)). */
public final class Backoff {

    private Backoff() {
    }

    /**
     * @param attempt 0부터 시작하는 재시도 횟수
     * @param random  [0, 1) 난수. 테스트에서 고정값을 넣으려고 인자로 받는다.
     */
    public static long delayMillis(int attempt, long baseMs, long capMs, double random) {
        long exp = baseMs * (1L << Math.min(attempt, 20));
        long ceiling = Math.min(capMs, exp);
        return (long) (random * ceiling);
    }
}
