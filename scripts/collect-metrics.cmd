@echo off
chcp 65001 >nul
rem 위 chcp는 한글 주석보다 먼저 와야 한다(CP949로 읽으면 한글 주석이 다음 줄을 삼켜 실행이 깨진다).
rem 유입경로·검색어 말고 나머지 통계 지표(조회수, 방문자, 시간대, 성별·연령, 순위, 게시글별 조회수 등)를 모두 받는다.
rem 직접 실행하면 되고 Claude를 거치지 않아도 된다.
rem
rem   scripts\collect-metrics.cmd              최근 30일(어제까지), 이미 받은 날짜는 건너뜀
rem   scripts\collect-metrics.cmd 60           최근 60일
rem   scripts\collect-metrics.cmd 30 --force   이미 받은 날짜도 다시 받음
rem
rem 처음 30일치는 요청이 440회 안팎이라 25분쯤 걸린다(요청 사이 2~5초). 이후 매일은 100회 안팎이다. 한 회차 상한에서 멈추면 다시 실행하면 이어서 받는다.
rem 네이버가 어제분을 늦게 집계하는 지표(순방문자, 시간대)는 비어 있다가 다음 실행에서 채워진다.
rem 대시보드가 켜져 있어도 된다(읽기/쓰기 분리). 끝나면 대시보드를 새로고침하면 반영된다.
rem 로그인 쿠키가 만료됐다면 scripts\login.cmd를 먼저 실행한다.
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
set "DAYS=%~1"
if "%DAYS%"=="" set "DAYS=30"
call gradlew.bat bootRun --args="--app.mode=collect-metrics --days=%DAYS% %~2"
