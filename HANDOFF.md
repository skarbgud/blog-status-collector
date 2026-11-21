# 인수인계: 블로그 통계 수집기 (2026-11-21 기준)

다른 AI 세션이 이어서 작업할 수 있게 지금까지의 상태·결정·미확인 사항을 정리한다.
세부 규칙은 `CLAUDE.md`(저장소 규칙·원칙), `extension/README.md`(크롬 확장 설계)에 있다. **작업 전에 둘 다 먼저 읽는다.**

## 1. 프로젝트 한눈에
- 네이버 블로그 통계(본인 계정)를 수집해 대시보드로 보는 도구.
- v1: Java/Spring Boot + Playwright + H2 (저장소 루트, `src/`). 지금은 레거시.
- **v2(현행): 크롬 확장** (`extension/`). 수집·저장(SQLite WASM/OPFS)·대시보드 모두 브라우저 안. TypeScript, 빌드 `npm run build` → `extension/dist`(크롬에 "압축해제된 확장"으로 로드).
- 공유 링크 보기 페이지 + 짧은 링크 API: **Netlify** (`https://blog-status-collector.netlify.app/`), 설정은 루트 `netlify.toml`.

## 2. 저장소·브랜치·작업 폴더
- 원격: GitHub `skarbgud/blog-status-collector` (private, 공개 준비 중: MIT 라이선스, 실제 통계 수치 제거 원칙).
- **main이 기준 브랜치**이고 Netlify가 main을 배포한다. 2026-11-21 마지막 커밋 `4a1fb27`.
- 로컬 worktree(같은 저장소, 여러 Claude 세션이 동시에 씀):
  | 폴더 | 브랜치 | 용도 |
  |---|---|---|
  | `C:\Users\USER00\claude-code\musinsa-practice` | `main` | 다른 세션이 UI 작업에 쓰기도 함 |
  | `...\musinsa-practice-v2` | `feature/google-chrome-extension` | **사용자가 크롬에 로드한 확장의 빌드 폴더(`extension/dist`)**. 폴더를 바꾸면 확장 ID가 바뀌어 데이터(OPFS)가 안 보이므로 이 폴더를 유지 |
  | `...\musinsa-practice-share` | `feature/share-link` | 공유 링크 기능 작업용 |
  | `...\musinsa-practice-v3` | `feature/manual-refetch` | 오래된 브랜치(이미 합쳐짐) |
- 지금 세 브랜치(main, feature/google-chrome-extension, feature/share-link)는 모두 `4a1fb27`로 같다.
- 반영 절차(지금까지 써 온 방식): 작업 브랜치에서 커밋 → `git fetch` → origin/main이 앞서 있으면 merge → 테스트 → `git push origin HEAD:main` → v2 폴더가 깨끗하면(`git status` 비었고 main보다 앞선 커밋 없음) `git merge --ff-only origin/main` + push + `npm run build`.

## 3. 반드시 지킬 규칙 (CLAUDE.md 요약)
- 여러 세션 동시 작업: `git add`는 파일 하나씩, 내가 만들지 않은 미커밋 파일은 커밋하지 않는다, 내가 띄우지 않은 프로세스는 종료하지 않는다, 강제 푸시 금지.
- 윈도우 `core.autocrlf=true`: 작업 폴더 파일은 CRLF. 스크립트로 문자열 치환할 때 줄바꿈을 맞춘다(Python은 `newline=''`로 읽고 쓰기).
- 개인 데이터(`data/`, `explore-output/`, `.playwright-profile/`, 로그)는 커밋·출력 금지. 공개 저장소 준비로 **실제 통계 절대 수치·게시글 번호를 문서·코드에 쓰지 않는다**(비율만).
- 네이버 요청은 본인 계정·저빈도. 로그인은 사람이 직접(자동 입력·캡차 우회 금지).
- **비용 원칙**(CLAUDE.md): "서버 없음"의 목적은 과금이 생기지 않게 하는 것. 무료 요금제 안에서 끝나고 초과 시 *멈추는* 서비스만 허용(Netlify Free는 초과 시 일시 정지, 과금 없음 확인됨). 데이터를 브라우저 밖에 둘 때는 서비스가 읽을 수 없게 브라우저에서 암호화, 키는 링크 `#` 뒤.
- 사용자 선호: 기능 하나 끝나면 커밋+push(메모리 규칙), 답변은 한국어.

