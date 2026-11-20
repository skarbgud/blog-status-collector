@echo off
rem 대시보드(읽기 전용)를 켠다: http://127.0.0.1:8080
rem 수집(collect-queries, scheduler)과 동시에 켜도 된다. 수집이 끝나면 새로고침만 하면 반영된다.
chcp 65001 >nul
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
call gradlew.bat bootRun --args="--spring.profiles.active=dashboard"
