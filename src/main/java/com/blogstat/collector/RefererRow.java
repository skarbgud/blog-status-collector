package com.blogstat.collector;

import java.time.LocalDate;

/** 유입경로 한 줄. visits는 API의 cv, ratio는 cv_p(퍼센트). */
public record RefererRow(LocalDate date, String referrer, boolean searchEngine, int visits, double ratio) {
}
