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
- 나머지 지표 전부 수집: `./gradlew bootRun --args="--app.mode=collect-metrics --days=30"` (`--from/--to`, `--only=VIEWS,HOUR`, `--force` 가능) — 조회수, 방문자, 시간대, 성별·연령, 기기, 국가, 게시글·주제 순위 등 16종(`MetricSpecs`). 30일이면 요청 260회 안팎(요청 사이 2~5초, 약 15~20분)이고 한 회차 상한은 `app.metrics.max-requests-per-run`(320). 쓰기 프로세스다. 상한에서 멈추면 같은 명령을 다시 실행하면 이어서 받는다. 스크립트: `scripts\collect-metrics.cmd [일수] [--force]`
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

- 지표(유입경로·검색어 외): `GET /api/blog/<경로>?timeDimension=DATE&startDate=YYYY-MM-DD&exclude=` 형식이고 응답은 같은 컬럼별 배열이다. 목록과 응답 블록(`dataId`)은 `collector/metric/MetricSpecs`에 있다.
  - **시계열**(`visit/cv`, `visit/uv`, `visit/visit`, `visit/averageDuration`, `user/relationVisitCv`, `user/relationDelta`)은 한 번에 **15일치**가 `startDate`에서 거꾸로 온다. 주간(`visit/averageVisit`, `visit/revisit`)은 `timeDimension=WEEK`이고 `startDate`는 마지막으로 끝난 주의 월요일, 15주치가 온다.
  - **하루 단위**(`user/demoCv`, `user/device/mobile`, `user/hour/cv`, `user/country`, `rank/cvContentPc`, `rank/cvSubjectPc`, `rank/likePc`, `rank/commentPc`)는 날짜마다 한 번씩 부르고 과거 날짜도 조회된다.
  - 국가(`country`)는 네이버가 국가를 분류하지 못한 방문을 빼고 계산해서, `cv` 합이 조회수보다 1~2 적은 날이 있다(`cv_p` 합은 100). 파싱 오류가 아니다.
  - 기기(`device`)는 구분 컬럼 없이 행 4개가 오는데, 2026-11-20 응답에서 행별 pc+mobile 합이 조회수의 total, etc, follow, friend와 일치해서 이 순서로 이름을 붙였다.
  - **네이버가 어제분을 늦게 집계한다.** 2026-11-21 02:36에 받은 11/20은 순방문자(`visit/uv`)가 0, 시간대(`user/hour/cv`)의 `cv`가 24시간 모두 0이었다(조회수는 110). 시계열은 매번 다시 받아 덮어쓰므로 자동으로 채워진다. 하루 단위는 `MetricSpec.pendingWhenZero`로 "그 컬럼 합이 0이면 저장하지 않고, 앞서 저장된 값은 지우고, 다음 실행에서 다시 받는다".
- 검색어: `GET /api/blog/daily/referer/total/detail?timeDimension=DATE&additionalTimeDimension=WEEK&startDate=YYYY-MM-DD&searchEngine=1&refererDomain=<유입처 이름, 공백은 %20>&size=100&exclude=`
  - 검색 유입처(`referrerSearchEngine=1`)마다 한 번씩 호출한다. 응답 `refererDetail`의 `searchQuery`, `cv`(그 유입처 안의 방문수), `cv_p`.
  - 과거 날짜도 조회된다. `size`는 화면이 20을 쓰고 우리는 100을 쓴다(100도 정상 응답). 검색어 합계가 유입처 방문수와 다르면 일부만 온 것이라 경고를 출력한다.
  - 한 유입처의 검색어 수집이 실패해도 그 날의 나머지는 저장한다(세션 만료는 그대로 중단).

