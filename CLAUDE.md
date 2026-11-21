# blog-stat-collector

네이버 블로그 유입경로 통계(https://blog.stat.naver.com/m/blog/daily/referer)를 Playwright로 수집해 H2에 저장한다.

## 크롬 확장 버전 (`extension/`, 브랜치 feature/google-chrome-extension)
서버·DB 서버 없이 수집·저장(SQLite WASM, OPFS)·대시보드가 모두 크롬 안에서 돈다. 개인이 자기 블로그 하나만 쓴다(local-first).
사용법·권한·데이터는 `extension/README.md`. 아래 Java 버전은 v1(태그 `v1.0.0`)이고, 병행 비교가 끝날 때까지 골든 생성기와 비교 기준으로 남긴다.
- 명령: `cd extension && npm run build`(→ `dist`를 압축해제 로드), `npm test`
- Java 쪽 보조: 골든 `GOLDEN_DIR="$(pwd)/extension/test" ./gradlew test --tests '*GoldenDumpTest'`, 내보내기 `./gradlew exportJson`
- **규칙(확장)**
  - 네이버 요청은 `core/naver.ts`의 `StatClient`만 보낸다. `blog.stat.naver.com`의 허용 목록 경로 GET만, 요청 사이 2~5초, 401/403이면 중단. 하루 상한은 기본 없음(2026-11-21 사용자 결정, 옵션에서 둘 수 있음). 오늘 끝난 뒤에는 로컬에서 센 "새 할 일"이 있을 때만 다시 돈다(같은 실패만 남으면 그날은 쉼).
  - 쿠키는 "있는지"만 본다. 값을 쓰거나 저장하거나 출력하지 않는다. user-info 응답은 blogId만 쓰고(baUserKey 금지) 원문을 저장하지 않는다.
  - 원격 코드 금지(라이브러리는 번들). 데이터를 브라우저 밖으로 보내지 않는다(분석·원격 로그 없음).
  - 이식한 동작을 바꾸면 Java 골든(`extension/test/golden`)과 맞는지 먼저 본다. 조회 계층은 `tools/parity.ts`로 Java 대시보드와 대조한다.
  - 대시보드 화면 `static/dashboard*.{html,js}`은 Java `static/index.html`에서 옮겼다(인라인 스크립트만 파일로 분리). 화면을 고치면 이 파일들을 고친다.
  - 차트는 Highcharts(개인·비상업 무료, 상업 이용은 라이선스 필요)이고 `static/charts.js`의 `BlogCharts.draw(el, spec)`로만 그린다. 테마·숫자 형식·반응형 규칙은 그 파일 한 곳에 있다. 외부 값(유입처·주제 이름)은 그 안에서 이스케이프한다.

## 스택
- Java 17, Spring Boot 3.5, Gradle, Spring Data JPA, H2(파일 모드), Playwright for Java

## 명령
- 로그인(1회, 수동): `./gradlew bootRun --args="--app.mode=login"` — 네이버 로그인 화면에서 "로그인 상태 유지" 체크
- 수집: `./gradlew bootRun --args="--app.mode=collect --from=2026-11-18 --to=2026-11-19"` (기본: 어제 하루)
- 매일 자동 수집(상주): `./gradlew bootRun --args="--app.mode=schedule"` — 매일 03:10(KST) + 시작 직후 1회, 마지막 저장일 다음 날부터 어제까지 보충(최대 7일). 세션이 만료되면 로그만 남기고 그 회차를 중단한다. cron은 `app.schedule.cron`(환경변수 `APP_SCHEDULE_CRON`)으로 바꾼다.
- 대시보드(읽기 전용): `./gradlew bootRun --args="--spring.profiles.active=dashboard"` → http://127.0.0.1:8080 (로컬 바인딩). **`--app.mode=...`와 함께 켜지 않는다**(시작이 막힌다). 수집은 별도 프로세스로 띄우고, 둘은 동시에 켜도 된다.
- 검색어만 길게 수집: `./gradlew bootRun --args="--app.mode=collect-queries --days=30"` (`--from/--to`, `--force` 가능). 이미 검색어가 있는 날짜는 건너뛴다. 유입경로 표는 건드리지 않는다.
- 나머지 지표 전부 수집: `./gradlew bootRun --args="--app.mode=collect-metrics --days=30"` (`--from/--to`, `--only=VIEWS,HOUR`, `--force` 가능) — 조회수, 방문자, 시간대, 성별·연령(이웃 구분별 포함), 기기, 국가, 게시글·주제 순위, 월간 평균 비교, 게시글별 조회수와 누적 수치 등 28종(`MetricSpecs`). 처음 30일치는 요청 600회 안팎(요청 사이 2~5초, 약 30분), 이후 매일 수집은 100회 안팎이고 한 회차 상한은 `app.metrics.max-requests-per-run`(600). 쓰기 프로세스다. 상한에서 멈추면 같은 명령을 다시 실행하면 이어서 받는다. 스크립트: `scripts\collect-metrics.cmd [일수] [--force]`
- 스냅샷만 다시 내보내기: `--app.mode=publish` (스냅샷 도입 전 데이터를 처음 내보낼 때, 내보내기 실패 시)
- 유입경로·검색어를 30일치로 채우려면 `collect --from=… --to=…`를 쓴다(2026-11-21에 10/22~11/20을 백필, 165회·약 10분, 한 회차 상한 200). `collect-metrics`는 유입경로·검색어를 받지 않는다.
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
  - **이웃 구분별 성별·연령**(`demoFollow`, `demoFriend`, `demoEtc`)은 `user/demoCv`의 다른 블록이라 요청 하나로 `DEMO`와 함께 받는다(같은 API를 쓰는 지표는 `MetricSpec.requestKey()`로 묶어 한 번만 부른다). 세 구분의 합은 전체(`demo`)보다 1% 안팎 적다.
  - **주 단위 하루 지표**(`user/relationDemoAdd`, `timeDimension=WEEK`)는 끝난 주의 월요일을 `startDate`로 주마다 한 번. **월간 비교**(`average/upperGroup`, `timeDimension=MONTH`)는 마지막으로 끝난 달 1일을 `startDate`로 한 번이고, 값이 `rows`가 아니라 `data.value` 객체(`MetricSpec.Kind.VALUE`)다. 서비스 평균·상위 그룹 평균은 월 단위 값이다.
  - **게시글별**(`article/cv?contentId=`)은 조회·공감·댓글 순위에 나온 게시글마다 시계열 창(15일) 수만큼 부른다. 블록 `cv`는 일별 조회수(행 구분=게시글 번호), `articleInfo`+`dashboard`는 제목·주소·누적 조회수·공감·댓글이다. 이미 받은 게시글은 건너뛰고, 저장은 게시글 번호로 범위를 좁혀 다른 게시글 행을 지우지 않는다(`MetricService.replace(…, rowKey)`). **HTTP 400을 주는 글은 삭제된 글로 판단한다**(순위 행 1,043개 중 제목·작성일이 빈 행이 2개뿐이고 둘 다 이 글, 나머지 81개 글은 정상 수집. 다만 네이버가 삭제 여부를 직접 알려 주지는 않아 추정이다. 공개 페이지로 확인하려 했으나 비로그인 접근은 정상 글도 "게시물이 삭제되었어요"로 응답해 판별할 수 없었다. 같은 저장 세션·같은 요청 형태로 정상 글은 200, 이 글만 `{"statusCode":400,"message":"bad request","result":null}`을 준다(2026-11-21 확인). 날짜(11/09, 11/10, 10/22)와 단위(WEEK, MONTH)를 바꿔 5가지로 요청해도 전부 같은 400이라, 요청 조합으로 이 글의 추가 데이터를 얻을 방법이 없다. 요청 형식 문제가 아니라 이 게시글 번호를 API가 거부하는 것이고 이유는 더 알려 주지 않는다. 이 글에서 얻을 수 있는 데이터(순위 조회 2, 공감 2)는 저장돼 있고 나머지는 API가 응답을 거절하므로 수집 누락이 아니다). 실패로 세지 않고 `ARTICLE_INFO`에 `{"unavailable":true}` 표시를 수집일(to)로 남겨 그 날은 다시 부르지 않고, 다음 날 한 번 다시 확인한다(일시적 오류면 되살아난다). **표시는 정보 지표(`ARTICLE_INFO`)에만 남겨야 한다.** 이전 버전이 시계열(`ARTICLE_CV`)에도 남겨 그 글이 조회수 0인 글로 보였다. 그래서 수집을 시작할 때 `repairMarkers`가 시계열 지표의 표시 행을 지운다.
  - **시간대별 일별 추이**(`user/hour/hourCv?hour=HH`)는 시간대마다(0~23) 시계열 창만큼 부른다. **`hour`는 화면처럼 두 자리(`05`)로 보내야 한다.** `hour=5`로 보내면 0~9시가 전부 0으로 오고 요청은 200이라 오류로 드러나지 않는다(2026-11-21 `HOUR`와 대조해서 발견). 컬럼 `cv_daily`는 그 날 전체 조회수이고, `cv_p`는 하루 중 비율이 아니라 **같은 15일 창 안에서 그 시간대 합계 중 비율**이라 창 경계에 따라 값이 달라진다(15/15 일치로 확인).
  - 국가(`country`)는 네이버가 국가를 분류하지 못한 방문을 빼고 계산해서, `cv` 합이 조회수보다 1~2 적은 날이 있다(`cv_p` 합은 100). 파싱 오류가 아니다.
  - 기기(`device`)는 구분 컬럼 없이 행 4개가 오는데, 2026-11-20 응답에서 행별 pc+mobile 합이 조회수의 total, etc, follow, friend와 일치해서 이 순서로 이름을 붙였다.
  - **네이버가 어제분을 늦게 집계한다.** 2026-11-21 02:36에 받은 11/20은 순방문자(`visit/uv`)가 0, 시간대(`user/hour/cv`)의 `cv`가 24시간 모두 0이었다(조회수는 110). 약 40분 뒤(03:20대) 다시 받았을 때는 확정돼 있었다(시간대 합 110, 순방문자 79). 시계열은 매번 다시 받아 덮어쓰므로 자동으로 채워진다. 하루 단위는 `MetricSpec.pendingWhenZero`로 "그 컬럼 합이 0이면 저장하지 않고, 앞서 저장된 값은 지우고, 다음 실행에서 다시 받는다".
- **카탈로그 29종 처리 결과**(2026-11-21 평가, 근거는 저장 데이터·원문 대조). 새 API는 아래 표에 먼저 넣는다.
  | API | 처리 |
  |---|---|
  | `user-info` | 블로그 ID 정보라 지표가 아니다. 저장하지 않음 |
  | `daily/referer/total`, `…/detail` | `referrer_daily`, `search_query_daily` |
  | `user/referer/total` | `daily/referer/total`과 같은 블록·값(유입처, cv, 검색 플래그 일치 확인). 중복이라 저장하지 않음 |
  | `user/referer/search` | `REFERER_SEARCH`. **상위 검색어 + `기타`(꼬리를 한 줄로 묶은 값)** 형태다. 날짜별 검색어 합 30일 모두 `search_query_daily`와 일치(704 = 704)하고, 날짜별로 "DB에만 있는 검색어(대부분 방문 1회짜리 꼬리 124개 조합)의 방문 합 = 네이버 `기타`"도 모든 날 일치한다. 양쪽에 다 있는 (날짜, 검색어) 조합의 방문수 불일치는 0건. 즉 데이터가 다른 게 아니라 해상도 차이이고 `search_query_daily`(유입처별 상세 API)가 꼬리까지 개별로 갖고 있어 더 정밀하다 |
  | `user/referer/site` | `REFERER_SITE`. 18곳 모두 `referrer_daily`의 검색 아닌 행과 일치(합 6,448) |
  | `daily/cv` | `cv` 블록은 `visit/cv.total`과 같아 중복(15일 일치). 같은 응답의 `dashboard`(일 공감·댓글·재생·이웃 증감)는 `DAILY_SUMMARY`, `rank_play_cnt`(동영상 재생 순위)는 `VIDEO_RANK`로 저장 |
  | `daily/visit` | `visit` 블록이 `visit/visit`과 같아 중복(15일 일치) |
  | `daily/rankCv` | `rankCv` 블록이 `rank/cvContentPc`와 같아 중복(행 일치) |
  | `daily/demo` | `demo` 블록이 `user/demoCv.demo`와 같아 중복 |
  | `visit/cv`, `uv`, `visit`, `averageDuration`, `averageVisit`, `revisit` | `VIEWS`, `VISITORS`, `VISITS`, `DURATION`, `AVG_VISIT_WEEKLY`, `REVISIT_WEEKLY` |
  | `user/relationDelta`, `relationVisitCv`, `relationDemoAdd` | `RELATION_DELTA`, `RELATION_VISIT`, `REL_DEMO_ADD` |
  | `user/demoCv`, `device/mobile`, `hour/cv`, `hour/hourCv`, `country` | `DEMO`(+`DEMO_FOLLOW/FRIEND/ETC`), `DEVICE`, `HOUR`, `HOUR_TREND`, `COUNTRY` |
  | `rank/cvContentPc`, `likePc`, `commentPc`, `cvSubjectPc` | `RANK_POST`, `RANK_LIKE`, `RANK_COMMENT`, `RANK_SUBJECT` |
  | `average/upperGroup`, `article/cv` | `UPPER_GROUP`, `ARTICLE_CV`+`ARTICLE_INFO` |
  - `daily/*` 응답의 `weekAndMonthAnalysis` 블록(주·월 합계 uv, cv, revisit, averageVisit, visit, relationDelta)은 일별 시계열과 주간 지표로 구할 수 있어 저장하지 않는다.
  - **이웃 구분별 성별·연령의 합은 전체(`demo`)보다 작다**(합 53명, 0.8%). 360개 (날짜×연령) 셀 중 52개, 30일 중 18일에서, 하루 최대 6명이고 **방향은 항상 전체 ≥ 세 구분 합**이다. 차이가 나는 셀은 모두 서로이웃·피이웃 값이 0이고 `etc`(이웃 아님)만 전체보다 1~4 작다. 71 대 69 같은 큰 셀에도 있어서 소수 셀 숨김은 아니다. 조회수 쪽 세 구분(`VIEWS`)은 합이 total과 정확히 같으므로(110 = 96 + 11 + 3) 인구통계 집계에서만 구분에 안 들어가는 방문자가 있는 것으로 보이나, **원본 응답에 이미 차이가 있다**(2026-11-01 `user/demoCv`를 직접 받아 확인: 전체 146, 세 구분 합 140, 차이 6. 각 블록은 total 행 = 연령 행 합으로 내부 정합). 그래서 수집·저장 결함이 아니라 네이버 데이터의 특성이다. 왜 구분에 안 들어가는지는 네이버 내부 집계라 외부에서 확정할 수 없다. 대시보드는 구분별 차트에 이 차이를 안내 문구로 보여 준다.
  - **유입경로 일 합계는 조회수보다 작다.** 30일 모두 `referrer_daily` 합 ≤ `VIEWS.total`이고(71~91%, 평균 84%), 방문횟수(`VISITS`)와도 다르다. 네이버 유입분석이 출처를 확인한 방문만 세는 별도 정의로 보인다(수집 오류가 아님). 대시보드 상단 카드를 "유입경로 합계"로 부르는 이유다.
- 검색어: `GET /api/blog/daily/referer/total/detail?timeDimension=DATE&additionalTimeDimension=WEEK&startDate=YYYY-MM-DD&searchEngine=1&refererDomain=<유입처 이름, 공백은 %20>&size=100&exclude=`
  - 검색 유입처(`referrerSearchEngine=1`)마다 한 번씩 호출한다. 응답 `refererDetail`의 `searchQuery`, `cv`(그 유입처 안의 방문수), `cv_p`.
  - 과거 날짜도 조회된다. `size`는 화면이 20을 쓰고 우리는 100을 쓴다(100도 정상 응답). 검색어 합계가 유입처 방문수와 다르면 일부만 온 것이라 경고를 출력한다.
  - 한 유입처의 검색어 수집이 실패해도 그 날의 나머지는 저장한다(세션 만료는 그대로 중단).

## 저장
- 테이블 `referrer_daily`, 유니크 `(stat_date, referrer_name)`. H2 파일 DB(`./data/blogstat`).
- 테이블 `search_query_daily`, 유니크 `(stat_date, referrer_name, search_query)`. 같은 (유입처, 검색어)가 한 날짜에 두 번 오면 합쳐서 저장한다.
- 테이블 `metric_row`, 유니크 `(stat_date, metric, row_key)`. 나머지 지표 전부가 이 표 하나에 들어가고, 응답 컬럼은 `payload` JSON 한 덩어리다(지표마다 컬럼이 달라 표를 늘리지 않는다). 시계열은 `row_key=all`, 하루 단위는 연령 코드·시간·국가·순위 번호(`r001`…)·이웃 구분이다. 데이터가 없는 날은 `_empty` 행을 남겨 다시 요청하지 않는다. `MetricService.replace`는 그 지표의 해당 날짜만(게시글별은 그 게시글 행만) 지우고 다시 넣는다(멱등). 월간 비교·게시글 정보는 조회 기간 밖에 날짜가 있을 수 있어 `/api/dashboard/metrics`가 기간과 상관없이 최신값을 함께 보낸다(`MetricQueryService.LATEST_ONLY`). 조회 API는 `GET /api/dashboard/metrics?from&to`.
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
