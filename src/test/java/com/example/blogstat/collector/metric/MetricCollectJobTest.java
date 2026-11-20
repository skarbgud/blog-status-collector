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
        when(service.replace(anyString(), any())).thenAnswer(inv -> ((List<?>) inv.getArgument(1)).size());
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

    /** 요청한 지표에 맞는 블록을 한 행씩 담아 돌려주는 가짜 HTTP. */
    private StatHttp http() {
        return (url, label) -> {
            urls.add(url);
            for (MetricSpec spec : MetricSpecs.ALL) {
                if (url.contains(spec.path() + "?")) {
                    return spec.isSeries()
                            ? json(spec.blockId(), "{\"date\":[\"2026-11-19\"],\"total\":[5]}")
                            : json(spec.blockId(), "{\"age\":[\"total\"],\"date\":[\"00\"],\"country\":[\"KR\"],\"cv\":[1]}");
                }
            }
            throw new IllegalStateException("알 수 없는 URL: " + url);
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
        verify(service, never()).replace(anyString(), any());
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
    void 예상_요청_수는_받아야_할_날짜만_센다() {
        when(service.datesWith("COUNTRY", LocalDate.of(2026, 11, 18), TO)).thenReturn(Set.of(LocalDate.of(2026, 11, 19)));
        MetricCollectJob.Plan plan = new MetricCollectJob.Plan(List.of(MetricSpecs.VIEWS, MetricSpecs.COUNTRY),
                LocalDate.of(2026, 11, 18), TO, false);

        // 시계열 1회 + 국가 2일
        assertEquals(3, job.estimateRequests(plan));
    }
}