## 저장
- 테이블 `referrer_daily`, 유니크 `(stat_date, referrer_name)`. H2 파일 DB(`./data/blogstat`).
- 테이블 `search_query_daily`, 유니크 `(stat_date, referrer_name, search_query)`. 같은 (유입처, 검색어)가 한 날짜에 두 번 오면 합쳐서 저장한다.
- 테이블 `metric_row`, 유니크 `(stat_date, metric, row_key)`. 나머지 지표 전부가 이 표 하나에 들어가고, 응답 컬럼은 `payload` JSON 한 덩어리다(지표마다 컬럼이 달라 표를 늘리지 않는다). 시계열은 `row_key=all`, 하루 단위는 연령 코드·시간·국가·순위 번호(`r001`…)·이웃 구분이다. 데이터가 없는 날은 `_empty` 행을 남겨 다시 요청하지 않는다. `MetricService.replace`는 그 지표의 해당 날짜만 지우고 다시 넣는다(멱등). 조회 API는 `GET /api/dashboard/metrics?from&to`.
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

## 여러 Claude 세션이 동시에 작업할 때 (중요)
이 저장소는 Claude 세션 두 개 이상이 동시에 작업한다. 어느 세션이든 실행·테스트·커밋·푸시를 할 수 있지만, **실행 자원(프로세스, 8080 포트, H2 파일, 메모리, git 스테이징)은 공유**되므로 아래를 지킨다.

**프로세스**
- 프로세스를 띄우거나 내리기 전에 지금 떠 있는 것부터 확인한다.
  확인 명령(PowerShell): `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | ? { $_.CommandLine -match 'BlogStatApplication' } | select ProcessId, CommandLine`
  - 8080 포트 사용 중: `Get-NetTCPConnection -LocalPort 8080 -State Listen`
- **내가 이번 세션에서 띄우지 않은 프로세스는 종료하지 않는다.** 대시보드든 수집이든 마찬가지다. 막히면 사용자에게 누가 띄운 것인지, 종료해도 되는지 묻는다.
- 쓰기 프로세스(`collect`, `collect-queries`, `schedule`, `login`)가 이미 떠 있으면 다른 쓰기 프로세스를 새로 띄우지 않는다(H2 파일 잠금). 끝나기를 기다리거나 사용자에게 알린다.
- 대시보드(8080)가 이미 떠 있으면 새로 띄우지 않는다. 재시작이 필요하면 띄운 세션이 하거나, 사용자 확인 후 한다. 대시보드는 스냅샷을 자동 반영하므로 데이터 갱신만을 위해서는 재시작하지 않는다.
- `./gradlew --stop`은 모든 세션의 gradle 데몬과 빌드를 멈추므로 쓰지 않는다.

**메모리**
- 이 PC는 메모리가 빠듯하다(VS Code Java, gradle 데몬, 대시보드가 함께 뜬다). 테스트 실행기가 `insufficient memory`(오류 1455)로 죽으면 코드 문제가 아니라 메모리 부족이다. 테스트 결과로 보고하지 말고 "메모리 부족으로 미확인"이라고 알린다.
- 다른 세션이 빌드·테스트 중이면(gradle 데몬이 바쁨) 동시에 `./gradlew test`를 돌리지 않는다.

**git**
- `git add`는 파일을 하나씩 지정한다. 폴더 단위(`git add src/...`), `git add -A`, `git add .` 금지. 다른 세션이 작업 중인 미커밋 파일이 섞인다.
- 커밋 전에 `git status`로 내가 만들거나 고친 파일만 스테이징됐는지 확인한다. 내가 손대지 않은 미커밋 파일은 다른 세션의 작업 중인 코드이므로 커밋하지 않는다(사용자가 명시적으로 요청한 경우만 예외).
- 같은 파일을 다른 세션이 고치는 중이면(미커밋 변경이 있거나 디스크에서 바뀌었다는 알림이 오면) 그 파일은 수정하지 않고 사용자에게 알린다.
- 푸시 전에 `git fetch` 후 `origin/main`과의 차이를 확인한다. 강제 푸시(`--force`) 금지.
