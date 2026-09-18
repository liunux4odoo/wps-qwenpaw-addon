# 安装部署指南

本指南面向使用者，说明从零开始安装 WPS-QwenPaw 加载项的完整流程。**推荐直接运行一键脚本**（见 [§一键安装](#一键安装)），手动步骤供排查与定制。

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Linux（本项目开发/验证平台） | 目前仅 Linux（WPS Linux + 反向轮询桥） |
| WPS Office | Linux 版 12.1.x（[linux.wps.cn](https://linux.wps.cn)） | 加载项宿主；需能打开 Word/Excel/PPT 文档 |
| Node.js | ≥ 18.0.0 | 运行 wps-office-mcp |
| Python | 3.12 | 运行 acp-bridge（conda py312 环境） |
| AI 后端（ACP server） | **二选一**：QwenPaw v2.1.0（主目标，默认）或 opencode ≥ 1.18（替代） | 智能体后端；`qwenpaw acp` / `opencode acp` 提供 ACP（纯 stdio），详见 [§AI 后端选择](#ai-后端选择acp-server) |
| opencode-wps | git submodule（固定提交 `6b8b33c`） | 内含 wps-office-mcp（v1.5.2） |
| 网络 | 首次安装需访问 GitHub | 拉取 submodule |

> **ACP server 支持范围（2026-09-07 定案）**：本项目以 **QwenPaw 为主目标**（默认后端，完整体验），**opencode 为替代**——面向无法安装或不愿安装 QwenPaw 的用户，已能完整体验本项目功能。claudecode / kimicode / qcoder 等其它 code agent **暂不支持**。

## Windows（实验性支持）

> **现状（2026-09-18 核实）**：本项目官方验证平台为 Linux；但核心组件跨平台就绪，Windows 上可完整体验：
> - **acp-bridge**（纯 Python asyncio）与 **wps-office-mcp**（submodule 自带 win32 PowerShell COM 通道）均跨平台；
> - 加载项 JS/HTML 全部使用 XHR HTTP 短轮询（WPS 内置 Chromium 兼容），不依赖 WebSocket/fetch；
> - Windows 上文档操作走 **PowerShell COM**（无需 Linux 的反向轮询 :58891 / noop 脚本 / POLL_PORT 补丁）。

Windows 一键安装（PowerShell 5.1+，Windows 10/11）：

```powershell
.\scripts\install.ps1                # 完整安装（自检 + 构建 + 同步 + 注册 + 启动 bridge）
.\scripts\install.ps1 -SkipBridge    # 只安装文件
.\scripts\install.ps1 -BridgeOnly    # 只启动 bridge
.\scripts\install.ps1 -AcpServer opencode   # 用 opencode 替代 qwenpaw 作为 ACP 后端
```

前提：WPS 个人版/企业版、Node.js ≥ 18、Python 3.10+（建议 3.12，`pip install websockets`）、qwenpaw 或 opencode 任一 ACP server。

Windows 与 Linux 的差异与注意事项：

| 项 | Linux | Windows |
|---|---|---|
| 加载项目录 | `~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_` | `%APPDATA%\kingsoft\wps\jsaddons\wps-qwenpaw-addon_` |
| 注册方式 | 目录名自动发现 | publish.xml / jsplugins.xml / authaddin.json（脚本自动写入/启用） |
| 文档操作通道 | 反向轮询（addon 拉取 :58891） | PowerShell COM（wps-office-mcp win32 分支，同步直连） |
| 宏安全性 | 必须调到最低（否则不加载） | 无强制要求（脚本不自动改注册表） |

> ⚠ Windows 侧边栏显示「WPS 桥: 重连中」属**预期现象**：COM 通道不用 :58891 轮询端口，不影响文档操作（QwenPaw→MCP→COM→WPS 全链路）。未打开文档时 session 工作目录回退为**平台通用默认**（Linux/macOS `/tmp`、Windows `%TEMP%`，由 bridge `/config` 下发），建议始终打开文档后使用（与 Linux 行为一致）。

## AI 后端选择（ACP server）

本项目需要一个 ACP（Agent Client Protocol）后端提供智能体能力，**二选一**：

| 后端 | 定位 | 说明 |
|---|---|---|
| **QwenPaw v2.1.0**（推荐） | **主目标，默认** | 完整体验：工具自动批准、中止（`session/cancel`）、历史恢复（`session/load`）、agent 切换（重启后端）。`bridge` 以 `--acp-server qwenpaw` 启动（默认值） |
| **opencode ≥ 1.18** | **替代** | 面向**无法安装或不愿安装 QwenPaw** 的用户，已能**完整体验本项目功能**（对话、WPS 工具调用、多窗口隔离、历史恢复）。差异：无审批环节（默认直接执行）、中止=结束会话重建、模型/mode 会话级配置。能力表见 [docs/acp-servers/opencode.md](docs/acp-servers/opencode.md) |

- 切换方式：bridge 启动参数 `--acp-server qwenpaw|opencode`；或运行后在侧边栏设置面板（⚙）选择并记住（localStorage 持久化）。
- **其余 code agent（claudecode / kimicode / qcoder 等）暂不支持**——ACP server 兼容到此为止，等有需要再扩展。

## 一键安装（推荐）

```bash
git clone --recurse-submodules https://<your-fork-or-path>/wps-qwenpaw-addon.git
cd wps-qwenpaw-addon
./scripts/install.sh
```

`install.sh` 依次完成：

1. **环境自检**：git / node / npm / python3 / qwenpaw / WPS
2. **submodule 初始化**：`git submodule update --init --recursive`
3. **构建 wps-office-mcp**：`cd third_party/opencode-wps/wps-office-mcp && npm install && npm run build`
4. **打 POLL_PORT 补丁 + 重建**（幂等，见 [DEPENDENCIES.md](./DEPENDENCIES.md)）
5. **部署 noop 脚本**：`scripts/wps-auto-noop.sh` → `third_party/opencode-wps/opencode-wps-linux/wps-auto.sh`
6. **同步加载项**：仓库文件 → `~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/`
7. **检查 WPS 宏安全性**（必需：宏安全性必须调到最低，否则插件不加载，见 [§宏安全性](#宏安全性必需)）
8. **启动 acp-bridge** 并输出自检结果

安装完成后按 [§启动](#启动) 启动即可。

> ⚠ **安装脚本只检查并提示宏安全性，不自动修改**（WPS 运行时修改会被其重启覆盖）。
> 若提示宏安全性非最低，按 [§宏安全性](#宏安全性必需) 调整后再启动 WPS。

## 宏安全性（必需）

> **实机验证结论（2026-09-03）**：WPS 的**宏安全性**未调到最低时，jsaddon 加载项**不会加载**——
> 功能区不出现「QwenPaw AI」标签、侧边栏打不开。这是本项目加载项能正常加载的**前置必要条件**。

- **含义**：把 wps（Word）、et（Excel）、wpp（PPT）三个应用的宏安全性都设为「低」（允许所有宏）。
- **最低值**：WPS 配置文件 `~/.config/Kingsoft/Office.conf` 中 `VbaSecurityLevel`（wps/wpp）与 `KDESecurityLevel`（et）均为 `1`。

### 方式一：脚本一键调整（推荐）

```bash
./scripts/check-wps-macro-security.sh            # 只检查当前级别
./scripts/check-wps-macro-security.sh --apply    # 自动调到最低（需先完全关闭 WPS）
```

> `--apply` 前必须**完全关闭 WPS**（关闭所有窗口），否则 WPS 退出时会用旧配置重写 `Office.conf`，
> 修改会被覆盖。脚本会自动备份原配置（`Office.conf.bak-macrosecurity-*`）。

### 方式二：WPS 界面设置

1. 启动 WPS，打开任一应用（Word/Excel/PPT）
2. 左上角「文件」→「选项」→「安全」（或「常规与保存」）→「宏安全性」
3. 选「低（允许所有宏）」，确定
4. 三个应用（wps/et/wpp）都要分别设置
5. 完全退出并重启 WPS

### 验证

重启 WPS 后打开文档，功能区出现「QwenPaw AI」标签、点击「AI 侧边栏」能打开侧边栏，即宏安全性已满足。

## 手动安装

### 1. 克隆仓库（含 submodule）

```bash
git clone --recurse-submodules <repo-url> wps-qwenpaw-addon
cd wps-qwenpaw-addon
```

若已克隆但未带 submodule：

```bash
git submodule update --init --recursive
```

### 2. 安装 AI 后端（ACP server，二选一）

**方案 A：QwenPaw（主目标，默认）**

```bash
# 推荐 conda 环境（与 bridge 共用 py312）
conda create -n py312 python=3.12 -y
conda run -n py312 pip install qwenpaw        # 具体安装方式以 QwenPaw 官方文档为准
conda run -n py312 qwenpaw --version          # 期望 v2.1.0
```

> QwenPaw 需先完成其自身的初始化（agent/模型配置）。本项目通过 `qwenpaw acp --agent default` 连接，默认 agent 需可用。

**方案 B：opencode（替代，用户无法/不愿安装 QwenPaw 时）**

```bash
# 按 opencode 官方方式安装（>= 1.18，需在 PATH 中，或用 OPENCODE_BIN 环境变量指定）
opencode --version
# 配置模型后可用 opencode acp 提供 ACP（能力表见 docs/acp-servers/opencode.md）
```

> opencode 已能完整体验本项目功能（对话、WPS 工具调用、多窗口隔离、历史恢复），差异仅为无审批环节 / 中止=重建会话 / 模型会话级配置。

> **其余 code agent（claudecode / kimicode / qcoder 等）暂不支持**（2026-09-07 定案）。

### 3. 安装 opencode-wps（submodule）与构建 wps-office-mcp

```bash
# submodule 已 clone（步骤 1），进入 wps-office-mcp 构建
cd third_party/opencode-wps/wps-office-mcp
npm install
npm run build        # 生成 dist/index.js
```

### 4. 打 POLL_PORT 补丁（路线 P 必需，幂等）

> 钉定的上游提交不含 `WPS_POLL_PORT` 支持。脚本会检查并在未打时应用。

```bash
cd third_party/opencode-wps/wps-office-mcp
if grep -q 'process.env.WPS_POLL_PORT' src/client/wps-client.ts; then
  echo "已打过补丁"
else
  sed -i 's/const POLL_PORT = 58891;/const POLL_PORT = Number(process.env.WPS_POLL_PORT) || 58891;/' src/client/wps-client.ts
  npm run build
fi
```

### 5. 部署 noop 脚本（防 WPS 被强杀）

```bash
cp scripts/wps-auto-noop.sh third_party/opencode-wps/opencode-wps-linux/wps-auto.sh
chmod +x third_party/opencode-wps/opencode-wps-linux/wps-auto.sh
```

> 原因：wps-office-mcp 在 Linux 下默认强制应用切换（`wps-auto.sh switch <app>` → pkill 强杀 WPS）。本项目的 noop 脚本让切换"假成功"，不杀用户打开的文档。详见 `docs/ARCHITECTURE.md` §12.1。

### 6. 安装 acp-bridge

```bash
# 依赖（conda py312 环境）
conda run -n py312 pip install websockets

# 自检：启动 bridge（--acp-server 选后端：qwenpaw 默认 / opencode 替代）
conda run -n py312 python bridge/acp-bridge.py --http-port 8766 --port 8765 --acp-server qwenpaw --agent default
```

bridge 会：
- 监听 HTTP `127.0.0.1:8766`（加载项实际使用：`/acp/send`、`/acp/poll`、`/ui/*`、`/config`、`/poll-port/*`、`/status`）
- 监听 WebSocket `127.0.0.1:8765`（调试/非 WPS）
- spawn ACP server 子进程（默认 `qwenpaw acp --agent default`；`--acp-server opencode` 则为 `opencode acp`；崩溃自动重启）

验证：

```bash
curl -s http://127.0.0.1:8766/config   # 应返回 wpsMcpEntry = <仓库根>/third_party/opencode-wps/wps-office-mcp/dist/index.js
curl -s http://127.0.0.1:8766/status    # 应返回 {"status":"running",...}
```

### 7. 安装 WPS 加载项

```bash
# 目标目录（WPS Linux 自动发现 jsaddons 下的 addon）
ADDON_DIR="$HOME/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_"
mkdir -p "$ADDON_DIR"
cp -r manifest.xml ribbon.xml index.html taskpane.html css js "$ADDON_DIR/"
```

> WPS 通过目录名（含 manifest id）自动发现加载项。`manifest.xml` 的 `<id>` 为 `wps-qwenpaw-addon`，目录名即 `wps-qwenpaw-addon_`。

> **必做**：同步加载项后，还要把 WPS 宏安全性调到最低（见 [§宏安全性](#宏安全性必需)），否则插件不加载。

## 启动

1. **启动 acp-bridge**（若未运行）：
   ```bash
   conda run -n py312 python bridge/acp-bridge.py --acp-server qwenpaw --agent default
   # 或选择 opencode 作为后端：
   # conda run -n py312 python bridge/acp-bridge.py --acp-server opencode
   ```
2. **启动 WPS** 并打开一个文档（Word/Excel/PPT 均可）。
3. 功能区出现 **QwenPaw AI** 标签，点击 **AI 侧边栏** 打开对话侧边栏。
4. 在输入框下达自然语言指令（如"把第三段润色一下"），AI 经 ACP server（QwenPaw/opencode）→ wps-office-mcp 操作文档。

> 打开文档是必须的：WPS 加载项引擎（CEF）在打开文档后才启动。

## 更新

```bash
git pull --recurse-submodules
./scripts/install.sh    # 重新构建 + 打补丁 + 同步加载项
```

> 更新后**完全重启 WPS**（不是只关文档窗口），确保新 JS 生效。

## 卸载

```bash
rm -rf ~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_
# 停止 bridge
pkill -f "acp-bridge.py"
```

## 常见问题

| 现象 | 处理 |
|---|---|
| 功能区没有 QwenPaw AI 标签 / 侧边栏打不开 | **最常见原因：WPS 宏安全性未调到最低**（见 [§宏安全性](#宏安全性必需)）；或未打开文档 / 未完全重启 WPS / 加载项目录未同步（重跑 install.sh） |
| 侧边栏显示「WPS 桥: 重连中」 | 预期行为：`:58891` 是 wps-office-mcp 懒启动端口，AI 首次调 WPS 工具后才监听；工具调用后自动连上 |
| bridge 未启动 | `conda run -n py312 python bridge/acp-bridge.py`，看日志；确认 :8766 未被占用 |
| 工具执行报 `Connection closed`/超时 | WPS 未打开文档（CEF 引擎未启动），打开文档重试 |

更多排查见 `docs/ARCHITECTURE.md` §7.4 与 §8。
