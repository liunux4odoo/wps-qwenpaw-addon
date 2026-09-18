<#
.SYNOPSIS
    WPS-QwenPaw 加载项 Windows 一键安装/配置脚本（PowerShell 版，Windows 10/11，PowerShell 5.1+）

.DESCRIPTION
    等价 Linux 版 scripts/install.sh 的 Windows 实现。完成：
      1. 环境自检（git / node / npm / python / qwenpaw / WPS）
      2. submodule 初始化（third_party/opencode-wps）
      3. 构建 wps-office-mcp（npm install + npm run build）
      4. 同步加载项文件到 WPS jsaddons 目录（%APPDATA%\kingsoft\wps\jsaddons\）
      5. 注册加载项（publish.xml / jsplugins.xml / authaddin.json 启用）
      6. 启动 acp-bridge 并自检

    与 Linux 版差异（Windows 无需做）：
      - 不打 POLL_PORT 补丁：Windows 走 PowerShell COM 通道（wps-client.ts win32 分支），
        不使用 :58891 反向轮询，WPS_POLL_PORT 环境变量被忽略（无害）。
      - 不部署 noop 脚本：wps-auto.sh 是 Linux/macOS 的跨应用切换脚本，Windows 无此机制。

.PARAMETER SkipBridge
    只安装文件，不启动 bridge（等价 install.sh --skip-bridge）

.PARAMETER BridgeOnly
    只启动 bridge（等价 install.sh --bridge-only）

.PARAMETER Python
    bridge 使用的 Python 解释器（默认 python；建议 Python 3.12，需 >= 3.10）

.PARAMETER AcpServer
    ACP server：qwenpaw（默认）| opencode

.EXAMPLE
    .\scripts\install.ps1
    .\scripts\install.ps1 -SkipBridge
    .\scripts\install.ps1 -BridgeOnly
