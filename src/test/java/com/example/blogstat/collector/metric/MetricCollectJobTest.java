package com.example.blogstat.collector.metric;

import com.example.blogstat.collector.core.BudgetExceededException;
import com.example.blogstat.collector.core.CollectSettings;
import com.example.blogstat.collector.core.NaverStatClient;
import com.example.blogstat.collector.core.StatHttp;
import com.example.blogstat.domain.MetricService;
import com.example.blogstat.replica.SnapshotPublisher;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class MetricCollectJobTest {

    private static final LocalDate TO = LocalDate.of(2026, 11, 20);

    private MetricService service;
    private MetricCollectJob job;
    private final List<String> urls = new ArrayList<>();

    @BeforeEach
    void setUp() {
        service = mock(MetricService.class);
        when(service.datesWith(anyString(), any(), any())).thenReturn(Set.of());
        when(service.keysWith(anyString(), any())).thenReturn(Set.of());
        when(service.postIds(any(), any())).thenReturn(Set.of());
        when(service.replace(anyString(), any(), any())).thenAnswer(inv -> ((List<?>) inv.getArgument(1)).size());
        CollectSettings settings = mock(CollectSettings.class);
        when(settings.baseUrl()).thenReturn("https://stat.example");
        @SuppressWarnings("unchecked")
        ObjectProvider<SnapshotPublisher> publisher = mock(ObjectProvider.class);
        Clock clock = Clock.fixed(Instant.parse("2026-11-21T00:00:00Z"), ZoneId.of("Asia/Seoul"));
        job = new MetricCollectJob(mock(NaverStatClient.class), service, settings, clock, publisher,
                new MetricParser(), 320);
    }

    private static String json(String blockId, String rows) {
        return "{\"statusCode\":200,\"result\":{\"statDataList\":[{\"dataId\":\"" + blockId
                + "\",\"data\":{\"rows\":" + rows + "}}]}}";
    }

    /**
     * 어느 지표든 읽을 수 있는 블록을 모두 담아 돌려주는 가짜 HTTP. 알려진 경로가 아니면 실패한다.
     * rows 블록은 한 행씩, value 블록은 작은 객체를 담는다.
     */
    private StatHttp http() {
        return (url, label) -> {
            urls.add(url);
            if (MetricSpecs.ALL.stream().noneMatch(s -> url.contains(s.path() + "?"))) {
                throw new IllegalStateException("알 수 없는 URL: " + url);
            }
            String rows = "{\"date\":[\"2026-11-19\"],\"total\":[5],\"visit\":[5],\"age\":[\"total\"],"
                    + "\"country\":[\"KR\"],\"cv\":[1],\"pc\":[1],\"mobile\":[2],\"dimension1\":[\"주제\"],"
                    + "\"searchQuery\":[\"q\"],\"referrerDomain\":[\"d\"],\"vid\":[\"v\"],\"rank\":[1]}";
            StringBuilder blocks = new StringBuilder();
            for (MetricSpec spec : MetricSpecs.ALL) {
                for (String id : spec.blockIds()) {
                    blocks.append(blocks.length() == 0 ? "" : ",");
                    blocks.append(spec.isValue()
                            ? "{\"dataId\":\"" + id + "\",\"data\":{\"value\":" + valueFor(id) + "}}"
                            : "{\"dataId\":\"" + id + "\",\"data\":{\"rows\":" + rows + "}}");
                }
            }
            return "{\"statusCode\":200,\"result\":{\"statDataList\":[" + blocks + "]}}";
        };
    }

    private static String valueFor(String blockId) {
        return switch (blockId) {
            case "upperGroup" -> "{\"cv\":{\"top_avg\":10.5,\"service_avg\":4.5,\"max\":99}}";
            case "averageUserData" -> "{\"cv\":16492,\"uv\":9361}";
            case "articleInfo" -> "{\"title\":\"글 제목\",\"url\":\"http://blog.naver.com/me/111\"}";
            default -> "{\"cvTotal\":614,\"likeTotal\":89}";
        };
    }

    private static MetricCollectJob.Plan plan(MetricSpec spec, LocalDate from, boolean force) {
        return new MetricCollectJob.Plan(List.of(spec), from, TO, force);
    }

    private long count(String text) {
        return urls.stream().filter(u -> u.contains(text)).count();
    }

    @Test
    void 일별_시계열은_15일_창으로_나눠_거슬러_올라간다() {
        // 30일 = 10/22 ~ 11/20: 끝 날짜 11/20(11/06~11/20)과 11/05(10/22~11/05) 두 번이면 덮는다.
        job.execute(http(), plan(MetricSpecs.VIEWS, LocalDate.of(2026, 10, 22), false));

        assertEquals(2, urls.size());
        assertTrue(urls.get(0).contains("startDate=2026-11-20"));
        assertTrue(urls.get(1).contains("startDate=2026-11-05"));
    }

    @Test
    void 하루만_받아도_시계열은_한_번이다() {
        job.execute(http(), plan(MetricSpecs.VIEWS, TO, false));

        assertEquals(1, urls.size());
    }

    @Test
    void 주간_지표는_마지막으로_끝난_주의_월요일로_한_번만_부른다() {
        // 2026-11-20은 금요일. 화면은 그 전 주 월요일(11/09)을 보낸다.
        job.execute(http(), plan(MetricSpecs.REVISIT_WEEKLY, LocalDate.of(2026, 10, 22), false));

        assertEquals(1, urls.size());
        assertTrue(urls.get(0).contains("timeDimension=WEEK"));
        assertTrue(urls.get(0).contains("startDate=2026-11-09"));
    }

    @Test
    void 하루_단위는_이미_받은_날짜를_건너뛰고_최신_날짜부터_받는다() {
        when(service.datesWith("COUNTRY", LocalDate.of(2026, 11, 18), TO)).thenReturn(Set.of(LocalDate.of(2026, 11, 19)));

        job.execute(http(), plan(MetricSpecs.COUNTRY, LocalDate.of(2026, 11, 18), false));

        assertEquals(2, urls.size());
        assertTrue(urls.get(0).contains("startDate=2026-11-20"));
        assertTrue(urls.get(1).contains("startDate=2026-11-18"));
    }

    @Test
    void force면_이미_받은_날짜도_다시_받는다() {
        when(service.datesWith(anyString(), any(), any())).thenReturn(Set.of(LocalDate.of(2026, 11, 19)));

        job.execute(http(), plan(MetricSpecs.COUNTRY, LocalDate.of(2026, 11, 18), true));

        assertEquals(3, urls.size());
    }

    @Test
    void 화면이_보내는_추가_쿼리를_붙인다() {
        job.execute(http(), plan(MetricSpecs.HOUR, TO, false));

        assertTrue(urls.get(0).contains("startDate=2026-11-20&hour=12&exclude=&_="));
    }

    @Test
    void 하루_단위는_날짜별로_묶어_지표를_모두_받은_뒤_다음_날짜로_간다() {
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.COUNTRY, MetricSpecs.DEMO),
                LocalDate.of(2026, 11, 19), TO, false);

        job.execute(http(), plan);

        assertEquals(4, urls.size());
        assertTrue(urls.get(0).contains("country") && urls.get(0).contains("2026-11-20"));
        assertTrue(urls.get(1).contains("demoCv") && urls.get(1).contains("2026-11-20"));
        assertTrue(urls.get(2).contains("country") && urls.get(2).contains("2026-11-19"));
    }

    @Test
    void 한_요청이_실패해도_나머지는_계속_받는다() {
        StatHttp failing = (url, label) -> {
            if (url.contains("/user/hour/cv")) {
                throw new IllegalStateException("HTTP 400");
            }
            return http().get(url, label);
        };
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.HOUR, MetricSpecs.COUNTRY),
                TO, TO, false);

        MetricCollectJob.Result result = job.execute(failing, plan);

        assertEquals(1, result.failures());
        assertFalse(result.budgetStopped());
        assertEquals(1, result.saved().get("COUNTRY"));
        assertFalse(result.saved().containsKey("HOUR"));
    }

    @Test
    void 집계_전인_날은_저장하지_않고_앞서_저장된_잠정값을_지운다() {
        StatHttp pending = (url, label) -> json("hour",
                "{\"date\":[\"00\",\"01\"],\"cv\":[0,0],\"cv_yesterday\":[3,5]}");

        MetricCollectJob.Result result = job.execute(pending, plan(MetricSpecs.HOUR, TO, false));

        assertEquals(0, result.failures());
        assertTrue(result.saved().isEmpty());
        verify(service).clear("HOUR", TO);
        verify(service, never()).replace(anyString(), any(), any());
    }

    @Test
    void 응답_구조가_다르면_그_요청만_건너뛴다() {
        StatHttp broken = (url, label) -> json("엉뚱한블록", "{}");

        MetricCollectJob.Result result = job.execute(broken, plan(MetricSpecs.COUNTRY, TO, false));

        assertEquals(1, result.failures());
        assertTrue(result.saved().isEmpty());
    }

    @Test
    void 예산을_다_쓰면_거기서_멈추고_그때까지의_결과를_돌려준다() {
        int[] calls = {0};
        StatHttp limited = (url, label) -> {
            if (++calls[0] > 1) {
                throw new BudgetExceededException("요청 예산 소진");
            }
            return http().get(url, label);
        };

        MetricCollectJob.Result result = job.execute(limited, plan(MetricSpecs.COUNTRY, LocalDate.of(2026, 11, 18), false));

        assertTrue(result.budgetStopped());
        assertEquals(1, result.saved().get("COUNTRY"));
    }

    @Test
    void 같은_API를_쓰는_지표들은_날짜마다_요청_한_번으로_함께_받는다() {
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(
                List.of(MetricSpecs.DEMO, MetricSpecs.DEMO_FOLLOW, MetricSpecs.DEMO_FRIEND, MetricSpecs.DEMO_ETC),
                TO, TO, false);

        MetricCollectJob.Result result = job.execute(http(), plan);

        assertEquals(1, urls.size());
        assertTrue(urls.get(0).contains("/api/blog/user/demoCv?"));
        assertEquals(0, result.failures());
        // 한 응답에서 네 지표가 모두 저장된다.
        assertEquals(4, result.saved().size());
        verify(service).replace(org.mockito.ArgumentMatchers.eq("DEMO_FRIEND"), any(), any());
    }

    @Test
    void 일부_지표만_비어_있으면_그_지표만_다시_받는다() {
        when(service.datesWith("DEMO", TO, TO)).thenReturn(Set.of(TO));
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.DEMO, MetricSpecs.DEMO_ETC),
                TO, TO, false);

        MetricCollectJob.Result result = job.execute(http(), plan);

        assertEquals(1, urls.size());
        assertEquals(java.util.Set.of("DEMO_ETC"), result.saved().keySet());
    }

    @Test
    void 월간_비교는_마지막으로_끝난_달의_1일로_한_번만_부른다() {
        job.execute(http(), plan(MetricSpecs.UPPER_GROUP, LocalDate.of(2026, 10, 22), false));

        assertEquals(1, urls.size());
        assertTrue(urls.get(0).contains("timeDimension=MONTH"));
        assertTrue(urls.get(0).contains("startDate=2026-10-01"));
    }

    @Test
    void 값_지표는_객체_항목을_행으로_나누고_나머지는_한_행으로_모은다() {
        org.mockito.ArgumentCaptor<List<com.example.blogstat.domain.MetricRow>> rows =
                org.mockito.ArgumentCaptor.forClass(List.class);

        job.execute(http(), plan(MetricSpecs.UPPER_GROUP, LocalDate.of(2026, 10, 22), false));

        verify(service).replace(org.mockito.ArgumentMatchers.eq("UPPER_GROUP"), rows.capture(), any());
        assertEquals(List.of("cv", "value"), rows.getValue().stream()
                .map(com.example.blogstat.domain.MetricRow::getRowKey).toList());
        assertEquals(LocalDate.of(2026, 10, 1), rows.getValue().get(0).getStatDate());
    }

    @Test
    void 주_단위_하루_지표는_기간과_겹치는_끝난_주마다_한_번씩_받는다() {
        // 기간 11/06~11/20, 마지막으로 끝난 주는 11/09(월)~11/15. 그 전 주 11/02~11/08은 11/06과 겹친다.
        job.execute(http(), plan(MetricSpecs.REL_DEMO_ADD, LocalDate.of(2026, 11, 6), false));

        assertEquals(2, urls.size());
        assertTrue(urls.get(0).contains("timeDimension=WEEK") && urls.get(0).contains("startDate=2026-11-09"));
        assertTrue(urls.get(1).contains("startDate=2026-11-02"));
    }

    @Test
    void 일요일이_끝_날짜면_그_주도_끝난_주로_본다() {
        assertEquals(LocalDate.of(2026, 11, 16), MetricCollectJob.lastCompleteWeekStart(LocalDate.of(2026, 11, 22)));
        assertEquals(LocalDate.of(2026, 11, 9), MetricCollectJob.lastCompleteWeekStart(LocalDate.of(2026, 11, 20)));
    }

    @Test
    void 게시글별_지표는_순위에_나온_게시글마다_시계열_창_수만큼_부르고_첫_창에서_정보도_받는다() {
        when(service.postIds(any(), any())).thenReturn(new java.util.TreeSet<>(Set.of("111", "222")));
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.ARTICLE_CV, MetricSpecs.ARTICLE_INFO),
                LocalDate.of(2026, 10, 22), TO, false);

        MetricCollectJob.Result result = job.execute(http(), plan);

        // 게시글 2개 x 창 2개
        assertEquals(4, urls.size());
        assertTrue(urls.get(0).contains("contentId=111") && urls.get(0).contains("startDate=2026-11-20"));
        assertTrue(urls.get(1).contains("contentId=111") && urls.get(1).contains("startDate=2026-11-05"));
        assertTrue(urls.get(2).contains("contentId=222"));
        // 정보는 첫 창에서만 받는다(게시글마다 한 번)
        assertEquals(2, result.saved().get("ARTICLE_INFO"));
        // 같은 날짜의 다른 게시글 행을 지우지 않도록 게시글 번호로 범위를 좁혀 저장한다.
        // 창이 2개라 게시글마다 두 번(창마다 한 번) 저장한다.
        verify(service, org.mockito.Mockito.times(2)).replace(org.mockito.ArgumentMatchers.eq("ARTICLE_CV"), any(),
                org.mockito.ArgumentMatchers.eq("111"));
        verify(service, org.mockito.Mockito.times(2)).replace(org.mockito.ArgumentMatchers.eq("ARTICLE_CV"), any(),
                org.mockito.ArgumentMatchers.eq("222"));
    }

    @Test
    void 시간대별_추이는_0시부터_23시까지_시간마다_창_수만큼_부른다() {
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.HOUR_TREND),
                LocalDate.of(2026, 10, 22), TO, false);

        job.execute(http(), plan);

        assertEquals(48, urls.size()); // 24시간 x 창 2개
        assertTrue(urls.get(0).contains("/api/blog/user/hour/hourCv?") && urls.get(0).contains("hour=00&")
                && urls.get(0).contains("startDate=2026-11-20"));
        assertTrue(urls.get(1).contains("hour=00&") && urls.get(1).contains("startDate=2026-11-05"));
        assertTrue(urls.get(47).contains("hour=23&"));
        // 행 구분은 두 자리 시간이라 같은 날짜의 다른 시간대 행을 지우지 않는다.
        verify(service, org.mockito.Mockito.times(2)).replace(org.mockito.ArgumentMatchers.eq("HOUR_TREND"), any(),
                org.mockito.ArgumentMatchers.eq("07"));
    }

    @Test
    void 일간_현황과_동영상_순위는_날짜마다_요청_한_번으로_함께_받는다() {
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.DAILY_SUMMARY, MetricSpecs.VIDEO_RANK),
                LocalDate.of(2026, 11, 19), TO, false);

        MetricCollectJob.Result result = job.execute(http(), plan);

        assertEquals(2, urls.size()); // 이틀, 날짜마다 한 번
        assertTrue(urls.get(0).contains("/api/blog/daily/cv?") && urls.get(0).contains("additionalTimeDimension=WEEK")
                && urls.get(0).contains("startDate=2026-11-20"));
        assertEquals(java.util.Set.of("DAILY_SUMMARY", "VIDEO_RANK"), result.saved().keySet());
        // 값 지표라도 월간이 아니면 날짜별 행이다(월 시작일이 아니라 날짜마다 저장).
        verify(service, org.mockito.Mockito.times(2)).replace(org.mockito.ArgumentMatchers.eq("DAILY_SUMMARY"), any(), any());
    }

    @Test
    void 이미_받은_시간대는_건너뛴다() {
        when(service.keysWith("HOUR_TREND", TO)).thenReturn(Set.of("00", "01", "02"));
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.HOUR_TREND), TO, TO, false);

        job.execute(http(), plan);

        assertEquals(21, urls.size());
        assertTrue(urls.get(0).contains("hour=03&")); // 앞자리 0을 자르지 않는다(hour=3이면 0~9시가 0으로 온다)
    }

    @Test
    void 게시글이_HTTP_400이면_실패로_세지_않고_조회_불가_표시를_남긴다() {
        when(service.postIds(any(), any())).thenReturn(new java.util.TreeSet<>(Set.of("111", "222")));
        StatHttp http = (url, label) -> {
            if (url.contains("contentId=222")) {
                throw new IllegalStateException(label + " 수집 실패: HTTP 400");
            }
            return http().get(url, label);
        };
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.ARTICLE_CV, MetricSpecs.ARTICLE_INFO),
                TO, TO, false);
        org.mockito.ArgumentCaptor<List<com.example.blogstat.domain.MetricRow>> rows =
                org.mockito.ArgumentCaptor.forClass(List.class);

        MetricCollectJob.Result result = job.execute(http, plan);

        assertEquals(0, result.failures());
        // 정상인 111은 그대로 저장된다.
        assertEquals(1, result.saved().get("ARTICLE_CV"));
        verify(service).replace(org.mockito.ArgumentMatchers.eq("ARTICLE_INFO"), rows.capture(),
                org.mockito.ArgumentMatchers.eq("222"));
        // 111의 정상 정보 저장도 같은 메서드를 쓰므로, 222용 표시 행만 골라 확인한다.
        assertTrue(rows.getAllValues().stream().flatMap(List::stream)
                .anyMatch(r -> r.getRowKey().equals("222") && r.getPayload().equals("{\"unavailable\":true}")));
    }

    @Test
    void 창이_여러_개여도_조회_불가_표시는_정보_지표에만_남고_시계열에는_가짜_행을_만들지_않는다() {
        when(service.postIds(any(), any())).thenReturn(new java.util.TreeSet<>(Set.of("222")));
        StatHttp http = (url, label) -> {
            throw new IllegalStateException(label + " 수집 실패: HTTP 400");
        };
        // 30일 = 창 2개. 두 번째 창의 요청에는 시계열 지표만 들어 있어서, 표시를 고르는 방식에 따라 시계열에 새어 들어갈 수 있다.
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.ARTICLE_CV, MetricSpecs.ARTICLE_INFO),
                LocalDate.of(2026, 10, 22), TO, false);

        MetricCollectJob.Result result = job.execute(http, plan);

        assertEquals(0, result.failures());
        verify(service, org.mockito.Mockito.times(2)).replace(org.mockito.ArgumentMatchers.eq("ARTICLE_INFO"), any(),
                org.mockito.ArgumentMatchers.eq("222"));
        verify(service, never()).replace(org.mockito.ArgumentMatchers.eq("ARTICLE_CV"), any(), any());
    }

    @Test
    void 정리는_게시글별_시계열_지표에서만_표시를_지운다() {
        when(service.deleteUnavailableMarkers("ARTICLE_CV")).thenReturn(1);
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(
                List.of(MetricSpecs.VIEWS, MetricSpecs.ARTICLE_CV, MetricSpecs.ARTICLE_INFO), LocalDate.of(2026, 10, 22), TO, false);

        assertEquals(1, job.repairMarkers(plan));

        verify(service).deleteUnavailableMarkers("ARTICLE_CV");
        // 일반 시계열(VIEWS)과 정보 지표(ARTICLE_INFO)는 건드리지 않는다.
        verify(service, never()).deleteUnavailableMarkers("VIEWS");
        verify(service, never()).deleteUnavailableMarkers("ARTICLE_INFO");
    }

    @Test
    void 조회_불가_표시가_있는_게시글은_같은_날_다시_부르지_않는다() {
        when(service.postIds(any(), any())).thenReturn(new java.util.TreeSet<>(Set.of("111", "222")));
        when(service.keysWith("ARTICLE_INFO", TO)).thenReturn(Set.of("222")); // 표시만 있고 시계열은 없다
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.ARTICLE_CV, MetricSpecs.ARTICLE_INFO),
                TO, TO, false);

        job.execute(http(), plan);

        assertEquals(1, urls.size());
        assertTrue(urls.get(0).contains("contentId=111"));
    }

    @Test
    void 이미_받은_게시글은_건너뛴다() {
        when(service.postIds(any(), any())).thenReturn(new java.util.TreeSet<>(Set.of("111", "222")));
        when(service.keysWith("ARTICLE_CV", TO)).thenReturn(Set.of("111"));
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.ARTICLE_CV, MetricSpecs.ARTICLE_INFO),
                TO, TO, false);

        job.execute(http(), plan);

        assertEquals(1, urls.size());
        assertTrue(urls.get(0).contains("contentId=222"));
    }

    @Test
    void 예상_요청_수는_받아야_할_날짜만_센다() {
        when(service.datesWith("COUNTRY", LocalDate.of(2026, 11, 18), TO)).thenReturn(Set.of(LocalDate.of(2026, 11, 19)));
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.VIEWS, MetricSpecs.COUNTRY),
                LocalDate.of(2026, 11, 18), TO, false);

        // 시계열 1회 + 국가 2일
        assertEquals(3, job.estimateRequests(plan));
    }
}
