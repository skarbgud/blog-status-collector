@echo off
chcp 65001 >nul
rem 위 chcp는 한글 주석보다 먼저 와야 한다(CP949로 읽으면 한글 주석이 다음 줄을 삼켜 실행이 깨진다).
rem 매일 03:10(KST)에 어제까지 빠진 날짜를 자동 수집한다(상주). 시작 직후에도 한 번 보충한다.
rem 이 창을 켜 두어야 돈다. 대시보드는 scripts\dashboard.cmd로 따로 켠다(동시에 켜도 된다).
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
call gradlew.bat bootRun --args="--app.mode=schedule"
