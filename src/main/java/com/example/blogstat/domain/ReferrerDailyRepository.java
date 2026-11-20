package com.example.blogstat.domain;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

public interface ReferrerDailyRepository extends JpaRepository<ReferrerDaily, Long> {

    List<ReferrerDaily> findByStatDateOrderByVisitsDesc(LocalDate statDate);

    long countByStatDate(LocalDate statDate);

    @Query("select max(r.statDate) from ReferrerDaily r")
    Optional<LocalDate> findLatestStatDate();

    /** 날짜별 합계. 저장된 행이 없는 날짜는 결과에 나오지 않는다. */
    @Query("select r.statDate as statDate, sum(r.visits) as visits, "
            + "sum(case when r.searchEngine = true then r.visits else 0 end) as searchVisits "
            + "from ReferrerDaily r where r.statDate between :from and :to "
            + "group by r.statDate order by r.statDate")
    List<DailyTotal> findDailyTotals(@Param("from") LocalDate from, @Param("to") LocalDate to);

    /** 기간 내 유입처별 합계(방문 많은 순). 개수 제한은 Pageable로 건다. */
    @Query("select r.referrerName as referrerName, r.searchEngine as searchEngine, sum(r.visits) as visits "
            + "from ReferrerDaily r where r.statDate between :from and :to "
            + "group by r.referrerName, r.searchEngine order by sum(r.visits) desc, r.referrerName")
    List<ReferrerTotal> findReferrerTotals(@Param("from") LocalDate from, @Param("to") LocalDate to,
                                           Pageable pageable);

    interface DailyTotal {
        LocalDate getStatDate();

        Long getVisits();

        Long getSearchVisits();
    }

    interface ReferrerTotal {
        String getReferrerName();

        Boolean getSearchEngine();

        Long getVisits();
    }

    /** 벌크 삭제는 즉시 실행되므로 같은 트랜잭션에서 곧바로 재삽입해도 유니크 제약과 충돌하지 않는다. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from ReferrerDaily r where r.statDate = :statDate")
    int deleteByStatDate(@Param("statDate") LocalDate statDate);
}
