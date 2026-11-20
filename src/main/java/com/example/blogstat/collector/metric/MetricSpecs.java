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
    /** 같은 응답(user/demoCv)에 함께 오는 이웃 구분별 성별·연령. 요청은 DEMO와 한 번으로 합쳐진다. */
    public static final MetricSpec DEMO_FOLLOW = MetricSpec.day(
            "DEMO_FOLLOW", "성별·연령별 분포(피이웃)", "/api/blog/user/demoCv", "demoFollow", "age", List.of(), "");
    public static final MetricSpec DEMO_FRIEND = MetricSpec.day(
            "DEMO_FRIEND", "성별·연령별 분포(서로이웃)", "/api/blog/user/demoCv", "demoFriend", "age", List.of(), "");
    public static final MetricSpec DEMO_ETC = MetricSpec.day(
            "DEMO_ETC", "성별·연령별 분포(이웃 아님)", "/api/blog/user/demoCv", "demoEtc", "age", List.of(), "");
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

    // ---- 일간 현황(daily/cv 응답 안의 블록들): 요청 하나로 함께 받는다 ----

    /**
     * 그 날의 공감수·댓글수·재생수·이웃 증감 합계(응답의 dashboard 블록). 순위 지표(RANK_LIKE 등)는 상위 글만 있어서
     * 일 합계는 여기서만 알 수 있다. 요청은 화면처럼 additionalTimeDimension=WEEK를 붙인다.
     */
    public static final MetricSpec DAILY_SUMMARY = MetricSpec.value(
            "DAILY_SUMMARY", "일간 현황(공감·댓글·재생수)", "/api/blog/daily/cv", "DATE", "dashboard").withExtra("&additionalTimeDimension=WEEK");
    /** 동영상·클립 재생 순위(응답의 rank_play_cnt 블록). 컬럼: vid, rank, videoTitle, createDate, uri. */
    public static final MetricSpec VIDEO_RANK = MetricSpec.day(
            "VIDEO_RANK", "동영상 재생 순위", "/api/blog/daily/cv", "rank_play_cnt", null, List.of(),
            "&additionalTimeDimension=WEEK");

    // ---- 유입 탭(user/referer/*): daily/referer 결과와 같은지는 수집 후 대조했다 ----

    /** 모든 검색 엔진을 합친 검색어(검색어 탭). 행 구분은 검색어. search_query_daily를 검색어별로 합친 값과 비교한다. */
    public static final MetricSpec REFERER_SEARCH = MetricSpec.day(
            "REFERER_SEARCH", "검색어(전체 엔진 합계)", "/api/blog/user/referer/search", "refererSearch", "searchQuery",
            List.of(), "");
    /** 사이트 유입(검색 엔진이 아닌 유입처). 행 구분은 유입처. referrer_daily의 검색 아님 행과 비교한다. */
    public static final MetricSpec REFERER_SITE = MetricSpec.day(
            "REFERER_SITE", "사이트 유입", "/api/blog/user/referer/site", "refererSite", "referrerDomain", List.of(), "");

    // ---- 주간 하루 단위: 마지막으로 끝난 주부터 주마다 한 번씩 ----

    /** 이웃으로 추가한 사람들의 성별·연령(주간). */
    public static final MetricSpec REL_DEMO_ADD = MetricSpec.week(
            "REL_DEMO_ADD", "이웃 추가한 사람의 성별·연령(주간)", "/api/blog/user/relationDemoAdd", "relationDemo", "age");

    // ---- 값(VALUE): 월·게시글 단위로 한 번씩, rows가 아닌 value 객체 ----

    /**
     * 서비스 평균·상위 그룹 평균과의 월간 비교(조회수 cv, 순방문자 uv, 방문 visit, 사용시간 duration).
     * 행은 cv/uv/visit/duration(각각 top_avg, service_avg, max)과 value(averageUserData의 duration/uv/cv/visit)다.
     * 화면은 마지막으로 끝난 달의 1일을 startDate로 보낸다.
     */
    public static final MetricSpec UPPER_GROUP = MetricSpec.value(
            "UPPER_GROUP", "서비스·상위 그룹 평균 비교(월간)", "/api/blog/average/upperGroup", "MONTH",
            "upperGroup,averageUserData");

    // ---- 게시글별: 순위에 나온 게시글마다 한 번씩(요청에 contentId) ----

    /** 게시글 하나의 일별 조회수(한 번에 15일치). 행 구분은 게시글 번호(contentId)다. */
    public static final MetricSpec ARTICLE_CV = MetricSpec.series(
            "ARTICLE_CV", "게시글별 일 조회수", "/api/blog/article/cv", "DATE", "cv").forEachPost();
    /** 게시글 제목, 주소, 누적 조회수·공감·댓글. ARTICLE_CV와 같은 응답에서 함께 받고, 수집한 날짜(to)로 저장한다. */
    public static final MetricSpec ARTICLE_INFO = MetricSpec.value(
            "ARTICLE_INFO", "게시글 정보와 누적 수치", "/api/blog/article/cv", "DATE", "articleInfo,dashboard").forEachPost();

    // ---- 시간대별: 0~23시마다 한 번씩(요청에 hour) ----

    /**
     * 한 시간대의 일별 조회수(한 번에 15일치). 행 구분은 두 자리 시간(00~23)이고, 컬럼은 cv(그 시간대 조회수),
     * cv_daily(그 날 전체 조회수), cv_p(같은 15일 창 안에서 그 시간대 합계 중 비율)다. cv_p는 하루 중 비율이 아니다
     * (2026-11-21 대조: 12시 15일합 173일 때 cv_p = cv/173, 15/15 일치). cv는 HOUR(user/hour/cv)의 날짜x시간 값과 720칸 모두 같다.
     */
    public static final MetricSpec HOUR_TREND = MetricSpec.series(
            "HOUR_TREND", "시간대별 일별 조회수", "/api/blog/user/hour/hourCv", "DATE", "hour").forEachHour();

    /** 수집 순서. 요청이 적은 것부터, 게시글별은 순위가 먼저 있어야 해서 맨 끝에 둔다. */
    public static final List<MetricSpec> ALL = List.of(
            VIEWS, VISITORS, VISITS, DURATION, RELATION_VISIT, RELATION_DELTA, AVG_VISIT_WEEKLY, REVISIT_WEEKLY,
            DEMO, DEMO_FOLLOW, DEMO_FRIEND, DEMO_ETC, DEVICE, HOUR, COUNTRY, RANK_POST, RANK_SUBJECT, RANK_LIKE,
            RANK_COMMENT, DAILY_SUMMARY, VIDEO_RANK, REFERER_SEARCH, REFERER_SITE, REL_DEMO_ADD, UPPER_GROUP, HOUR_TREND,
            ARTICLE_CV, ARTICLE_INFO);

    public static Optional<MetricSpec> find(String id) {
        return ALL.stream().filter(s -> s.id().equalsIgnoreCase(id)).findFirst();
    }
}
