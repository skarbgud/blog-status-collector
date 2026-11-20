@echo off
chcp 65001 >nul
rem 위 chcp는 한글 주석보다 먼저 와야 한다(CP949로 읽으면 한글 주석이 다음 줄을 삼켜 실행이 깨진다).
rem 검색어만 따로, 길게 거슬러 올라가며 수집한다. 직접 실행하면 되고 Claude를 거치지 않아도 된다.
rem
rem   scripts\collect-queries.cmd           최근 30일(어제까지), 이미 있는 날짜는 건너뜀
rem   scripts\collect-queries.cmd 60        최근 60일
rem   scripts\collect-queries.cmd 30 --force   이미 있는 날짜도 다시 받음
rem
rem 대시보드가 켜져 있어도 된다(읽기/쓰기 분리). 끝나면 대시보드를 새로고침하면 반영된다.
rem 로그인 쿠키가 만료됐다면 scripts\login.cmd를 먼저 실행한다.
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
set "DAYS=%~1"
if "%DAYS%"=="" set "DAYS=30"
call gradlew.bat bootRun --args="--app.mode=collect-queries --days=%DAYS% %~2"
