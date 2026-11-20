package com.example.blogstat.domain;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.LocalDate;
import java.util.List;

public interface SearchQueryDailyRepository extends JpaRepository<SearchQueryDaily, Long> {

    long countByStatDate(LocalDate statDate);

    List<SearchQueryDaily> findByStatDateBetween(LocalDate from, LocalDate to);

    /** 검색어가 저장된 가장 최근 날짜. 검색어 변화의 기준일로 쓴다. */
    @Query("select max(q.statDate) from SearchQueryDaily q")
    java.util.Optional<LocalDate> findLatestStatDate();

    /** 기간 안에서 검색어가 한 건이라도 저장된 날짜. */
    @Query("select distinct q.statDate from SearchQueryDaily q where q.statDate between :from and :to")
    List<LocalDate> findDatesWithQueries(@Param("from") LocalDate from, @Param("to") LocalDate to);

    /** 벌크 삭제는 즉시 실행되므로 같은 트랜잭션에서 곧바로 재삽입해도 유니크 제약과 충돌하지 않는다. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("delete from SearchQueryDaily q where q.statDate = :statDate")
    int deleteByStatDate(@Param("statDate") LocalDate statDate);
}
