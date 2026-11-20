@echo off
chcp 65001 >nul
rem 위 chcp는 한글 주석보다 먼저 와야 한다(CP949로 읽으면 한글 주석이 다음 줄을 삼켜 실행이 깨진다).
rem 대시보드(읽기 전용)를 켠다: http://127.0.0.1:8080
rem 수집(collect-queries, scheduler)과 동시에 켜도 된다. 수집이 끝나면 새로고침만 하면 반영된다.
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
call gradlew.bat bootRun --args="--spring.profiles.active=dashboard"
