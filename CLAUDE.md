# blog-stat-collector

네이버 블로그 유입경로 통계(https://blog.stat.naver.com/m/blog/daily/referer)를 Playwright로 수집해 H2에 저장한다.

## 스택
- Java 17, Spring Boot 3.5, Gradle, Spring Data JPA, H2(파일 모드), Playwright for Java

## 명령
- 로그인(1회, 수동): `./gradlew bootRun --args="--app.mode=login"` — 네이버 로그인 화면에서 "로그인 상태 유지" 체크
- 수집: `./gradlew bootRun --args="--app.mode=collect --from=2026-11-18 --to=2026-11-19"` (기본: 어제 하루)
- 매일 자동 수집(상주): `./gradlew bootRun --args="--app.mode=schedule"` — 매일 03:10(KST) + 시작 직후 1회, 마지막 저장일 다음 날부터 어제까지 보충(최대 7일). 세션이 만료되면 로그만 남기고 그 회차를 중단한다. cron은 `app.schedule.cron`(환경변수 `APP_SCHEDULE_CRON`)으로 바꾼다.
- 대시보드: `./gradlew bootRun --args="--spring.profiles.active=dashboard"` → http://127.0.0.1:8080 (로컬 바인딩, 조회 전용). 자동 수집과 함께 띄우려면 `--app.mode=schedule`를 같이 준다.
- 탐색(XHR 로깅): `./gradlew bootRun --args="--app.mode=explore"`
- 테스트: `./gradlew test`

## 데이터 소스
- `GET https://blog.stat.naver.com/api/blog/daily/referer/total?timeDimension=DATE&additionalTimeDimension=WEEK&startDate=YYYY-MM-DD&exclude=weekAndMonthAnalysis`
- 응답 `rows`는 컬럼별 배열(행 배열 아님). `refererTotal` 블록의 `cv`합 == `refererTotalCount`로 검증한다.
- 오늘 데이터는 집계 중(`dashboard.isToday`)이라 확정값이 아니다. 어제까지를 upsert로 저장한다.

## 저장
- 테이블 `referrer_daily`, 유니크 `(stat_date, referrer_name)`. H2 파일 DB(`./data/blogstat`).
- `ReferrerDailyService.save`는 날짜 단위 트랜잭션에서 그 날짜 행을 지우고 다시 넣는다(멱등). 오늘 데이터는 저장하지 않는다.

## 세션 (중요)
- persistent profile 쿠키 DB만으로는 네이버 로그인이 다음 실행에 유지되지 않았다(원인 미확인, 브라우저 종료 후 쿠키 DB가 비어 있음).
- 그래서 로그인 직후 쿠키를 `.playwright-profile/session-cookies.json`에 저장하고, 수집 때 복원한다. 이 파일은 로그인 권한 그 자체다.
- 만료 경고: `SessionStore.status()`가 NID_SES/NID_AUT 중 빠른 만료 시각으로 남은 일수를 계산한다(`app.session.warn-days`, 기본 7일 이내면 임박). 스케줄러가 돌 때마다 로그에 남기고, 대시보드 상단 배너(`GET /api/dashboard/session`)로 보여준다. 쿠키 값은 어디에도 내보내지 않는다.
- 쿠키 만료(HTTP 401/403)는 재시도하지 않고 `SessionExpiredException`으로 중단한다. 로그인을 다시 하면 된다.

## 규칙
- 로그인은 사람이 브라우저에서 수동으로만 한다. ID/PW 자동 입력, 캡차 우회 금지.
- `.playwright-profile/`은 로그인 쿠키가 들어 있다. 커밋, 출력, 공유 금지.
- 수집은 본인 계정 통계만, 저빈도(하루 1회, 날짜 사이 2~5초 지연).
- `explore-output/`와 `data/`는 개인 통계 데이터라 gitignore 대상이다.
