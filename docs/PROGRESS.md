# 开发阶段与当前状态

> 方案版本演进详见 `docs/ARCHITECTURE.md` §0（当前 **v0.22**）。

## 当前状态

**方案版本 v0.22**（阶段 0/0.5/1/2 代码完成；wps MCP 路线 P 已落地，待 WPS 实机重开侧边栏端到端验收）

## 阶段 0：环境验证 ✅ 已完成（2026-08-28）

实测结论（详见 docs/ARCHITECTURE.md §8.1）：

1. ✅ **:58891 回环打通**：通过 QwenPaw 触发 `ai-developer` 调 WPS 工具，wps-office-mcp 懒启动 :58891，`getDocumentText` 返回真实文档内容
2. ✅ **轮询协议逆向完成**：`/poll`（500ms）、`/result`、`/status`、CORS `*`、单槽位、30s 超时、去重、退避（§3.3）
3. ✅ **manifest 加载机制验证**：`authwebsite.xml` 是 WPS 的 allowedOrigins 等价机制；须打开文档才启动 CEF 加载项引擎
4. ✅ **QwenPaw MCP 挂载验证**：`ai-developer` agent 已挂 wps-office-mcp（14 个直连工具 + Gateway 全部 enabled）

## 阶段 0.5：ACP 桥接服务 ✅ 已完成（2026-08-28）

- ✅ 实现 `bridge/acp-bridge.py`（HTTP :8766 + WebSocket :8765 ↔ qwenpaw acp stdio 双向转发 + sessionId 路由 + 子进程崩溃重启）
- ✅ 端到端验证通过：initialize → session/new → session/prompt 流式 → 断线重连 + session/load 会话不丢 → session/close → 子进程崩溃自动重启（§8.2）
- ✅ ACP wire 协议实测定论：NDJSON 帧、`session/prompt` 发消息、`session/update` 通知流式（§3.4/§8.2）

## 阶段 1：加载项骨架 ✅ 代码完成，路线 P 已落地，待 WPS 实机重开侧边栏验收（2026-08-28 → 2026-09-03）

- ✅ 加载项 8 文件 + index.html 入口页全部实现（manifest/ribbon/taskpane/css + 5 个 js 模块）
- ✅ **架构实测发现**：WPS Linux 沙箱拦截 WebSocket（:8765），只放行 HTTP（:58891）→ ACP 传输层改 **HTTP 短轮询**（acp-bridge :8766），Python 侧端到端验证通过（§3.3/§3.4）
- ✅ **wps MCP 路线 P 落地（v0.17，2026-09-03）**：wps-mcp 支持 `WPS_POLL_PORT` env（1 行）+ bridge 集中分配 poll 端口（59000+，`/poll-port/*` + session/new 注入 + close 回收）+ 加载项 stdio mcpServers + 轮询分配端口；Python 端到端验证通过（详见 docs/ARCHITECTURE.md §0 v0.17）
- 🚧 **待办**：WPS 实机重开侧边栏端到端验收（路线 P 多窗口并发）；noop 脚本部署确认（§5.1.1）

## 阶段 2：编辑能力 ✅ 代码完成，待 WPS 实机重开侧边栏验收（2026-09-03）

- ✅ wps-bridge.js 全面扩展：Word/Excel/PPT 编辑命令 40+ 项（insertText/getDocumentText/findReplace/setFont/insertTable/insertImage/…）
- ✅ main.js `onPollCommand` 改为分发器：`POLL_ACTION_MAP` + `Application.*` executeMethod 白名单
- ✅ Node 模拟 WPS jsapi 环境跑 43 项命令契约测试全过；`node --check` 语法通过
- ✅ 审查加固：findReplace Wrap 参数 bug、executeMethod 原型链段拒绝、findInDocument 增量统计
- 🚧 **待办**：WPS 实机端到端验证编辑命令（§8.4 停止门：把"foo"改成"bar"真能改成功）

## 阶段 3：体验打磨（进行中）

方案见 `docs/DEV-PLAN-Phase3.md`（P1-P15 + UX 验收标准 + 三批优先级）。

## 部署配套（v0.17 路线 P 强制）

- **POLL_PORT 补丁**：submodule 的 wps-office-mcp 需打 `WPS_POLL_PORT` env 支持补丁后 rebuild（`scripts/install.sh` 自动完成）
- **noop 脚本**：`scripts/wps-auto-noop.sh` 部署到 `third_party/opencode-wps/opencode-wps-linux/wps-auto.sh`（防 WPS 强杀）
- **加载项同步**：`scripts/install.sh` 把仓库文件同步到 `~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/`
