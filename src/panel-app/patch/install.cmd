@echo off
rem Kimi Code Monitor 面板补丁 · 安装入口（Windows）
rem
rem 本文件只是「点火器」：找到可用的 Node 运行时，把同一份安装器 install.mjs
rem 跑起来。安装逻辑全部在 install.mjs（跨平台唯一一份）。
rem 运行时优先级：Kimi Code 客户端自带的 Node（ELECTRON_RUN_AS_NODE，版本恒定、
rem 不依赖 PATH）> 系统 node > 提示退出。KCM_RUNTIME_EXE 可显式指定运行时。
rem
rem 用法（cmd 或资源管理器双击）：
rem   install.cmd                 安装/更新补丁（幂等）
rem   install.cmd --uninstall     完整卸载
rem   install.cmd --app "D:\kimi_code\Kimi Code"   指定客户端位置
setlocal
set "SCRIPT_DIR=%~dp0"
set "INSTALLER=%SCRIPT_DIR%install.mjs"
if not exist "%INSTALLER%" (
  echo 缺 install.mjs：请确认解压了完整补丁包
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

rem 借客户端的 Node：ELECTRON_RUN_AS_NODE 是 Electron 的官方开关，让它不启动
rem 界面、纯当 Node 跑。若客户端将来禁用了该开关，这里会误启动客户端界面——
rem 届时请装 Node 后手动运行 install.mjs（见 docs/DESKTOP-PATCH.md）。
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

echo 未找到 Kimi Code 客户端，也没有 Node。请先安装 Kimi Code 客户端后重试。
exit /b 1

:done
endlocal
