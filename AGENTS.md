# AGENTS.md

面向 code agent 的最小项目指引。**完整开发规则见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。**

## Project

WPS 加载项（侧边栏）+ QwenPaw 智能体集成：用户在 WPS 里用自然语言让 AI 协助编辑 Word/Excel/PPT。三层 + 双角色（详见 docs/ARCHITECTURE.md §3）。

```
WPS (加载项 taskpane, HTTP轮询 :8766) ── acp-bridge (HTTP/WS↔stdio) ── qwenpaw acp (ACP)
    │  (角色B, HTTP轮询 poll端口)                                   └─ wps-office-mcp (MCP stdio, 每session一个)
    └── wps-office-mcp 的反向轮询端点（加载项是执行代理）
```

## Key Commands

```bash
./scripts/install.sh                          # 一键安装/配置（submodule+build+补丁+noop+同步+起bridge）
git submodule update --init --recursive       # 拉取 third_party/opencode-wps
conda run -n py312 python bridge/acp-bridge.py --agent default   # 前台启动 bridge（--acp-server qwenpaw|opencode 选 adapter）
conda run -n py312 python -m py_compile bridge/acp-bridge.py bridge/servers.py   # 语法检查 bridge + adapter
node --check js/*.js                               # 语法检查加载项全部 JS
node bridge/test_frontend_race.js                  # 前端行为验证（按 manifest 顺序加载控制器模块，A-F 场景）
```

## Architecture (critical)

- **硬约束**（不允许动）：见 docs/ARCHITECTURE.md §6。wps-office-mcp 零 fork（唯一例外：`WPS_POLL_PORT` env 支持，1 行加法）；acp-bridge 纯传输层不实现 ACP 业务逻辑；只绑 `127.0.0.1`；文档操作必须经 QwenPaw→MCP→wps-mcp。
- **server adapter**：bridge 的 spawn/agent 发现/切换语义/能力标志由 `bridge/servers.py` 提供（`--acp-server qwenpaw|opencode`，默认 qwenpaw 零回归）；qwenpaw 专属逻辑在 QwenpawAdapter，opencode 在 OpencodeAdapter（docs/plan-2026-09-05 §5）。
- **ACP server 支持范围（2026-09-07 定案，勿扩展）**：**qwenpaw 为主目标（默认）**，**opencode 为替代**（用户无法/不愿安装 qwenpaw 时可完整体验本项目功能，够用）；claudecode / kimicode / qcoder 等其它 code agent **暂不支持**，兼容到此为止，不要新增 adapter 或为其它 server 做适配。
- **入口**：`js/main.js` 是唯一耦合点（知道所有模块，其他模块互不依赖）。main.js 已按域拆为十个控制器模块（app-state/doc-state/bridge-config/session/agents/acp-events/watchdog/actions/poll/ribbon，见 docs/ARCHITECTURE.md §4.1），状态集中在 `app-state.js` 的 `QP.state`（各控制器 IIFE 内 `var S = QP.state`，闭包私有不落全局 `S`），跨文件函数最小导出到 `globalThis`，**加载顺序固定**（app-state → … → ribbon → main，main 最末）。
- **wps 路线 P**：每 ACP session 一个 wps-mcp 子进程，bridge 集中分配 `WPS_POLL_PORT`（59000+），多窗口并发合法（docs/ARCHITECTURE.md §13）。
- **WPS Linux 沙箱**：只放行 HTTP，拦 WebSocket → 加载项走 HTTP 短轮询（bridge :8766）；CreateTaskPane 只能 HTTP URL（bridge /ui/* 托管）。

## Dependencies

- `third_party/opencode-wps/` 是 **submodule**（固定提交 6b8b33c）。**不要**把 POLL_PORT 补丁/noop 部署提交进 submodule 的 git（见 docs/DEPENDENCIES.md）。
- wps-office-mcp 需 build 后才有 `dist/index.js`；安装脚本负责 build + 打补丁 + noop 部署。

## Gotchas

1. `js/main.js`、`js/wps-bridge.js` 与全部控制器模块（`app-state.js` 等十一个）必须**一起**同步到安装目录并完全重启 WPS（原子耦合；拆文件后新增了模块，只同步其一会出现 `ReferenceError` 或 `未支持的命令`）
2. WPS 需打开文档后 CEF 加载项引擎才启动（工具才可执行）
3. `:58891` 是 wps-mcp 懒启动端口，「WPS 桥: 重连中」是预期行为
4. 加载项 MCP 入口路径经 bridge `GET /config` 下发（`wpsMcpEntry`），不要硬编码本机绝对路径
5. 架构层决策变更必须先回 discuss agent，code agent 不得自行修改
