# wps-qwenpaw-addon

WPS 加载项（侧边栏）+ QwenPaw 智能体集成。

用户在 WPS 写作时通过侧边栏对话界面，用自然语言让 AI 协助编辑 Word/Excel/PPT 文档，实现类似 Cursor 的体验。

## 架构

**三层 + 双角色**，详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 项目结构

```
wps-qwenpaw-addon/
├── README.md                ← 你在这里
├── manifest.xml             ← WPS 加载项清单（已实现）
├── ribbon.xml               ← WPS 功能区（QwenPaw AI 标签）
├── index.html               ← WPS Linux 加载项入口页（已实现）
├── taskpane.html            ← 侧边栏 UI 骨架（已实现）
├── bridge/                  ← ACP 桥接服务（已实现，阶段 0.5/1）
│   ├── acp-bridge.py        ← HTTP/WebSocket ↔ stdio 双向转发桥（HTTP :8766 + WS :8765）
│   ├── test_bridge.py       ← Python 自动化端到端验证脚本（WebSocket）
│   └── test-page.html       ← 浏览器手动测试页
├── js/                      ← 加载项 JS 模块（已实现）
│   ├── acp-client.js        ← ACP 协议客户端（HTTP 轮询 transport）
│   ├── wps-bridge.js        ← WPS JS API 轻量封装
│   ├── chat-ui.js           ← 聊天界面渲染
│   ├── wps-poll-client.js   ← wps-office-mcp 轮询执行端
│   └── main.js              ← 入口胶水层
├── css/
│   └── taskpane.css         ← 样式
└── docs/
    └── ARCHITECTURE.md      ← 完整架构方案（v0.7）
```

## 文档索引

| 文档 | 说明 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 完整开发方案 v0.7 — 目标、架构、约束、验收、阶段划分 |

## 开发方案的维护规则

- 架构层决策的变更 **必须先回到 discuss agent 重启讨论**，不能由 code agent 自行修改
- code agent 实施时如发现某条约束不可行，**先暂停、再讨论**，不要绕过
- 方案版本在 `docs/ARCHITECTURE.md` §0 记录

## 相关项目

- [opencode-wps/wps-office-mcp](/data/myrepo/opencode-wps/wps-office-mcp) — WPS 操作的 MCP Server 实现（v1.5.2，14 个直连工具 + 250+ Gateway 工具）
- QwenPaw — 智能体后端（记忆、技能、工具调用循环）

## 当前状态

**方案版本 v0.7**（阶段 0/0.5 完成；阶段 1 加载项代码完成，WPS 实机验证被环境阻塞）

**阶段 0：环境验证 ✅ 已完成（2026-08-28）**

实测结论（详见 docs/ARCHITECTURE.md §8.1）：
1. ✅ **:58891 回环打通**：通过 QwenPaw 触发 `ai-developer` 调 WPS 工具，wps-office-mcp 懒启动 :58891，`getDocumentText` 返回真实文档内容
2. ✅ **轮询协议逆向完成**：`/poll`（500ms）、`/result`、`/status`、CORS `*`、单槽位、30s 超时、去重、退避（§3.3）
3. ✅ **manifest 加载机制验证**：`authwebsite.xml` 是 WPS 的 allowedOrigins 等价机制；须打开文档才启动 CEF 加载项引擎
4. ✅ **QwenPaw MCP 挂载验证**：`ai-developer` agent 已挂 wps-office-mcp（14 个直连工具 + Gateway 全部 enabled）

**阶段 0.5：ACP 桥接服务 ✅ 已完成（2026-08-28）**

- ✅ 实现 `bridge/acp-bridge.py`（HTTP :8766 + WebSocket :8765 ↔ qwenpaw acp stdio 双向转发 + sessionId 路由 + 子进程崩溃重启）
- ✅ 端到端验证通过：initialize → session/new → session/prompt 流式 → 断线重连 + session/load 会话不丢 → session/close → 子进程崩溃自动重启（§8.2）
- ✅ ACP wire 协议实测定论：NDJSON 帧、`session/prompt` 发消息、`session/update` 通知流式（§3.4/§8.2）

**阶段 1：加载项骨架 ⏸ 代码完成，WPS 实机验证被环境阻塞（2026-08-28）**

- ✅ 加载项 8 文件 + index.html 入口页全部实现（manifest/ribbon/taskpane/css + 5 个 js 模块）
- ✅ **架构实测发现**：WPS Linux 沙箱拦截 WebSocket（:8765），只放行 HTTP（:58891）→ ACP 传输层改 **HTTP 短轮询**（acp-bridge :8766），Python 侧端到端验证通过（§3.3/§3.4）
- ⚠️ **阻塞**：WPS 加载项引擎（libjsapibrowser）无法启动（阶段 0 正常，清 CEF 缓存后损坏），加载项无法在 WPS 内加载 → 端到端验收待环境恢复后验证（§8.3）

**下一步**：回 discuss agent 处理 WPS 环境阻塞（恢复加载项引擎），恢复后完成阶段 1 实机端到端验收。
