package com.example.blogstat.collector.metric;

import java.util.List;

/**
 * 수집할 지표 하나의 정의. 어떤 API를 어떻게 부르고, 응답의 어느 블록을 어떻게 행으로 풀지만 담는다.
 * 같은 API(경로·시간 단위·추가 쿼리가 같은 것)를 쓰는 지표들은 한 번의 요청으로 함께 받는다.
 *
 * @param id         저장 식별자(metric_row.metric). 바꾸면 기존 저장분과 연결이 끊긴다
 * @param label      사람이 읽는 이름
 * @param kind       시계열은 한 번에 15일치가 오고, 하루 단위는 날짜마다 한 번, 값(VALUE)은 월·게시글 같은 단위마다 한 번
 * @param path       API 경로
 * @param timeDim    timeDimension 값(DATE, WEEK, MONTH)
 * @param blockId    응답 statDataList에서 읽을 블록의 dataId. VALUE는 쉼표로 여러 블록
 * @param keyColumn  하루 단위 지표에서 행을 구분하는 컬럼 이름(없으면 indexKeys 또는 순번)
 * @param indexKeys  컬럼 대신 행 순서로 이름을 붙일 때의 이름들
 * @param extraQuery 화면이 함께 보내는 추가 쿼리(앞에 &를 붙인 문자열), 없으면 빈 문자열
 * @param pendingColumn 하루 단위 지표에서, 이 컬럼의 합이 0이면 네이버가 아직 집계하지 않은 날로 보고 저장하지 않는 컬럼.
 *                   저장하지 않으면 다음 실행에서 다시 받는다. 없으면 null
 * @param perPost    게시글마다 한 번씩 부르는 지표(요청에 contentId를 붙이고, 행 구분은 게시글 번호)
 * @param perHour    시간대(0~23시)마다 한 번씩 부르는 지표(요청에 hour를 붙이고, 행 구분은 두 자리 시간)
 */
public record MetricSpec(String id, String label, Kind kind, String path, String timeDim, String blockId,
                         String keyColumn, List<String> indexKeys, String extraQuery, String pendingColumn,
                         boolean perPost, boolean perHour) {

    public enum Kind {
        /** 응답 rows.date가 날짜이고 한 번에 15일(또는 15주)치가 온다. */
        SERIES,
        /** 요청한 날짜 하루의 분포나 순위. */
        DAY,
        /** rows가 아니라 data.value(객체)로 오는 값. 월 비교 지표와 게시글 정보가 이 형태다. */
        VALUE
    }

    /** 시계열 한 건이 끌어오는 일수(주간 지표는 15주라 호출하는 쪽이 따로 다룬다). */
    public static final int SERIES_WINDOW_DAYS = 15;

    /** 행으로 풀지 않는 VALUE 지표에서 객체가 아닌 값들을 모아 담는 행 이름. */
    public static final String VALUE_ROW = "value";

    public boolean isSeries() {
        return kind == Kind.SERIES;
    }

    public boolean isValue() {
        return kind == Kind.VALUE;
    }

    /** 읽을 블록 id들. */
    public List<String> blockIds() {
        return List.of(blockId.split(","));
    }

    /** 같은 요청으로 함께 받을 수 있는 지표인지 가르는 값. 시간 단위와 추가 쿼리까지 같아야 한다. */
    public String requestKey() {
        return path + "|" + timeDim + "|" + extraQuery + "|" + perPost + "|" + perHour;
    }

    static MetricSpec series(String id, String label, String path, String timeDim, String blockId) {
        return new MetricSpec(id, label, Kind.SERIES, path, timeDim, blockId, null, List.of(), "", null, false, false);
    }

    static MetricSpec day(String id, String label, String path, String blockId, String keyColumn,
                          List<String> indexKeys, String extraQuery) {
        return new MetricSpec(id, label, Kind.DAY, path, "DATE", blockId, keyColumn, indexKeys, extraQuery, null, false, false);
    }

    /** 주 단위로 한 번씩 받는 하루 단위 지표(timeDimension=WEEK). */
    static MetricSpec week(String id, String label, String path, String blockId, String keyColumn) {
        return new MetricSpec(id, label, Kind.DAY, path, "WEEK", blockId, keyColumn, List.of(), "", null, false, false);
    }

    static MetricSpec value(String id, String label, String path, String timeDim, String blockIds) {
        return new MetricSpec(id, label, Kind.VALUE, path, timeDim, blockIds, null, List.of(), "", null, false, false);
    }

    /** 이 컬럼의 합이 0인 날은 집계 전이라 저장하지 않는 지표로 바꾼 사본. */
    MetricSpec pendingWhenZero(String column) {
        return new MetricSpec(id, label, kind, path, timeDim, blockId, keyColumn, indexKeys, extraQuery, column, perPost, perHour);
    }

    /** 게시글마다 부르는 지표로 바꾼 사본. */
    MetricSpec forEachPost() {
        return new MetricSpec(id, label, kind, path, timeDim, blockId, keyColumn, indexKeys, extraQuery, pendingColumn, true, perHour);
    }

    /** 시간대(0~23시)마다 부르는 지표로 바꾼 사본. */
    MetricSpec forEachHour() {
        return new MetricSpec(id, label, kind, path, timeDim, blockId, keyColumn, indexKeys, extraQuery, pendingColumn, perPost, true);
    }
}
