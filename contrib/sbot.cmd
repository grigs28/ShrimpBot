@echo off
REM ShrimpBot Windows CMD 启动脚本
REM 复制到 PATH 目录（如 %USERPROFILE%\.local\bin\sbot.cmd）

if defined SHRIMPBOT_HOME (
    set "SBOT_DIR=%SHRIMPBOT_HOME%"
) else if exist "%USERPROFILE%\ShrimpBot\package.json" (
    set "SBOT_DIR=%USERPROFILE%\ShrimpBot"
) else if exist "%CD%\package.json" (
    set "SBOT_DIR=%CD%"
) else (
    echo 错误：找不到 ShrimpBot 目录。设置 SHRIMPBOT_HOME 环境变量或 cd 到项目目录
    exit /b 1
)

REM 加载 .sbot 配置
if exist ".sbot" (
    for /f "usebackq tokens=1,* delims==" %%a in (".sbot") do (
        if not "%%a"=="" if not "%%a:~0,1%"=="#" (
            if not defined %%a (
                set "%%a=%%b"
            )
        )
    )
)

pushd "%SBOT_DIR%"
node dist\index.js %*
popd
