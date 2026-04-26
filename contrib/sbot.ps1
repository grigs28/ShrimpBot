# ShrimpBot Windows 启动脚本
# 放到 PATH 目录（如 $HOME\.local\bin）即可全局使用 sbot 命令
#
# 安装：
#   1. 复制此文件到 $HOME\.local\bin\sbot.ps1
#   2. 将 $HOME\.local\bin 加入 PATH（见下方命令）
#   3. 重启终端
#
# 添加 PATH:
#   [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$HOME\.local\bin", 'User')

param([Parameter(ValueFromRemainingArgs)]$ScriptArgs = @())

# 自动定位 ShrimpBot 目录
$SBotHome = $env:SHRIMPBOT_HOME
if (-not $SBotHome) {
    # 按优先级查找：当前目录 > $HOME\ShrimpBot > 脚本所在目录的上级
    if (Test-Path "$PWD\package.json") {
        $SBotHome = $PWD.Path
    } elseif (Test-Path "$env:USERPROFILE\ShrimpBot\package.json") {
        $SBotHome = "$env:USERPROFILE\ShrimpBot"
    } elseif (Test-Path "$PSScriptRoot\..\package.json") {
        $SBotHome = (Resolve-Path "$PSScriptRoot\..").Path
    } else {
        Write-Host "错误：找不到 ShrimpBot 目录。设置 `$env:SHRIMPBOT_HOME 或 cd 到项目目录" -ForegroundColor Red
        exit 1
    }
}

# 从 .sbot 加载项目配置（如果在项目目录下）
$sbotFile = Join-Path $PWD ".sbot"
if (Test-Path $sbotFile) {
    Get-Content $sbotFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $parts = $line -split '=', 2
            $key = $parts[0].Trim()
            $val = $parts[1].Trim()
            if (-not [Environment]::GetEnvironmentVariable($key)) {
                [Environment]::SetEnvironmentVariable($key, $val, 'Process')
            }
        }
    }
}

# 启动
Push-Location $SBotHome
node dist/index.js @ScriptArgs
Pop-Location