#>
[CmdletBinding()]
param(
    [switch]$SkipBridge,
    [switch]$BridgeOnly,
    [string]$Python = 'python',
    [string]$AcpServer = 'qwenpaw',
    [int]$BridgeHttpPort = 8766,
    [int]$BridgeWsPort = 8765,
    [string]$BridgeAgent = 'default'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WpsMcpDir = Join-Path $RepoRoot 'third_party\opencode-wps\wps-office-mcp'
if (-not $env:APPDATA) { Write-Host "FAIL APPDATA 环境变量为空（无法定位 WPS jsaddons 目录）" -ForegroundColor Red; exit 1 }
$WpsJsaddons = Join-Path $env:APPDATA 'kingsoft\wps\jsaddons'
$AddonDir = Join-Path $WpsJsaddons 'wps-qwenpaw-addon_'
$AddonName = 'wps-qwenpaw-addon'

function Say([string]$msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "  FAIL $msg" -ForegroundColor Red; exit 1 }

function Write-Utf8NoBom([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-Cmd([string]$name, [string]$hint) {
    if (Get-Command $name -ErrorAction SilentlyContinue) {
        Ok "${name}: $((Get-Command $name | Select-Object -First 1).Source)"
        return $true
    }
    Fail "缺少命令: $name（$hint）"
}

function Test-PortOpen([int]$port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $port)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

function Invoke-Npm([string]$dir, [string]$command, [string]$desc) {
    Say $desc
    Push-Location $dir
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue' # PS 5.1：原生 stderr 经 2>&1 重定向会被 Stop 提升为终止错误，npm 常写 stderr 警告
    try {
        & npm.cmd $command.Split(' ') 2>&1 | Out-Host
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
        Pop-Location
    }
    if ($code -ne 0) { Fail "$desc 失败（退出码 $code）" }
}

function Update-JspluginsXml {
    # publish.xml / jsplugins.xml 注册（与 Linux 安装产物同格式）
    $entryPublish = '<jsplugin enable="enable_dev" name="' + $AddonName + '" url="' + $AddonName + '_" type="wps,et,wpp"/>'
    $entryJsplugin = '<jsplugin type="wps,et,wpp" enable="true" name="' + $AddonName + '" url="' + $AddonName + '_"/>'

    foreach ($file in @('publish.xml', 'jsplugins.xml')) {
        $path = Join-Path $WpsJsaddons $file
        $entry = if ($file -eq 'publish.xml') { $entryPublish } else { $entryJsplugin }
        $content = ''
        if (Test-Path $path) {
            $content = Get-Content $path -Raw -Encoding UTF8
            if ($content -match ('name="' + $AddonName + '"')) {
                $content = [regex]::Replace(
                    $content,
                    '<jsplugin[^>]*name="' + $AddonName + '"[^>]*/>',
                    $entry
                )
            } else {
                $content = $content -replace '</jsplugins>', "    $entry`n</jsplugins>"
            }
        } else {
            $content = '<?xml version="1.0" encoding="UTF-8"?>' + "`n" +
                       '<jsplugins>' + "`n    $entry`n" + '</jsplugins>' + "`n"
        }
        Write-Utf8NoBom $path $content
        Ok "已更新 $file"
    }
}

function Update-AuthaddinJson {
    # authaddin.json 是真正的启用开关：把 name 匹配我们的条目 enable 置 true。
    # 若条目不存在（首次安装），WPS 首次加载插件时会自动生成，此处仅提示。
    $path = Join-Path $WpsJsaddons 'authaddin.json'
    if (-not (Test-Path $path)) {
        Warn "未找到 authaddin.json（WPS 首次加载插件后自动生成）。若插件未启用，请到 WPS 加载项管理里手动启用。"
        return
    }
    try {
        $data = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $changed = $false
        $found = $false
        foreach ($app in @('wps', 'et', 'wpp')) {
            if (-not $data.$app) { continue }
            foreach ($prop in $data.$app.PSObject.Properties) {
                if ($prop.Name -eq 'namelist') { continue }
                if ($prop.Value.name -eq $AddonName) {
                    $found = $true
                    if (-not $prop.Value.enable) {
                        $prop.Value.enable = $true
                        $changed = $true
                        Ok "已启用 $app 加载项"
                    }
                }
            }
        }
        if ($changed) {
            $json = $data | ConvertTo-Json -Depth 8
            Write-Utf8NoBom $path $json
            Ok '已更新 authaddin.json'
        } elseif ($found) {
            Ok 'authaddin.json 中已全部启用'
        } else {
            Warn "authaddin.json 中暂无 $AddonName 条目（WPS 首次加载插件后自动生成）。若插件未启用，请到 WPS 加载项管理里手动启用。"
        }
    } catch {
        Warn "更新 authaddin.json 失败: $($_.Exception.Message)"
    }
}

# ── 参数校验 ──────────────────────────────────────────────
if ($SkipBridge -and $BridgeOnly) {
    Fail '-SkipBridge 与 -BridgeOnly 不能同时使用'
}
if ($AcpServer -notin @('qwenpaw', 'opencode')) {
    Fail "未知 -AcpServer: $AcpServer（仅支持 qwenpaw|opencode）"
}
if ($BridgeAgent -match '[\s"]') {
    Fail "-BridgeAgent 含空白或引号，非法: $BridgeAgent"
}

# ── 1. 环境自检 ───────────────────────────────────────────
if (-not $BridgeOnly) {
    Say '== 环境自检 =='
    Test-Cmd 'git' 'git（https://git-scm.com/download/win）'
    Test-Cmd 'node' 'Node.js >= 18（https://nodejs.org）'
    Test-Cmd 'npm.cmd' 'npm（随 Node.js 安装）'
    Test-Cmd $Python 'Python 3.10+（建议 3.12，https://www.python.org）'

    & $Python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0) {
        $pyVer = (& $Python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null)
        Ok "Python 版本: $pyVer"
        $parts = $pyVer.Split('.')
        if ([int]$parts[0] -lt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -lt 10)) {
            Fail "Python 版本过低（$pyVer），bridge 需要 >= 3.10（建议 3.12）"
        }
    } else {
        Warn "无法运行 $Python 获取版本（bridge 需要 Python 3.10+）"
    }

    # websockets 依赖
    & $Python -c "import websockets" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Ok 'websockets: 已安装'
    } else {
        Say '安装 websockets 依赖 ...'
        & $Python -m pip install websockets
        if ($LASTEXITCODE -ne 0) { Fail 'pip install websockets 失败' }
        Ok 'websockets: 已安装'
    }

    if (Get-Command 'qwenpaw' -ErrorAction SilentlyContinue) {
        Ok "qwenpaw: $((Get-Command qwenpaw | Select-Object -First 1).Source)"
    } else {
        Warn "PATH 中未找到 qwenpaw（若装在 conda 环境请先激活；或改用 -AcpServer opencode）"
    }
}

# ── 2. submodule 初始化 ───────────────────────────────────
if (-not $BridgeOnly) {
    Say '== 初始化 submodule (third_party/opencode-wps) =='
    if (Test-Path (Join-Path $WpsMcpDir 'package.json')) {
        Ok 'submodule 已就绪'
    } else {
        Push-Location $RepoRoot
        & git submodule update --init --recursive
        $code = $LASTEXITCODE
        Pop-Location
        if ($code -ne 0) { Fail 'submodule 初始化失败' }
        Ok 'submodule 已初始化'
    }
}

# ── 3. 构建 wps-office-mcp ────────────────────────────────
if (-not $BridgeOnly) {
    Say '== 构建 wps-office-mcp =='
    if (-not (Test-Path (Join-Path $WpsMcpDir 'package.json'))) {
        Fail "未找到 $(Join-Path $WpsMcpDir 'package.json')（submodule 初始化失败？）"
    }
    if (-not (Test-Path (Join-Path $WpsMcpDir 'node_modules'))) {
        Invoke-Npm $WpsMcpDir 'install' 'npm install ...'
    } else {
        Ok 'node_modules 已存在，跳过 npm install'
    }
    Invoke-Npm $WpsMcpDir 'run build' 'npm run build ...'
    if (Test-Path (Join-Path $WpsMcpDir 'dist\index.js')) {
        Ok 'dist/index.js 已生成'
    } else {
        Fail '构建失败：未生成 dist/index.js'
    }
    # Windows 不需要 POLL_PORT 补丁（COM 通道不读该环境变量），跳过。
}

