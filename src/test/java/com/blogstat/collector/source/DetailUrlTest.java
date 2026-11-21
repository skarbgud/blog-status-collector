package com.blogstat.collector.source;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DetailUrlTest {

    private static final String BASE = "https://blog.stat.naver.com";
    private static final LocalDate DATE = LocalDate.of(2026, 11, 20);

    @Test
    void 화면이_쓰는_형태와_같은_파라미터를_만든다() {
        String url = RefererSource.detailUrl(BASE, DATE, "네이버 통합검색_모바일", 100, "123_45");

        assertEquals("https://blog.stat.naver.com/api/blog/daily/referer/total/detail"
                + "?timeDimension=DATE&additionalTimeDimension=WEEK&startDate=2026-11-20&searchEngine=1"
                + "&refererDomain=%EB%84%A4%EC%9D%B4%EB%B2%84%20%ED%86%B5%ED%95%A9%EA%B2%80%EC%83%89_%EB%AA%A8%EB%B0%94%EC%9D%BC"
                + "&size=100&exclude=&_=123_45", url);
    }

    @Test
    void 공백은_플러스가_아니라_퍼센트20으로_인코딩한다() {
        String url = RefererSource.detailUrl(BASE, DATE, "a b", 20, "n");

        assertTrue(url.contains("refererDomain=a%20b"));
        assertFalse(url.contains("a+b"));
    }

    @Test
    void 유입처_이름의_예약문자는_인코딩된다() {
        String url = RefererSource.detailUrl(BASE, DATE, "x&y=z", 20, "n");

        assertTrue(url.contains("refererDomain=x%26y%3Dz"));
        // 이름 안의 &, =가 별도 파라미터로 새어 나가지 않아야 한다.
        assertEquals(1, url.split("&searchEngine=").length - 1);
    }
}
