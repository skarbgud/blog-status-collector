@echo off
chcp 65001 >nul
rem 위 chcp는 한글 주석보다 먼저 와야 한다(CP949로 읽으면 한글 주석이 다음 줄을 삼켜 실행이 깨진다).
rem 네이버 로그인(수동). 쿠키 만료 경고가 뜨거나 수집이 401로 실패하면 실행한다.
rem 열린 브라우저에서 직접 로그인하고, 반드시 "로그인 상태 유지"를 체크한다.
rem 이 파일/스크립트는 ID와 비밀번호를 다루지 않는다.
cd /d "%~dp0.."
set "JAVA_TOOL_OPTIONS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8"
call gradlew.bat bootRun --args="--app.mode=login"
