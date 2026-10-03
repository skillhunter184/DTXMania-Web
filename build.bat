@echo off
rem dist\dojo.bundle.js を作り直す。
rem index.html を file:// で直接開くときはこのファイルが必要(HTTP 配信なら js\ をそのまま読むので不要)。
rem js\ 以下を変更したら実行すること。-q を付けると最後に止まらない。
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Python が見つかりません。python.org から入れるか、PATH を通してください。
  if /i not "%~1"=="-q" pause
  exit /b 1
)

%PY% "tools\build.py"
if errorlevel 1 (
  echo.
  echo ビルドに失敗しました。
  if /i not "%~1"=="-q" pause
  exit /b 1
)

if /i not "%~1"=="-q" pause
exit /b 0
