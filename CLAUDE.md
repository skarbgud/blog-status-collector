# blog-stat-collector

네이버 블로그 유입경로 통계(https://blog.stat.naver.com/m/blog/daily/referer)를 Playwright로 수집해 H2에 저장한다.

## 스택
- Java 17, Spring Boot 3.5, Gradle, Spring Data JPA, H2(파일 모드), Playwright for Java

## 명령
- 로그인(1회, 수동): `./gradlew bootRun --args="--app.mode=login"` — 네이버 로그인 화면에서 "로그인 상태 유지" 체크
- 수집: `./gradlew bootRun --args="--app.mode=collect --from=2026-11-18 --to=2026-11-19"` (기본: 어제 하루)
- 매일 자동 수집(상주): `./gradlew bootRun --args="--app.mode=schedule"` — 매일 03:10(KST) + 시작 직후 1회, 마지막 저장일 다음 날부터 어제까지 보충(최대 7일). 세션이 만료되면 로그만 남기고 그 회차를 중단한다. cron은 `app.schedule.cron`(환경변수 `APP_SCHEDULE_CRON`)으로 바꾼다.
- 대시보드(읽기 전용): `./gradlew bootRun --args="--spring.profiles.active=dashboard"` → http://127.0.0.1:8080 (로컬 바인딩). **`--app.mode=...`와 함께 켜지 않는다**(시작이 막힌다). 수집은 별도 프로세스로 띄우고, 둘은 동시에 켜도 된다.
- 검색어만 길게 수집: `./gradlew bootRun --args="--app.mode=collect-queries --days=30"` (`--from/--to`, `--force` 가능). 이미 검색어가 있는 날짜는 건너뛴다. 유입경로 표는 건드리지 않는다.
- 스냅샷만 다시 내보내기: `--app.mode=publish` (스냅샷 도입 전 데이터를 처음 내보낼 때, 내보내기 실패 시)
- **직접 실행용 스크립트(Claude 없이)**: `scripts\collect-queries.cmd [일수] [--force]`, `scripts\dashboard.cmd`, `scripts\scheduler.cmd`, `scripts\login.cmd`
- 탐색(XHR 로깅): `./gradlew bootRun --args="--app.mode=explore"`
- 통계 메뉴 전체 탐색: `--app.mode=catalog` — 저장된 쿠키로 headless로 메뉴 링크를 따라가며 각 화면이 부르는 `/api/...`와 응답 구조(키, 컬럼 이름)를 `explore-output/catalog/catalog.md`에 정리한다. 페이지 사이 2~5초, 최대 `app.catalog.max-pages`(기본 40). 콘솔에는 구조만 찍고 값은 찍지 않는다.
  - 2026-11-21 결과: API 29종. 대부분 `?timeDimension=DATE&startDate=...` 형식이고, 응답 `rows`는 referer와 같은 컬럼별 배열이다. 일별 지표(`daily/cv`, `visit/*` 등)는 **한 번 호출에 15일치**가 온다.
- 테스트: `./gradlew test`

## 데이터 소스
- `GET https://blog.stat.naver.com/api/blog/daily/referer/total?timeDimension=DATE&additionalTimeDimension=WEEK&startDate=YYYY-MM-DD&exclude=weekAndMonthAnalysis`
- 응답 `rows`는 컬럼별 배열(행 배열 아님). `refererTotal` 블록의 `cv`합 == `refererTotalCount`로 검증한다.
- 오늘 데이터는 집계 중(`dashboard.isToday`)이라 확정값이 아니다. 어제까지를 upsert로 저장한다.

- 검색어: `GET /api/blog/daily/referer/total/detail?timeDimension=DATE&additionalTimeDimension=WEEK&startDate=YYYY-MM-DD&searchEngine=1&refererDomain=<유입처 이름, 공백은 %20>&size=100&exclude=`
  - 검색 유입처(`referrerSearchEngine=1`)마다 한 번씩 호출한다. 응답 `refererDetail`의 `searchQuery`, `cv`(그 유입처 안의 방문수), `cv_p`.
  - 과거 날짜도 조회된다. `size`는 화면이 20을 쓰고 우리는 100을 쓴다(100도 정상 응답). 검색어 합계가 유입처 방문수와 다르면 일부만 온 것이라 경고를 출력한다.
  - 한 유입처의 검색어 수집이 실패해도 그 날의 나머지는 저장한다(세션 만료는 그대로 중단).

## 저장
- 테이블 `referrer_daily`, 유니크 `(stat_date, referrer_name)`. H2 파일 DB(`./data/blogstat`).
- 테이블 `search_query_daily`, 유니크 `(stat_date, referrer_name, search_query)`. 같은 (유입처, 검색어)가 한 날짜에 두 번 오면 합쳐서 저장한다.
- `ReferrerDailyService.save`는 날짜 단위 트랜잭션에서 그 날짜의 유입경로와 검색어를 지우고 다시 넣는다(멱등). 오늘 데이터는 저장하지 않는다.
- **읽기/쓰기 분리**: H2 파일 DB는 한 프로세스만 열 수 있다. 그래서
  - 쓰기(`collect`, `collect-queries`, `schedule`, `login`)만 `./data/blogstat`를 연다. 쓰기가 끝날 때마다(`CollectJob`, 실패해도 그때까지 저장분) 일관된 스냅샷 `./data/replica/snapshot.sql`(H2 `SCRIPT`)을 내보낸다(`SnapshotPublisher`, 임시 파일에 쓰고 이름을 바꿔 원자적으로 교체).
  - 대시보드는 파일 DB를 열지 않고 인메모리 H2에 스냅샷을 올려 읽는다(`ReplicaLoader`). 스냅샷이 바뀌면 다음 요청 때 자동으로 다시 올린다(대시보드 재시작 불필요). 다시 올리는 동안은 쓰기 잠금으로 요청을 잠깐 막는다.
  - 결과: 파일 잠금 충돌이 없고, 대시보드가 원본을 바꿀 방법이 없다.
- **`AUTO_SERVER=TRUE`를 쓰지 않는다.** sa/빈 비밀번호로 H2 TCP 포트가 모든 인터페이스(`::`)에 열려 개인 통계가 네트워크에 노출된다. 잠금 문제는 위 분리로 푼다.
- 쓰기 프로세스는 동시에 DB를 열 수 없다. 대신 Hikari `minimum-idle: 0`, `idle-timeout: 10s`로 쉬는 동안 연결을 모두 닫아 H2가 파일 잠금을 푼다. 그래서 상주 스케줄러가 수집 중이 아니면(수집 끝나고 최대 약 40초 뒤부터) `collect-queries.cmd`를 같이 돌릴 수 있다.
  - 둘이 정말 겹치면 늦게 연 쪽이 "Database may be already in use"로 실패한다. `collect-queries`는 다시 실행하면 되고(받은 날짜는 건너뜀), 스케줄러 회차는 로그만 남기고 다음 회차 보충으로 메운다.
- 검색어 과거분 보충: 이미 저장된 날짜도 `collect --from --to`로 다시 수집하면 검색어가 채워진다(교체 저장).

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
