# blog-stat-collector

네이버 블로그 유입경로 통계(https://blog.stat.naver.com/m/blog/daily/referer)를 Playwright로 수집해 H2에 저장한다.

## 스택
- Java 17, Spring Boot 3.5, Gradle, Spring Data JPA, H2(파일 모드), Playwright for Java

## 명령
- 탐색(XHR 로깅): `gradle bootRun --args="--app.mode=explore"`
- 테스트: `gradle test`

## 규칙
- 로그인은 사람이 브라우저에서 수동으로만 한다. ID/PW 자동 입력, 캡차 우회 금지.
- `.playwright-profile/`은 로그인 쿠키가 들어 있다. 커밋, 출력, 공유 금지.
- 수집은 본인 계정 통계만, 저빈도(하루 1회, 날짜 사이 2~5초 지연).
- `explore-output/`와 `data/`는 개인 통계 데이터라 gitignore 대상이다.
