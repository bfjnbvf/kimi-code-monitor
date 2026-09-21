@echo off
rem Unified launcher for the skill scripts (Windows).
rem
rem Same principle as install.cmd: the runtime-selection logic lives only here.
rem All skill scripts (doctor.mjs / refresh-stats.mjs / client-providers.mjs ...)
rem are started through this launcher so they work without a system Node
rem (it borrows the Kimi Code client's built-in Node).
rem
rem Runtime priority: the client's built-in Node (ELECTRON_RUN_AS_NODE) >
rem system node > guidance and exit. KCM_RUNTIME_EXE overrides the runtime.
rem
rem NOTE FOR MAINTAINERS: keep this file ASCII-only with CRLF line endings
rem (cmd parses batch files with the OEM code page).
rem
rem Usage: run.cmd <script name or path> [args...]
rem   run.cmd doctor.mjs
setlocal
set "SCRIPT_DIR=%~dp0"

if "%~1"=="" (
  echo usage: run.cmd ^<script name or path^> [args...]
  exit /b 1
)

set "TARGET=%~f1"
if not exist "%TARGET%" (
  echo script not found: %TARGET%
  exit /b 1
)
shift

set "RUNTIME=%KCM_RUNTIME_EXE%"
if "%RUNTIME%"=="" for %%D in (
  "%LOCALAPPDATA%\Programs\Kimi Code"
  "%ProgramFiles%\Kimi Code"
  "D:\kimi_code\Kimi Code"
) do (
  if exist "%%~D\Kimi Code.exe" set "RUNTIME=%%~D\Kimi Code.exe"
)

if not "%RUNTIME%"=="" if exist "%RUNTIME%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%RUNTIME%" "%TARGET%" %*
  goto :done
)

where node >nul 2>nul
if %errorlevel%==0 (
  node "%TARGET%" %*
  goto :done
)

echo Kimi Code client not found and no Node available. Install the client first.
exit /b 1

:done
endlocal