## 4. 이번 세션(2026-11-21)에 한 일

### 4.1 유입분석: 검색 아닌 유입처의 상세 URL 수집
- 네이버 `GET /api/blog/daily/referer/total/detail`에 `searchEngine=0`을 보내면 블록 `refererDetail`의 컬럼 `referrerUrl`, `cv`, `cv_p`(유입처 안 비율)로 URL 전문이 온다(과거 날짜 가능, 상세 합 = 유입처 방문수 확인).
- 코드: `extension/src/core/referer.ts`(`parseUrls`, `fetchRefererUrls`), `collector.ts`(새 날짜는 함께 받고, 유입경로만 있는 날짜는 `urlDates`로 URL만 보충), 표 `referrer_url_daily`, 수집 상태 단위 `REFERER_URL`.
- 한 유입처라도 실패하면 그 날은 받은 날로 남기지 않아 다음 회차에 다시 받는다. URL은 로그에 남기지 않는다.

### 4.2 대시보드 공유 링크 (여러 번 바뀜, 최종 형태만 유효)
1. 처음: 데이터를 링크 `#s=`에 통째로 압축(로컬 전용). → **카카오톡이 긴 링크(수만 자)를 잘라 휴대폰에서 열리지 않음.**
2. 최종: **브라우저에서 AES-256-GCM 암호화 → 암호문만 Netlify Blobs에 저장 → 짧은 링크 `https://…netlify.app/#k=<번호16>.<키43>`(약 85자).** 키는 `#` 뒤라 서버로 가지 않는다. `#s=` 링크도 계속 열림.
3. 처음엔 쓰기 토큰(`SHARE_WRITE_TOKEN`)을 요구했으나 일반 사용자가 쓸 수 없어 **인증 없이 누구나**로 바꾸고 남용 방지를 넣었다(사용자 결정, 숫자도 사용자 확정):
   - 업로드 IP당 3분 5회(함수 `rateLimit`), 하루 전체 500건(Blobs 카운터), 공유 하나 1MB, 보관 최대 90일(처음 30일 → 90일로 늘림), 긴급 정지 `SHARE_UPLOADS=off`, 상한 조정 `SHARE_DAILY_CAP`.
   - 열람·삭제는 IP당 1분 60회. 업로드를 Content-Type 없이 보내 preflight(OPTIONS)가 생기지 않게 함(5회 한도를 실제 업로드에만 쓰려고).
- 파일
  - 만들기(확장): `extension/src/dashboard-share.ts` — 화면 응답(`/api/dashboard/*`)을 fetch를 감싸 기록 → 지금 기간 응답만 모아 봉인·업로드. 사이드바 "공유" 블록(버튼, "내 공유" 목록: 다시 복사·삭제, 설정: 보기 페이지 주소). `dashboard.html`에 스크립트 한 줄.
  - 형식: `extension/src/core/share-codec.ts` — 지표 응답 열 형식화·미사용 지표 제외·소수 3자리 → deflate-raw → AES-GCM(`[버전1][IV12][암호문]`), `sealShare/openShare/shortLink/refFromHash`.
  - 서버 처리기(순수, 테스트 있음): `extension/src/core/share-api.ts`.
  - Netlify 함수: `extension/netlify/functions/share-upload.mts`(POST `/api/share`), `share.mts`(GET·DELETE `/api/share/*`), `share-sweep.mts`(매일 만료 정리). Blobs 연결: `extension/netlify/lib/blob-store.mts`(스토어 `blog-shares`, `blog-share-counters`).
  - 보기 페이지: `extension/src/share-viewer.ts`(dashboard-api.js 자리를 대신해 공유 데이터로 답함, 링크 없거나 잘림·만료면 안내 화면), 빌드 `extension/scripts/build-viewer.mjs` → `extension/viewer-dist/`.
  - 로컬 확인: `npm test && npm run build:viewer && node tools/serve-viewer.mjs` → `http://localhost:8787/`(netlify.toml과 같은 CSP, `/api/share`는 같은 처리기를 메모리 저장소로).
