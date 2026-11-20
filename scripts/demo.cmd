@echo off
rem 시연용 대시보드: 가짜 데이터로 http://127.0.0.1:8080 을 띄운다.
rem 실제 DB, 로그인 쿠키, 네이버를 건드리지 않는다. 수집기(scheduler.cmd)가 켜져 있어도 된다.
rem 단, 같은 8080 포트를 쓰는 dashboard.cmd와는 동시에 켤 수 없다. 포트를 바꾸려면: scripts\demo.cmd 8090
chcp 65001 >nul
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"
call gradlew.bat bootRun --args="--spring.profiles.active=demo --server.port=%PORT%"