# ── 4. 同步加载项到 WPS ───────────────────────────────────
if (-not $BridgeOnly) {
    Say '== 同步加载项到 WPS =='
    if (-not (Test-Path $WpsJsaddons)) { New-Item -ItemType Directory -Path $WpsJsaddons -Force | Out-Null }
    New-Item -ItemType Directory -Path $AddonDir -Force | Out-Null
    foreach ($f in @('manifest.xml', 'ribbon.xml', 'index.html', 'taskpane.html')) {
        Copy-Item -Path (Join-Path $RepoRoot $f) -Destination $AddonDir -Force
    }
    Copy-Item -Path (Join-Path $RepoRoot 'css') -Destination $AddonDir -Recurse -Force
    Copy-Item -Path (Join-Path $RepoRoot 'js')  -Destination $AddonDir -Recurse -Force
    Ok "已同步到 $AddonDir"
    Warn '请完全重启 WPS（关闭所有窗口后重开），加载项才会重新加载'
}

# ── 5. 注册加载项 ─────────────────────────────────────────
if (-not $BridgeOnly) {
    Say '== 注册加载项（publish.xml / jsplugins.xml / authaddin.json） =='
    Update-JspluginsXml
    Update-AuthaddinJson
}

# ── 6. 启动 acp-bridge ────────────────────────────────────
if (-not $SkipBridge) {
    Say '== 启动 acp-bridge =='
    if (Test-PortOpen $BridgeHttpPort) {
        Ok "bridge 已在运行（HTTP :$BridgeHttpPort）"
    } else {
        $logFile = Join-Path $env:TEMP 'acp-bridge.log'
        $bridgePy = Join-Path $RepoRoot 'bridge\acp-bridge.py'
        # Start-Process 5.1 不会为数组元素自动加引号：拼成带引号的单字符串，防路径含空格
        $argStr = '"{0}" --http-port {1} --port {2} --agent "{3}" --acp-server "{4}" --log-file "{5}"' -f `
            $bridgePy, $BridgeHttpPort, $BridgeWsPort, $BridgeAgent, $AcpServer, $logFile
        $proc = Start-Process -FilePath $Python -ArgumentList $argStr `
            -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $env:TEMP 'acp-bridge.stdout.log') `
            -RedirectStandardError  (Join-Path $env:TEMP 'acp-bridge.stderr.log')
        Say "bridge 后台启动 pid=$($proc.Id)（日志: $logFile）"

        $ready = $false
        for ($i = 0; $i -lt 15; $i++) {
            Start-Sleep -Seconds 1
            if (Test-PortOpen $BridgeHttpPort) { $ready = $true; break }
        }
        if ($ready) { Ok "bridge 就绪: http://127.0.0.1:$BridgeHttpPort" }
        else { Warn 'bridge 未在 15s 内就绪，请查看日志排查' }
    }

    # 自检
    Say '== 自检 =='
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgeHttpPort/status" -TimeoutSec 5
        Ok "status: $($status | ConvertTo-Json -Compress)"
    } catch {
        Warn "GET /status 失败: $($_.Exception.Message)"
    }
    try {
        $config = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgeHttpPort/config" -TimeoutSec 5
        Ok "wpsMcpEntry: $($config.wpsMcpEntry)"
        if (Test-Path $config.wpsMcpEntry) { Ok 'wpsMcpEntry 文件存在' }
        else { Warn "wpsMcpEntry 文件不存在: $($config.wpsMcpEntry)（wps-office-mcp 未构建？）" }
    } catch {
        Warn "GET /config 失败: $($_.Exception.Message)"
    }
}

# ── 完成 ──────────────────────────────────────────────────
Say '== 完成 =='
Write-Host ''
Write-Host '  1. 启动 WPS 并打开一个文档'
Write-Host '  2. 功能区点击「QwenPaw AI」→「AI 侧边栏」'
Write-Host '  3. 输入指令（如：把第三段润色一下）'
Write-Host ''
Write-Host '  常用命令：'
Write-Host "    $Python $(Join-Path $RepoRoot 'bridge\acp-bridge.py') --agent $BridgeAgent"
Write-Host '    Get-Content $env:TEMP\acp-bridge.log'
Write-Host "    Invoke-RestMethod http://127.0.0.1:$BridgeHttpPort/status"
Write-Host ''
Write-Host '  Windows 注意事项：'
Write-Host '    - 文档操作走 PowerShell COM（wps-office-mcp win32 通道），侧边栏的'
Write-Host '      「WPS 桥: 重连中」属预期现象（Windows 无 :58891 轮询端口，不影响功能）'
Write-Host '    - 未打开文档时 session 工作目录回退为平台通用默认（Windows 用 %TEMP%），'
Write-Host '      建议始终打开文档后使用（与 Linux 行为一致）'
Write-Host '    - 若功能区不出现「QwenPaw AI」标签：重启 WPS、检查 jsaddons 注册文件，'
Write-Host '      或在 WPS 加载项管理中启用 wps-qwenpaw-addon'