- 보안 헤더(netlify.toml): CSP `connect-src 'self'`, `Referrer-Policy: no-referrer`, `noindex`.

### 4.3 기타
- `extension/static/dashboard-hours.js`: 지표가 모듈보다 먼저 그려졌을 때 `const values` 초기화 전 접근(ReferenceError) 수정(`queueMicrotask`).
- 수집 범위 `RANGE_DAYS` 30 → **90일**(`extension/src/core/collector.ts`). 다음 회차에 빠진 60일을 한 번 채움(요청 약 3배, 어림 2,000회). 대시보드 기본 보기는 30일 그대로(사이드바 "90일" 버튼).
- 테스트: `cd extension && npm test` → **140건 통과**(2026-11-21).

## 5. 확인하지 못한 것 / 다음 할 일 (우선순위 순)
1. **Netlify 함수 배포 확인**: 함수가 들어간 배포를 로컬에서 esbuild로 묶어 보지 못했다(권한 거부). 배포 로그에 Functions `share`, `share-upload`, `share-sweep`가 있는지, 실제로 공유 만들기 → 휴대폰 카톡으로 열기가 되는지 확인. `.ts` 확장자 import(`../../src/core/share-api.ts`)가 Netlify 번들러에서 문제면 경로/확장자를 조정.
2. **IP당 rateLimit**은 배포 환경에서만 동작해 로컬 미확인.
3. **네이버가 90일 전 데이터를 주는지 미확인**(지금까지 30일 전까지만 받아 봄). 확장 팝업의 실패 건수로 확인. 거부되면 그 날짜가 매일 재시도되므로 범위를 줄이거나 실패 날짜 처리 규칙을 추가.
4. Netlify에 예전에 넣었을 수 있는 `SHARE_WRITE_TOKEN` 환경변수는 더 이상 쓰지 않음(지워도 됨).
5. 사용자가 요청했으나 처리 못 한 것: **`/usage`가 지적한 항목 수정** — 보고서 내용이 대화에 전달되지 않아 미처리(사용자에게 붙여 달라고 요청함). 서브에이전트 점검 결과: 사용자 정의 에이전트·플러그인 없음. 실제 쓰인 것은 기본 제공 `web-fetch`(웹 읽기, Haiku로 충분)와 `general-purpose`(코드 리뷰, Opus 유지 권장). 제안만 하고 설정 변경은 안 함(`CLAUDE_CODE_SUBAGENT_MODEL` 또는 호출 시 `model` 지정).
6. 다른 세션이 디자인 토큰/새 UI(`feature/toss-ui`, `tokens.css`, `dashboard-ui.css`)를 main에 합쳐 두었다. 공유 블록은 기존 `.controls`, `.note` 클래스를 쓰므로 새 UI 기준 스타일 정리가 필요할 수 있다.
7. 기능 우선순위 메모(사용자 결정): 상세 유입경로 펼쳐 보기(완료) → 글 성과 분석(B) → 독자가 오는 시간(D, 일부 구현) → 목표 추적(F) → 주간·월간 리포트(E). 설계: `~/.claude/plans/extension-analysis-features.md`.

## 6. 자주 쓰는 명령
```bash
cd extension
npm ci                 # 의존성(@netlify/blobs 11.1.7 고정 포함)
npm test               # tsc 컴파일 후 node --test (140건)
npm run build          # 확장 dist
npm run build:viewer   # 확장 dist + 보기 페이지 viewer-dist
node tools/serve-viewer.mjs          # 로컬 보기 페이지 + /api/share(메모리)
node tools/share-size.mjs <export.json>   # 공유 데이터 크기 재기(개인 데이터, 결과 커밋 금지)
```
