package com.blogstat.collector;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RefererParserTest {

    private static final LocalDate DATE = LocalDate.of(2026, 1, 2);

    private final RefererParser parser = new RefererParser();

    private String sample() throws IOException {
        try (var in = getClass().getResourceAsStream("/referer-sample.json")) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void 컬럼_배열을_행으로_묶는다() throws IOException {
        RefererDay day = parser.parse(sample(), DATE);

        assertEquals(3, day.rows().size());
        RefererRow second = day.rows().get(1);
        assertEquals("검색B_모바일", second.referrer());
        assertEquals(30, second.visits());
        assertEquals(30.0, second.ratio());
        assertTrue(second.searchEngine());
        assertFalse(day.rows().get(0).searchEngine());
    }

    @Test
    void 합계와_오늘_여부를_읽는다() throws IOException {
        RefererDay day = parser.parse(sample(), DATE);

        assertEquals(100, day.totalCount());
        assertEquals(100, day.sumVisits());
        assertFalse(day.today());
    }

    @Test
    void 행_합계가_API_합계와_다르면_예외() throws IOException {
        String broken = sample().replace("\"value\": 100", "\"value\": 101");

        RefererParseException e = assertThrows(RefererParseException.class, () -> parser.parse(broken, DATE));
        assertTrue(e.getMessage().contains("합계 불일치"));
    }

    @Test
    void 요청한_날짜와_응답_날짜가_다르면_예외() throws IOException {
        String sample = sample();

        assertThrows(RefererParseException.class, () -> parser.parse(sample, LocalDate.of(2026, 1, 3)));
    }

    @Test
    void 컬럼_길이가_다르면_예외() throws IOException {
        String broken = sample().replace("\"cv\": [60, 30, 10]", "\"cv\": [60, 30]");

        assertThrows(RefererParseException.class, () -> parser.parse(broken, DATE));
    }

    @Test
    void refererTotal_블록이_없으면_예외() throws IOException {
        String broken = sample().replace("\"refererTotal\"", "\"somethingElse\"");

        assertThrows(RefererParseException.class, () -> parser.parse(broken, DATE));
    }

    @Test
    void JSON이_아니면_예외() {
        assertThrows(RefererParseException.class, () -> parser.parse("<html>오류</html>", DATE));
    }

    // ---- 검색어(detail) 응답 ----

    private String detailSample() throws IOException {
        try (var in = getClass().getResourceAsStream("/referer-detail-sample.json")) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void 검색어_응답을_행으로_읽는다() throws IOException {
        var rows = parser.parseQueries(detailSample(), DATE, "검색엔진A");

        assertEquals(3, rows.size());
        assertEquals("검색엔진A", rows.get(0).referrer());
        assertEquals("검색어 하나", rows.get(0).query());
        assertEquals(3, rows.get(0).visits());
        assertEquals(50.0, rows.get(0).ratio());
    }

    @Test
    void 검색어_앞뒤_공백은_제거하고_특수문자는_그대로_둔다() throws IOException {
        var rows = parser.parseQueries(detailSample(), DATE, "검색엔진A");

        assertEquals("공백 있는 검색어", rows.get(1).query());
        assertEquals("특수문자 <b>&\"'", rows.get(2).query());
    }

    @Test
    void 비어_있는_검색어_행은_건너뛴다() throws IOException {
        String blank = detailSample().replace("\"검색어 하나\"", "\"   \"");

        var rows = parser.parseQueries(blank, DATE, "검색엔진A");

        assertEquals(2, rows.size());
    }

    @Test
    void 검색어_합계가_달라도_예외를_던지지_않는다() throws IOException {
        // size 상한 때문에 일부만 올 수 있으므로 검증은 호출한 쪽(수집기)이 경고로 처리한다.
        assertEquals(3, parser.parseQueries(detailSample(), DATE, "검색엔진A").size());
    }

    @Test
    void 검색어_응답의_날짜가_요청과_다르면_예외() throws IOException {
        String sample = detailSample();

        assertThrows(RefererParseException.class,
                () -> parser.parseQueries(sample, LocalDate.of(2026, 1, 9), "검색엔진A"));
    }

    @Test
    void 검색어_컬럼이_없으면_예외() throws IOException {
        String broken = detailSample().replace("\"searchQuery\"", "\"other\"");

        assertThrows(RefererParseException.class, () -> parser.parseQueries(broken, DATE, "검색엔진A"));
    }

    @Test
    void 검색어_컬럼_길이가_다르면_예외() throws IOException {
        String broken = detailSample().replace("\"cv\": [3, 2, 1]", "\"cv\": [3, 2]");

        assertThrows(RefererParseException.class, () -> parser.parseQueries(broken, DATE, "검색엔진A"));
    }

    @Test
    void refererDetail_블록이_없으면_예외() throws IOException {
        String broken = detailSample().replace("\"refererDetail\"", "\"somethingElse\"");

        assertThrows(RefererParseException.class, () -> parser.parseQueries(broken, DATE, "검색엔진A"));
    }
}
