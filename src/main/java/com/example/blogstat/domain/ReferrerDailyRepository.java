package com.example.blogstat.domain;

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

    /** 벌크 삭제는 즉시 실행되므로 같은 트랜잭션에서 곧바로 재삽입해도 유니크 제약과 충돌하지 않는다. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from ReferrerDaily r where r.statDate = :statDate")
    int deleteByStatDate(@Param("statDate") LocalDate statDate);
}
