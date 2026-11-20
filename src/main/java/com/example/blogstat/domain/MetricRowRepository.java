package com.example.blogstat.domain;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface MetricRowRepository extends JpaRepository<MetricRow, Long> {

    List<MetricRow> findByStatDateBetweenOrderByStatDateAscMetricAscIdAsc(LocalDate from, LocalDate to);

    @Query("select max(m.statDate) from MetricRow m")
    Optional<LocalDate> findLatestStatDate();

    /** 그 지표가 한 행이라도(빈 표시 포함) 저장된 날짜. 이미 받은 날짜를 건너뛰는 데 쓴다. */
    @Query("select distinct m.statDate from MetricRow m "
            + "where m.metric = :metric and m.statDate between :from and :to")
    List<LocalDate> findDatesWithMetric(@Param("metric") String metric,
                                        @Param("from") LocalDate from, @Param("to") LocalDate to);

    /** 그 지표가 저장된 가장 최근 날짜. 월·게시글 단위 값처럼 조회 기간과 상관없이 최신값이 필요한 지표에 쓴다. */
    @Query("select max(m.statDate) from MetricRow m where m.metric = :metric")
    Optional<LocalDate> findLatestStatDateOf(@Param("metric") String metric);

    List<MetricRow> findByMetricAndStatDateOrderByIdAsc(String metric, LocalDate statDate);

    /** 그 지표·날짜에 저장된 행 구분값들. 게시글별 지표에서 이미 받은 게시글을 건너뛰는 데 쓴다. */
    @Query("select m.rowKey from MetricRow m where m.metric = :metric and m.statDate = :date")
    List<String> findRowKeys(@Param("metric") String metric, @Param("date") LocalDate date);

    /** 지정한 지표들의 기간 내 payload. 순위에 나온 게시글 주소를 모을 때 쓴다. */
    @Query("select m.payload from MetricRow m where m.metric in :metrics and m.statDate between :from and :to")
    List<String> findPayloads(@Param("metrics") Collection<String> metrics,
                              @Param("from") LocalDate from, @Param("to") LocalDate to);

    /** 지표별 저장 행 수(빈 표시 제외). 수집 현황 표시용. */
    @Query("select m.metric as metric, count(m) as rows, min(m.statDate) as firstDate, max(m.statDate) as lastDate "
            + "from MetricRow m where m.rowKey <> '_empty' group by m.metric order by m.metric")
    List<MetricSummary> summarize();

    interface MetricSummary {
        String getMetric();

        Long getRows();

        LocalDate getFirstDate();

        LocalDate getLastDate();
    }

    /** "조회 불가" 표시 행(값이 없는 행)을 지운다. 시계열 지표에는 있을 수 없는 행이라 잘못 들어간 것을 정리할 때 쓴다. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from MetricRow m where m.metric = :metric and m.payload = '{\"unavailable\":true}'")
    int deleteUnavailableMarkers(@Param("metric") String metric);

    /** 게시글별 지표처럼 같은 날짜에 여러 행 구분이 섞여 있을 때, 한 행 구분만 지운다. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from MetricRow m where m.metric = :metric and m.rowKey = :rowKey and m.statDate in :dates")
    int deleteByMetricAndRowKeyAndStatDates(@Param("metric") String metric, @Param("rowKey") String rowKey,
                                            @Param("dates") Collection<LocalDate> dates);

    /** 벌크 삭제는 즉시 실행되므로 같은 트랜잭션에서 곧바로 재삽입해도 유니크 제약과 충돌하지 않는다. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from MetricRow m where m.metric = :metric and m.statDate in :dates")
    int deleteByMetricAndStatDates(@Param("metric") String metric, @Param("dates") Collection<LocalDate> dates);
}
