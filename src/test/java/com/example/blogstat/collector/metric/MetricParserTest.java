package com.example.blogstat.collector.metric;

import com.example.blogstat.domain.MetricRow;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MetricParserTest {

    private static final LocalDate TODAY = LocalDate.of(2026, 11, 21);
    private static final LocalDate DAY = LocalDate.of(2026, 11, 20);
    private static final LocalDateTime NOW = LocalDateTime.of(2026, 11, 21, 9, 0);

    private final MetricParser parser = new MetricParser();

    private static String body(String blockId, String rows) {
        return "{\"statusCode\":200,\"message\":\"\",\"result\":{\"statDataList\":["
                + "{\"dataId\":\"dashboard\",\"data\":{\"value\":{\"dailyCv\":1}}},"
                + "{\"dataId\":\"" + blockId + "\",\"data\":{\"columnInfo\":[],\"rows\":" + rows + "}}]}}";
    }

    @Test
    void 시계열은_날짜별_행으로_풀고_오늘_행은_버린다() {
        String json = body("cv", "{\"date\":[\"2026-11-21\",\"2026-11-20\",\"2026-11-19\"],"
                + "\"total\":[12,110,109],\"friend\":[1,11,8]}");

        List<MetricRow> rows = parser.parse(json, MetricSpecs.VIEWS, TODAY, TODAY, NOW);

        assertEquals(2, rows.size());
        assertEquals(LocalDate.of(2026, 11, 20), rows.get(0).getStatDate());
        assertEquals("all", rows.get(0).getRowKey());
        assertEquals("VIEWS", rows.get(0).getMetric());
        // 날짜는 행의 날짜가 되고 payload에는 남지 않는다.
        assertEquals("{\"total\":110,\"friend\":11}", rows.get(0).getPayload());
        assertEquals(LocalDate.of(2026, 11, 19), rows.get(1).getStatDate());
    }

    @Test
    void 하루_단위_지표는_지정한_컬럼_값으로_행을_구분한다() {
        String json = body("demo", "{\"age\":[\"total\",\"01\",\"05\"],\"m\":[6,0,4],\"f\":[5,0,0],"
                + "\"m_p\":[54.5,0.0,36.3],\"f_p\":[45.4,0.0,0.0]}");

        List<MetricRow> rows = parser.parse(json, MetricSpecs.DEMO, DAY, TODAY, NOW);

        assertEquals(List.of("total", "01", "05"), rows.stream().map(MetricRow::getRowKey).toList());
        assertTrue(rows.stream().allMatch(r -> r.getStatDate().equals(DAY)));
        assertTrue(rows.get(2).getPayload().contains("\"m\":4"));
        assertTrue(rows.get(2).getPayload().contains("\"m_p\":36.3"));
    }

    @Test
    void 구분_컬럼이_없는_기기는_행_순서로_이름을_붙인다() {
        String json = body("device", "{\"pc_p\":[24.5,25.0,33.3,18.1],\"pc\":[27,24,1,2],"
                + "\"mobile\":[83,72,2,9],\"mobile_p\":[75.4,75.0,66.6,81.8]}");

        List<MetricRow> rows = parser.parse(json, MetricSpecs.DEVICE, DAY, TODAY, NOW);

        assertEquals(List.of("total", "etc", "follow", "friend"), rows.stream().map(MetricRow::getRowKey).toList());
        assertTrue(rows.get(0).getPayload().contains("\"pc\":27"));
    }

    @Test
    void 순위는_같은_순위가_겹쳐도_순번으로_구분한다() {
        String json = body("rankCv", "{\"date\":[\"2026-11-20\",\"2026-11-20\",\"2026-11-20\"],\"cv\":[2,1,1],"
                + "\"rank\":[1,2,2],\"title\":[\"글 A\",\"글 B\",\"글 C\"],\"uri\":[\"u1\",\"u2\",\"u3\"]}");

        List<MetricRow> rows = parser.parse(json, MetricSpecs.RANK_POST, DAY, TODAY, NOW);

        assertEquals(List.of("r001", "r002", "r003"), rows.stream().map(MetricRow::getRowKey).toList());
        assertTrue(rows.get(2).getPayload().contains("\"title\":\"글 C\""));
    }

    @Test
    void 하루_단위_지표가_비어_있으면_빈_표시_행_하나를_남긴다() {
        String json = body("rankLike", "{\"date\":[],\"rank\":[],\"title\":[]}");

        List<MetricRow> rows = parser.parse(json, MetricSpecs.RANK_LIKE, DAY, TODAY, NOW);

        assertEquals(1, rows.size());
        assertEquals(MetricRow.EMPTY_KEY, rows.get(0).getRowKey());
        assertEquals(DAY, rows.get(0).getStatDate());
    }

    @Test
    void 시간대_조회수가_모두_0이면_집계_전이라_아무것도_저장하지_않는다() {
        // 네이버가 어제분을 늦게 집계해서 조회수는 있는데 시간대별 cv만 0으로 오는 경우
        String zeros = "0,0,0";
        String json = body("hour", "{\"date\":[\"00\",\"01\",\"02\"],\"cv\":[" + zeros + "],\"cv_yesterday\":[3,5,1]}");

        assertTrue(parser.parse(json, MetricSpecs.HOUR, DAY, TODAY, NOW).isEmpty());
    }

    @Test
    void 시간대_조회수에_값이_하나라도_있으면_저장한다() {
        String json = body("hour", "{\"date\":[\"00\",\"01\",\"02\"],\"cv\":[0,2,0],\"cv_yesterday\":[3,5,1]}");

        assertEquals(3, parser.parse(json, MetricSpecs.HOUR, DAY, TODAY, NOW).size());
    }

    @Test
    void 집계_전_판정은_정해진_지표에만_적용된다() {
        // 국가 분포의 cv가 0이어도 집계 전으로 보지 않고 그대로 저장한다.
        String json = body("country", "{\"country\":[\"KR\"],\"cv\":[0]}");

        assertEquals(1, parser.parse(json, MetricSpecs.COUNTRY, DAY, TODAY, NOW).size());
    }

    @Test
    void 한_응답에서_블록이_다른_지표를_각각_읽는다() {
        String json = "{\"statusCode\":200,\"result\":{\"statDataList\":["
                + "{\"dataId\":\"demo\",\"data\":{\"rows\":{\"age\":[\"total\"],\"m\":[1],\"f\":[2]}}},"
                + "{\"dataId\":\"demoFriend\",\"data\":{\"rows\":{\"age\":[\"total\"],\"m\":[7],\"f\":[8]}}}]}}";

        List<MetricRow> all = parser.parse(json, MetricSpecs.DEMO, DAY, TODAY, NOW);
        List<MetricRow> friend = parser.parse(json, MetricSpecs.DEMO_FRIEND, DAY, TODAY, NOW);

        assertEquals("{\"age\":\"total\",\"m\":1,\"f\":2}", all.get(0).getPayload());
        assertEquals("DEMO_FRIEND", friend.get(0).getMetric());
        assertEquals("{\"age\":\"total\",\"m\":7,\"f\":8}", friend.get(0).getPayload());
    }

    @Test
    void 게시글별_시계열은_게시글_번호를_행_구분으로_쓴다() {
        String json = body("cv", "{\"date\":[\"2026-11-20\",\"2026-11-19\"],\"cv\":[14,6],\"cv_p\":[2.2,0.9]}");

        List<MetricRow> rows = parser.parse(json, MetricSpecs.ARTICLE_CV, DAY, TODAY, NOW, "224476308011");

        assertEquals(2, rows.size());
        assertEquals("224476308011", rows.get(0).getRowKey());
        assertEquals("ARTICLE_CV", rows.get(0).getMetric());
        assertEquals("{\"cv\":14,\"cv_p\":2.2}", rows.get(0).getPayload());
    }

    @Test
    void 값_지표는_객체_항목을_행으로_나누고_나머지는_모아_한_행으로_만든다() {
        String json = "{\"statusCode\":200,\"result\":{\"statDataList\":["
                + "{\"dataId\":\"averageList\",\"data\":{\"value\":[\"2026-10-01\"]}},"
                + "{\"dataId\":\"upperGroup\",\"data\":{\"value\":{\"cv\":{\"top_avg\":54707.6,\"service_avg\":444.0,\"max\":5217717},"
                + "\"duration\":{\"top_avg\":155.7,\"service_avg\":154.2,\"max\":1799.8}}}},"
                + "{\"dataId\":\"averageUserData\",\"data\":{\"value\":{\"duration\":153.8,\"uv\":9361}}}]}}";
        LocalDate month = LocalDate.of(2026, 10, 1);

        List<MetricRow> rows = parser.parse(json, MetricSpecs.UPPER_GROUP, month, TODAY, NOW);

        assertEquals(List.of("cv", "duration", MetricSpec.VALUE_ROW), rows.stream().map(MetricRow::getRowKey).toList());
        assertTrue(rows.stream().allMatch(r -> r.getStatDate().equals(month)));
        assertEquals("{\"top_avg\":54707.6,\"service_avg\":444.0,\"max\":5217717}", rows.get(0).getPayload());
        // averageUserData는 객체가 아닌 값(duration은 위 duration 행과 이름만 같다)이라 value 행으로 모인다.
        assertEquals("{\"duration\":153.8,\"uv\":9361}", rows.get(2).getPayload());
    }

    @Test
    void 게시글_정보는_제목과_누적_수치를_게시글_번호_한_행으로_모은다() {
        String json = "{\"statusCode\":200,\"result\":{\"statDataList\":["
                + "{\"dataId\":\"articleInfo\",\"data\":{\"value\":{\"title\":\"글\",\"url\":\"http://blog.naver.com/me/111\"}}},"
                + "{\"dataId\":\"dashboard\",\"data\":{\"value\":{\"cvTotal\":614,\"commentTotal\":22,\"likeTotal\":89}}}]}}";

        List<MetricRow> rows = parser.parse(json, MetricSpecs.ARTICLE_INFO, DAY, TODAY, NOW, "111");

        assertEquals(1, rows.size());
        assertEquals("111", rows.get(0).getRowKey());
        assertTrue(rows.get(0).getPayload().contains("\"title\":\"글\""));
        assertTrue(rows.get(0).getPayload().contains("\"cvTotal\":614"));
    }

    @Test
    void 값_지표의_블록이_하나도_없으면_예외를_던진다() {
        String json = "{\"statusCode\":200,\"result\":{\"statDataList\":[{\"dataId\":\"other\",\"data\":{\"value\":{\"a\":1}}}]}}";

        assertThrows(MetricParseException.class,
                () -> parser.parse(json, MetricSpecs.UPPER_GROUP, DAY, TODAY, NOW));
    }

    @Test
    void 시계열이_비어_있으면_빈_표시를_남기지_않는다() {
        String json = body("cv", "{\"date\":[],\"total\":[]}");

        assertTrue(parser.parse(json, MetricSpecs.VIEWS, TODAY, TODAY, NOW).isEmpty());
    }

    @Test
    void 컬럼_배열_길이가_다르면_저장하지_않고_예외를_던진다() {
        String json = body("cv", "{\"date\":[\"2026-11-19\",\"2026-11-18\"],\"total\":[1]}");

        MetricParseException e = assertThrows(MetricParseException.class,
                () -> parser.parse(json, MetricSpecs.VIEWS, TODAY, TODAY, NOW));
        assertTrue(e.getMessage().contains("길이"));
    }

    @Test
    void 기대한_블록이_없으면_예외를_던진다() {
        String json = body("other", "{\"date\":[],\"total\":[]}");

        MetricParseException e = assertThrows(MetricParseException.class,
                () -> parser.parse(json, MetricSpecs.VIEWS, TODAY, TODAY, NOW));
        assertTrue(e.getMessage().contains("cv"));
    }

    @Test
    void statusCode가_200이_아니면_예외를_던진다() {
        String json = "{\"statusCode\":500,\"result\":{\"statDataList\":[]}}";

        assertThrows(MetricParseException.class, () -> parser.parse(json, MetricSpecs.VIEWS, TODAY, TODAY, NOW));
    }

    @Test
    void 시계열_날짜를_읽지_못하면_예외를_던진다() {
        String json = body("cv", "{\"date\":[\"11/19\"],\"total\":[1]}");

        assertThrows(MetricParseException.class, () -> parser.parse(json, MetricSpecs.VIEWS, TODAY, TODAY, NOW));
    }

    @Test
    void JSON이_아니면_예외를_던진다() {
        assertThrows(MetricParseException.class,
                () -> parser.parse("<html>", MetricSpecs.VIEWS, TODAY, TODAY, NOW));
    }

    @Test
    void 지표_식별자는_모두_유일하다() {
        long distinct = MetricSpecs.ALL.stream().map(MetricSpec::id).distinct().count();

        assertEquals(MetricSpecs.ALL.size(), distinct);
    }
}
