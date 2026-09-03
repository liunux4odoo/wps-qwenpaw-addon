# 安装部署指南

本指南面向使用者，说明从零开始安装 WPS-QwenPaw 加载项的完整流程。**推荐直接运行一键脚本**（见 [§一键安装](#一键安装)），手动步骤供排查与定制。

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Linux（本项目开发/验证平台） | 目前仅 Linux（WPS Linux + 反向轮询桥） |
| WPS Office | Linux 版 12.1.x（[linux.wps.cn](https://linux.wps.cn)） | 加载项宿主；需能打开 Word/Excel/PPT 文档 |
| Node.js | ≥ 18.0.0 | 运行 wps-office-mcp |
| Python | 3.12 | 运行 acp-bridge（conda py312 环境） |
| QwenPaw | v2.1.0 | 智能体后端；`qwenpaw acp` 提供 ACP（纯 stdio） |
| opencode-wps | git submodule（固定提交 `6b8b33c`） | 内含 wps-office-mcp（v1.5.2） |
| 网络 | 首次安装需访问 GitHub | 拉取 submodule |

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
7. **启动 acp-bridge** 并输出自检结果

安装完成后按 [§启动](#启动) 启动即可。

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

### 2. 安装 QwenPaw

```bash
# 推荐 conda 环境（与 bridge 共用 py312）
conda create -n py312 python=3.12 -y
conda run -n py312 pip install qwenpaw        # 具体安装方式以 QwenPaw 官方文档为准
conda run -n py312 qwenpaw --version          # 期望 v2.1.0
```

> QwenPaw 需先完成其自身的初始化（agent/模型配置）。本项目通过 `qwenpaw acp --agent default` 连接，默认 agent 需可用。

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

# 自检：启动 bridge
conda run -n py312 python bridge/acp-bridge.py --http-port 8766 --port 8765 --agent default
```

bridge 会：
- 监听 HTTP `127.0.0.1:8766`（加载项实际使用：`/acp/send`、`/acp/poll`、`/ui/*`、`/config`、`/poll-port/*`、`/status`）
- 监听 WebSocket `127.0.0.1:8765`（调试/非 WPS）
- spawn `qwenpaw acp --agent default` 子进程（崩溃自动重启）

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

## 启动

1. **启动 acp-bridge**（若未运行）：
   ```bash
   conda run -n py312 python bridge/acp-bridge.py --agent default
   ```
2. **启动 WPS** 并打开一个文档（Word/Excel/PPT 均可）。
3. 功能区出现 **QwenPaw AI** 标签，点击 **AI 侧边栏** 打开对话侧边栏。
4. 在输入框下达自然语言指令（如"把第三段润色一下"），AI 经 QwenPaw → wps-office-mcp 操作文档。

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
| 侧边栏显示「WPS 桥: 重连中」 | 预期行为：`:58891` 是 wps-office-mcp 懒启动端口，AI 首次调 WPS 工具后才监听；工具调用后自动连上 |
| 功能区没有 QwenPaw AI 标签 | 未打开文档 / 未完全重启 WPS / 加载项目录未同步（重跑 install.sh） |
| bridge 未启动 | `conda run -n py312 python bridge/acp-bridge.py`，看日志；确认 :8766 未被占用 |
| 工具执行报 `Connection closed`/超时 | WPS 未打开文档（CEF 引擎未启动），打开文档重试 |

更多排查见 `docs/ARCHITECTURE.md` §7.4 与 §8。
