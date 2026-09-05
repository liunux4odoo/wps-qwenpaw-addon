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

- ✅ **批 1（2026-09-03，commit e2733b6）**：P1（状态误报/合并）、P2（中断恢复 + 错误恢复）、P4（过程呈现 + 思考反馈）、P5（中止）
- ✅ **批 2（2026-09-03，本轮）**：
  - **P3 agent 选择**：bridge 新增 `/agents`（qwenpaw agent list）+ `/agent/set`（切换重启子进程）；前端下拉选择 + localStorage 记住 + 切换重建会话
  - **P8 文档隔离**：按 docId 隔离会话状态（`getDocId` 来自 WpsBridge.getActiveDocumentInfo + 周期检测切换）
  - **P10 Markdown 渲染**：自写 `js/markdown.js` 轻量渲染器（转义安全，子集：标题/加粗/斜体/列表/代码块/行内代码/表格/链接/引用/分隔线），单元测试 14 项全过 + 真实浏览器 XSS 验证通过
  - **P15 历史对话加载**：localStorage 按 docId 缓存消息历史 + 缓存 sessionId（session/load 恢复 AI 记忆，失败回退 session/new）
  - **P12 视觉打磨**：空状态引导、消息/工具卡动画、agent 下拉/清空按钮/附件按钮样式、Markdown 内容样式
- ✅ **批 3（2026-09-03，本轮）**：
  - **P6 上传/粘贴**：附件按钮（文本提取降级，V1 已核实 ACP 无多模态）+ 粘贴图片占位提示
  - **P7 自动展开**：尽力 ResizeWindow（WPS 无官方 API，失败静默，记录平台边界）
  - **P11 操作结果反馈**：写操作后结构化侧边栏反馈（✅/❌ + 结果摘要）
  - **P13 快捷指令**：`/clear`（清空会话 + 重建）、`/help`、未知指令提示
  - **P14 清除对话历史**：工具栏"清空对话"按钮 + 确认弹窗（session/close + session/new，同步清前端缓存）
- ✅ **批 2/3 审查加固（2026-09-03，本轮）**：修复 tryAutoExpand 可能缩小侧边栏（改屏幕宽度 + 只增不减）；agent 切换/重建会话后清 docStates 残留 sessionId；空状态引导在首条消息后移除；Markdown 行内代码内容保护（占位符防加粗/斜体误处理）；错误卡 snapshot 干净提取（不拼按钮文本）；bridge switch_agent 复位重启退避延迟；P8 doc 检测改用轻量 `WpsBridge.getDocIdentity`（避免每 3s 重计数卡 WPS）；session/load 回退文案优化 + ensureSession 防重入
- ✅ **P2 v1.4 修复（2026-09-03，本轮，按 DEV-PLAN-Phase3.md v1.4）**：
  - **bridge stdout reader 超长行修复**（`docs/plan-2026-09-03-bridge-stdout-reader-fix.md`）：自实现 `_BoundedLineReader`（行缓冲上限 4MB）替代 `StreamReader.readline` 的 64KB 限制——工具大返回值（如 `getActiveDocument` 文档全文单行 JSON >64KB）不再抛 `ValueError` 崩 reader，下行不再永久断；正常行语义/顺序不变，无换行超长行显式打日志跳过，stdout/stderr 同等处理；验证：8 边界用例 + 真实 asyncio.StreamReader 集成测试全过
  - **看门狗阈值分层（实测结论）**：`P2_NO_FIRST_CHUNK_MS` 60s→**120s**，`P2_ACTIVITY_MS` 120s→**180s**（覆盖 qwenpaw 单次请求内 91s/104s thinking 完全静默窗口，不再误报）
  - **thinking 心跳接入**：`onAcpSessionUpdate` 新增 `agent_thought_chunk` 分支 → `touchActivity()` 续命 + "正在思考…"打字指示器（qwenpaw 思考时每 0.1-0.2s 一条，长思考不触发看门狗）
  - **自动延长不死判**：看门狗触发时进入"疑似中断"顺延态（UI 显示"AI 仍在处理…"，每次再等 60s，上限 3 次，总等待 ≤ 5min）；顺延期间任何下行回到正常态；顺延用尽才判定中断
- ✅ **WPS 宏安全性检查（2026-09-03，本轮）**：实机验证结论——宏安全性未调到最低时 jsaddon 加载项不加载。新增 `scripts/check-wps-macro-security.sh`（检查 + `--apply` 自动调整 wps/wpp `VbaSecurityLevel` 与 et `KDESecurityLevel` 为 1，带备份 + WPS 运行中拦截），`scripts/install.sh` 步骤 7 调用检查并提示，`docs/INSTALL.md` 新增「宏安全性（必需）」章节 + FAQ
- ✅ **P18/P19/P21（2026-09-05，用户第二轮实机反馈，见 DEV-PLAN-Phase3.md §1）**：
  - **P18 think 过滤**：关闭"显示过程"后，AI 回复正文中的 ```` ```think/thought/reasoning/note ... ``` ```` 围栏块不再显示——`MarkdownRenderer.stripThink()`（完整块剥离 + 流式未闭合尾部兜底，容忍 think 内容内单反引号、不误删正常代码块）；流式渲染/最终渲染/开关切换即时重渲染三处一致；历史缓存存**原文**（存明文=开=回显），渲染时按开关状态过滤——实时与历史恢复的开关行为一致（P18 方案内定：存明文则开=回显）
  - **P19 清空即新建空会话**：`clearCurrentSession()` 清空后主动 `session/new`（非惰性），UI 显示"正在新建会话…"；新会话沿用 P16 preamble 重新注入（重新现取文档身份）；`session/close` 竞态防护（close 响应不覆盖已就绪的新会话 id）；复用 SESSION_TIMEOUT_MS 看门狗/重试/可见错误
  - **P21 发送按钮条件禁用**：新增统一 `updateSendAvailability()`（ACP 已连接 + 会话已建立 + 无进行中请求 才可发送），替换全部散落的 `setInputEnabled` 调用；未就绪时按钮禁用 + 占位提示（连接中…/正在创建会话…/会话建立失败…/AI 正在处理…）；建立失败态 `sessionFailed` 标记 + 错误卡可重建；停止（P5）仍独立可用
- 🚧 **待 WPS 实机验证**：批 2/3 的 FE 改动（agent 切换、文档隔离切换、附件、自动展开）需 WPS 实机重开侧边栏端到端验收；P9（excel/ppt 加载）需实机确认 V4（manifest 已含 wps/et/wpp hosts）；P17（修订模式/回滚）V8 未决前不委派开发；P20（WPS 连接状态判定）待 V9 读 wps-poll-client 确认

## 部署配套（v0.17 路线 P 强制）

- **POLL_PORT 补丁**：submodule 的 wps-office-mcp 需打 `WPS_POLL_PORT` env 支持补丁后 rebuild（`scripts/install.sh` 自动完成）
- **noop 脚本**：`scripts/wps-auto-noop.sh` 部署到 `third_party/opencode-wps/opencode-wps-linux/wps-auto.sh`（防 WPS 强杀）
- **加载项同步**：`scripts/install.sh` 把仓库文件同步到 `~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/`
