@echo off
rem 네이버 로그인(수동). 쿠키 만료 경고가 뜨거나 수집이 401로 실패하면 실행한다.
rem 열린 브라우저에서 직접 로그인하고, 반드시 "로그인 상태 유지"를 체크한다.
rem 이 파일/스크립트는 ID와 비밀번호를 다루지 않는다.
chcp 65001 >nul
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
call gradlew.bat bootRun --args="--app.mode=login"
