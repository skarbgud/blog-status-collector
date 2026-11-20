package com.example.blogstat.collector.metric;

import java.util.List;
import java.util.Optional;

/**
 * 수집하는 지표 목록. `--app.mode=catalog`로 정리한 통계 API 29종 중 블로그 자체의 지표를 담았다.
 *
 * 뺀 것: 유입경로·검색어(별도 표에 저장), 게시글별 조회수(contentId마다 호출해야 해서 다음 단계),
 * 평균 비교(upperGroup, 월간 값이라 일별 대시보드와 단위가 다름), weekAndMonthAnalysis/dashboard 블록(합계라 일별에서 구할 수 있음).
 */
public final class MetricSpecs {

    private MetricSpecs() {
    }

    // ---- 시계열: 한 번 호출에 15일(주간은 15주)치 ----

    public static final MetricSpec VIEWS = MetricSpec.series(
            "VIEWS", "조회수(이웃 구분별)", "/api/blog/visit/cv", "DATE", "cv");
    public static final MetricSpec VISITORS = MetricSpec.series(
            "VISITORS", "순방문자수(이웃 구분별)", "/api/blog/visit/uv", "DATE", "uv");
    public static final MetricSpec VISITS = MetricSpec.series(
            "VISITS", "방문횟수", "/api/blog/visit/visit", "DATE", "visit");
    public static final MetricSpec DURATION = MetricSpec.series(
            "DURATION", "평균 사용시간(이웃 구분별)", "/api/blog/visit/averageDuration", "DATE", "averageDuration");
    public static final MetricSpec RELATION_VISIT = MetricSpec.series(
            "RELATION_VISIT", "이웃 방문 현황", "/api/blog/user/relationVisitCv", "DATE", "relationVisit");
    public static final MetricSpec RELATION_DELTA = MetricSpec.series(
            "RELATION_DELTA", "이웃 증감", "/api/blog/user/relationDelta", "DATE", "relationDelta");
    public static final MetricSpec AVG_VISIT_WEEKLY = MetricSpec.series(
            "AVG_VISIT_WEEKLY", "평균 방문횟수(주간)", "/api/blog/visit/averageVisit", "WEEK", "averageVisit");
    public static final MetricSpec REVISIT_WEEKLY = MetricSpec.series(
            "REVISIT_WEEKLY", "재방문율(주간)", "/api/blog/visit/revisit", "WEEK", "revisit");

    // ---- 하루 단위: 날짜마다 한 번씩 ----

    /** 성별·연령. age가 코드(total, 01~11)이고 m/f가 방문수, m_p/f_p가 비율이다. */
    public static final MetricSpec DEMO = MetricSpec.day(
            "DEMO", "성별·연령별 분포", "/api/blog/user/demoCv", "demo", "age", List.of(), "");
    /**
     * 기기. 응답에 구분 컬럼이 없고 행이 4개 온다. 2026-11-20 응답에서 행별 pc+mobile 합이
     * 조회수(visit/cv)의 total, etc, follow, friend와 각각 같아서 이 순서로 이름을 붙였다.
     */
    public static final MetricSpec DEVICE = MetricSpec.day(
            "DEVICE", "기기별 분포(PC/모바일)", "/api/blog/user/device/mobile", "device", null,
            List.of("total", "etc", "follow", "friend"), "");
    /**
     * 시간대(00~23). 화면이 보내는 hour=12를 그대로 따른다.
     * 네이버가 어제분을 늦게 집계해서, 2026-11-21 02:36에 받은 11/20은 cv가 24시간 모두 0이었다(조회수는 110).
     * 이 값을 저장하면 이미 받은 날짜로 건너뛰어 0이 영구히 남으므로, cv 합이 0이면 저장하지 않고 다음에 다시 받는다.
     */
    public static final MetricSpec HOUR = MetricSpec.day(
            "HOUR", "시간대별 조회수", "/api/blog/user/hour/cv", "hour", "date", List.of(), "&hour=12")
            .pendingWhenZero("cv");
    public static final MetricSpec COUNTRY = MetricSpec.day(
            "COUNTRY", "국가별 분포", "/api/blog/user/country", "country", "country", List.of(), "");
    public static final MetricSpec RANK_POST = MetricSpec.day(
            "RANK_POST", "게시글 조회수 순위", "/api/blog/rank/cvContentPc", "rankCv", null, List.of(), "");
    public static final MetricSpec RANK_SUBJECT = MetricSpec.day(
            "RANK_SUBJECT", "주제별 조회수 순위", "/api/blog/rank/cvSubjectPc", "rankCv", null, List.of(), "");
    public static final MetricSpec RANK_LIKE = MetricSpec.day(
            "RANK_LIKE", "게시글 공감수 순위", "/api/blog/rank/likePc", "rankLike", null, List.of(), "");
    public static final MetricSpec RANK_COMMENT = MetricSpec.day(
            "RANK_COMMENT", "게시글 댓글수 순위", "/api/blog/rank/commentPc", "rankComment", null, List.of(), "");

    /** 수집 순서. 요청이 적은 시계열을 먼저 받는다. */
    public static final List<MetricSpec> ALL = List.of(
            VIEWS, VISITORS, VISITS, DURATION, RELATION_VISIT, RELATION_DELTA, AVG_VISIT_WEEKLY, REVISIT_WEEKLY,
            DEMO, DEVICE, HOUR, COUNTRY, RANK_POST, RANK_SUBJECT, RANK_LIKE, RANK_COMMENT);

    public static Optional<MetricSpec> find(String id) {
        return ALL.stream().filter(s -> s.id().equalsIgnoreCase(id)).findFirst();
    }
}
