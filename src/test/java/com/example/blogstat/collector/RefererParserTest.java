package com.example.blogstat.collector;

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
}
