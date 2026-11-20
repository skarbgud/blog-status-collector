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

    /** 벌크 삭제는 즉시 실행되므로 같은 트랜잭션에서 곧바로 재삽입해도 유니크 제약과 충돌하지 않는다. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from MetricRow m where m.metric = :metric and m.statDate in :dates")
    int deleteByMetricAndStatDates(@Param("metric") String metric, @Param("dates") Collection<LocalDate> dates);
}
