@echo off
rem 매일 03:10(KST)에 어제까지 빠진 날짜를 자동 수집한다(상주). 시작 직후에도 한 번 보충한다.
rem 이 창을 켜 두어야 돈다. 대시보드는 scripts\dashboard.cmd로 따로 켠다(동시에 켜도 된다).
chcp 65001 >nul
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
call gradlew.bat bootRun --args="--app.mode=schedule"
