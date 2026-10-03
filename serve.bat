@echo off
rem iPad などほかの端末から遊べるように、このフォルダを LAN へ HTTP 配信する(中身は tools\serve.py)。
rem 表示された http://(この PC のアドレス):8770/ を iPad の Safari で開く。止めるときは Ctrl+C。
rem ポートを変えるときは serve.bat 8780 のように渡す。
setlocal
cd /d "%~dp0"

set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo Python が見つかりません。python.org から入れるか、PATH を通してください。
  pause
  exit /b 1
)

%PY% "tools\serve.py" %*
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
