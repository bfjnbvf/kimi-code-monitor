@echo off
rem Kimi Code Monitor panel installer entry (Windows).
rem This file is a thin launcher: it only locates a usable Node runtime and runs
rem install.mjs (the single cross-platform installer). No install logic here.
rem
rem Runtime priority:
rem   1) The Kimi Code client's built-in Node (ELECTRON_RUN_AS_NODE; stable
rem      version shipped with the client, independent of the user's PATH)
rem   2) System node (developer machines)
rem   3) Neither -> guidance and exit (the client is a prerequisite anyway)
rem
rem KCM_RUNTIME_EXE overrides the runtime executable (test injection / advanced).
rem
rem NOTE FOR MAINTAINERS: keep this file ASCII-only with CRLF line endings.
rem cmd parses batch files with the OEM code page (e.g. 936 on zh-CN systems);
rem non-ASCII bytes get mis-split there and turn comments into garbage commands.
rem The user-facing Chinese wording lives in install.mjs (Node prints Unicode
rem correctly on Windows terminals regardless of the code page).
rem
rem Usage:
rem   install.cmd                 install / update the panel (idempotent)
rem   install.cmd --uninstall     full uninstall (restore original index.html)
rem   install.cmd --app "D:\kimi_code\Kimi Code"   client in a custom location
setlocal
set "SCRIPT_DIR=%~dp0"
set "INSTALLER=%SCRIPT_DIR%install.mjs"
if not exist "%INSTALLER%" (
  echo install.mjs missing: please extract the full patch package
  exit /b 1
)

set "RUNTIME=%KCM_RUNTIME_EXE%"
if "%RUNTIME%"=="" for %%D in (
  "%LOCALAPPDATA%\Programs\Kimi Code"
  "%ProgramFiles%\Kimi Code"
  "D:\kimi_code\Kimi Code"
) do (
  if exist "%%~D\Kimi Code.exe" set "RUNTIME=%%~D\Kimi Code.exe"
)

rem Borrow the client's Node: ELECTRON_RUN_AS_NODE is Electron's official switch
rem (no GUI, pure Node). If the client ever ships with that switch disabled, this
rem would start the client UI instead -- then install Node and run install.mjs.
if not "%RUNTIME%"=="" if exist "%RUNTIME%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%RUNTIME%" "%INSTALLER%" %*
  goto :done
)

where node >nul 2>nul
if %errorlevel%==0 (
  node "%INSTALLER%" %*
  goto :done
)

echo Kimi Code client not found and no Node available. Install the client first.
exit /b 1

:done
endlocal
