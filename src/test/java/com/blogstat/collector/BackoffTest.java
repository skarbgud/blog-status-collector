package com.blogstat.collector;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class BackoffTest {

    @Test
    void 상한은_시도마다_두배로_늘어난다() {
        // random=0.999...에 가까운 값이면 거의 상한값
        assertEquals(500, Backoff.delayMillis(0, 1000, 30_000, 0.5));
        assertEquals(1000, Backoff.delayMillis(1, 1000, 30_000, 0.5));
        assertEquals(2000, Backoff.delayMillis(2, 1000, 30_000, 0.5));
    }

    @Test
    void cap을_넘지_않는다() {
        assertEquals(15_000, Backoff.delayMillis(10, 1000, 30_000, 0.5));
        assertEquals(15_000, Backoff.delayMillis(63, 1000, 30_000, 0.5));
    }

    @Test
    void 풀_지터라_0까지_내려갈_수_있다() {
        assertEquals(0, Backoff.delayMillis(3, 1000, 30_000, 0.0));
    }

    @Test
    void RetryAfter_초_단위만_해석한다() {
        assertEquals(7000, com.blogstat.collector.core.StatSession.parseRetryAfterMs("7"));
        assertEquals(-1, com.blogstat.collector.core.StatSession.parseRetryAfterMs(null));
        assertEquals(-1, com.blogstat.collector.core.StatSession.parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT"));
    }
}
