# WPS-QwenPaw 集成方案（v0.7 · MVP）

> **目标读者**：code agent
> **目标平台**：Linux（实机环境）
> **目标文档类型**：Word（MVP 跑通后扩 Excel/PPT）
> **目标智能体后端**：QwenPaw

---

## 目录

- [§0 文档元信息](#0-文档元信息)
- [§1 背景与动机](#1-背景与动机)
- [§2 目标](#2-目标)
  - [2.1 MVP 验收标准](#21-mvp-验收标准必须全部满足)
  - [2.2 非目标](#22-非目标mvp-不做)
- [§3 系统架构](#3-系统架构三层--双角色)
  - [3.1 顶层组件图](#31-顶层组件图)
  - [3.2 关键不变量](#32-关键不变量架构层硬约束)
  - [3.3 通信协议契约](#33-通信协议契约)
  - [3.4 ACP 桥接服务设计](#34-acp-桥接服务设计)
- [§4 加载项模块边界](#4-加载项模块边界mvp-8-个文件)
  - [4.1 文件清单](#41-文件清单)
  - [4.2 模块边界硬约束](#42-模块边界硬约束)
  - [4.3 加载项对外暴露的接口](#43-加载项对外暴露的接口仅-mainjs)
  - [4.4 加载项消费的接口](#44-加载项消费的接口来自外部)
- [§5 QwenPaw 侧配置](#5-qwenpaw-侧配置)
  - [5.1 MCP 客户端配置](#51-mcp-客户端配置)
  - [5.2 工具集裁剪](#52-工具集裁剪mvp-阶段)
  - [5.3 ACP Server 配置](#53-acp-server-配置)
- [§6 硬约束](#6-硬约束不允许的改动方向)
  - [6.1 不允许动的边界](#61-不允许动的边界)
  - [6.2 不允许的简化](#62-不允许的简化看起来省事但会埋坑)
  - [6.3 允许的扩展方向](#63-允许的扩展方向mvp-之后)
- [§7 验收测试方向](#7-验收测试方向)
  - [7.1 单元测试](#71-单元测试)
  - [7.2 集成测试](#72-集成测试)
  - [7.3 端到端验收](#73-端到端验收人工或脚本)
  - [7.4 已知风险点](#74-已知风险点)
- [§8 阶段划分与停止门](#8-阶段划分与停止门)
  - [8.1 阶段 0：环境验证](#81-阶段-0环境验证必须先做)
  - [8.2 阶段 0.5：ACP 桥接服务](#82-阶段-05acp-桥接服务)
  - [8.3 阶段 1：最小可跑](#83-阶段-1最小可跑端到端骨架)
  - [8.4 阶段 2：编辑能力](#84-阶段-2编辑能力核心功能)
  - [8.5 阶段 3：体验打磨](#85-阶段-3体验打磨mvp-验收)
- [§9 跨阶段约束](#9-跨阶段约束)
- [§10 附录：决策历史摘要](#10-附录决策历史摘要)
- [§11 文档维护](#11-文档维护)
- [§12 关键发现与 issue 追踪](#12-关键发现与-issue-追踪)

---

## §0 文档元信息

- **方案版本**：v0.23（多 ACP server adapter 落地，2026-09-06）
- **上一里程碑**：v0.22 阶段 3 方案补 P14/P15；v0.23 新增多 ACP server adapter 抽象（docs/plan-2026-09-05），bridge 支持 `--acp-server qwenpaw|opencode`，opencode 作为第一个第二 server 落地（spawn/建会话/对话/agent 枚举/切换语义）
- **变更控制**：任何架构层决策的修改需回到 discuss agent 重启讨论

### 变更历史

- **v0.23（多 ACP server adapter，2026-09-06）**：
  - **server adapter 抽象**：bridge spawn / agent 发现 / 切换语义 / 能力标志 从硬编码 qwenpaw 抽为 `bridge/servers.py` 的 per-server adapter（§3.4 补 adapter 层说明）；默认 `--acp-server qwenpaw` 零回归
  - **opencode 第一第二 server 落地**（D6）：spawn `opencode acp --cwd`（无 --agent，V1）；`mcpServers:[]` 兜底建会话（V3）；无 initialize 直接建会话可用（V10）；agent 枚举走 `opencode agent list`（V8）；mode 切换 = `session/set_config_option`（会话级，V11）而非 kill+重启
  - **能力标志下发**：`/config` 返回 `acpServer` + `capabilities`（honorMcpEnv/approval/thoughtHeartbeat/loadSession/cancel/agents），供 Phase 2 前端按标志适配
  - **验收**：`bridge/test_adapter.py`（qwenpaw+opencode E2E）+ test_switch_race.py/test_bridge.py qwenpaw 零回归全绿
- **v0.22（阶段 3 方案补 P14/P15，2026-09-03）**：
  - **P14 清除对话历史**（用户补充）：UI 入口（"清空对话"按钮 + 确认），区别于 P13 `/clear` 快捷指令；清空动作 = 前端清 + 后端 `session/close`+`session/new`（V7 待验证有无 `session/clear`）
  - **P15 同一文档加载历史对话记录**（用户补充，已核实不重复）：`session/load` = AI 上下文记忆恢复（后端，qwenpaw session state JSON 落盘，key=session_id+user_id=`acp_{id[:8]}`+channel=""）；ACP 协议无拉取消息明文接口（server 方法仅 new/load/list/resume/close/prompt/cancel/set_session_model/set_config_option）；**前端历史显示需自缓存**（localStorage 按 doc_id），不扩展 bridge 读 qwenpaw 内部存储（守 §6.1 铁律）
  - **连带**：UX 扩至 UX1-UX15；待验证项 V1-V7（新增 V7 有无 session/clear）；批 2 加 P15、批 3 加 P14；DEV-PLAN-Phase3.md v1.2→v1.3
- **v0.21（阶段 3 方案重构，2026-09-03）**：
  - **A-G 直接整合进 P 系列**：按用户决策（"该补充的补充，该修正的修正，该增加的增加"），DEV-PLAN-Phase3.md v1.1→v1.2，删除独立 §1.5「打磨方向全景」，A-G 全部并入 P1-P13
  - **并入**：B（思考反馈）→P4、C（工具可视化）→P4、D（错误恢复）→P2、G 粘贴图片→P6、G 多轮上下文→P8
  - **新增**：A→P10（Markdown）、E→P11（操作反馈）、F→P12（视觉）、G 快捷指令→P13（/clear）
  - **§2 改为来源追踪表**：原 §8.5 4 项 + A-G 7 方向 → P1-P13 去向映射
  - **验收/待验证同步**：UX1-UX13 引用更新为 P 编号；V6 影响任务 E→P11
- **v0.20（阶段 3 方案扩展，2026-09-03）**：
  - **合并打磨方向 A-G**：DEV-PLAN-Phase3.md v1.0→v1.1，新增 §1.5「打磨方向全景（A-G）」（A Markdown 渲染 / B 思考反馈 / C 工具可视化 / D 错误引导 / E 操作反馈 / F 视觉 / G 交互）
  - **新增独立新项**：A（Markdown 渲染，零依赖约束下需评估 vendored marked 或自写子集）、E（操作结果反馈，文档内定位依赖 V6）、F（视觉打磨）
  - **重叠项并入**：B→P4/P5、C→P4、D→P2、G→P3/P6（各补独立验收）
  - **UX 验收扩展**：UX1-UX8 → UX1-UX13（新增 UX9 Markdown/UX10 进行中反馈/UX11 操作反馈/UX12 视觉/UX13 快捷指令）
  - **待验证项扩展**：V1-V5 → V1-V6（新增 V6 wps-bridge 定位命令）
- **v0.19（文档拆分，2026-09-03）**：
  - **阶段 3 方案独立**：从本文档 §8.5 拆分，扩展为 `docs/DEV-PLAN-Phase3.md`（v1.0）——含用户反馈 9 项问题（P1-P9：状态误报/中断恢复/agent 选择/过程折叠/中止/上传/自动展开/文档隔离/三端加载）、原 §8.5 4 项打磨（流式优化/错误 UI/文档隔离/工具状态条）合并映射、后续多 ACP 后端计划（F1）、待验证项 V1-V5、UX 验收标准 UX1-UX8、三批优先级
  - **§8.5 精简**：原任务清单移入新文档，本节点保留进度状态 + 指向新文档
  - **部署**：acp-bridge 侧新增 `/poll-port/*` 分配端点（v0.17 路线 P 配套，§5.1.1）
- **v0.18（code 实施，2026-09-03 已落地，待 WPS 实机验证）**：
  - **背景**：路线 P 端到端链路已通（qwenpaw 给工具调用建议、审批自动批准、命令推送到加载项角色 B），但所有编辑类工具执行失败——调试日志定位：加载项 `onPollCommand` 只实现 `ping/getActiveDocument/getSelectedText`，其余命令全部回 `未支持的命令: <action>`（§8.3 阶段 1 只读骨架，阶段 2 编辑命令未实施）
  - **加载项 wps-bridge.js 全面扩展**（阶段 2 编辑能力落地）：
    - 新增统一响应封装 `ok()/fail()/invalidParam()`（与轮询协议 `/result` 契约一致）
    - Word 编辑命令：`insertText`（cursor/start/end + 数字位置）、`getDocumentText`（start/end/maxLength）、`getDocumentTextByRange`、`getDocumentParagraphs`、`findReplace`（查找计数 + 批量替换，返回 count）、`findInDocument`（返回位置/段落/上下文）、`smartFillField`、`replaceBookmarkContent`、`setFont`、`setTextColor`、`setParagraph`、`setLineSpacing`、`applyStyle`、`insertTable`、`insertPageBreak`、`insertImage`、`addComment`、`insertBookmark`、`insertHeader`、`insertFooter`、`generateTOC`、`insertSectionBreak`、`setPageSetup`、`getOpenDocuments`、`switchDocument`、`openDocument`、`createDocument`
    - 通用命令：`save`、`saveAs`、`openFile`、`setSelectedText`（Word 选区替换 + ET 单元格）、`getAppInfo`、`wireCheck`、`getActiveWorkbook`、`getCellValue`、`setCellValue`、`getActivePresentation`
    - `executeMethod`：wps_execute_method 白名单 `Application.*` 路径解析（与 mcp-server 侧同白名单/黑名单防护）
  - **加载项 main.js `onPollCommand` 改为分发器**：`POLL_ACTION_MAP`（action → WpsBridge 方法）+ `Application.*` 前缀走 `executeMethod`；未知命令仍回 `未支持的命令`
  - **数据契约对齐 wps-office-mcp 工具**：`insertText` 回 `{success,message,position,textLength}`、`getDocumentText` 回 `{text,length,truncated,maxLength}`、`findReplace` 回 `{count,findText,replaceText,message}` 等，与 `wps-office-mcp` 各 tool handler 读取字段一一对应（§8.4）
  - **验证**：Node 模拟 WPS jsapi 环境跑 43 项命令契约测试全过（含 execute_method 白名单/黑名单）；`node --check` 语法通过
  - **审查加固（2026-09-03，code review 后）**：①`findReplace` Wrap 参数 bug——Replace 模式改 `Replace=1(wdReplaceOne)` + `Wrap=0(wdFindStop)` 逐次替换计数（原先 `wdReplaceAll` 只回布尔导致 count 恒为 1）；查找计数模式 `Wrap` 位置参数改传 0（原先传 1=wdFindContinue 到文末回卷导致死循环冻结 + 计数错误）；②`executeMethod` 收紧——新增 `.Application`/`.Parent` 回引段与 `__proto__`/`constructor`/`prototype` 原型链段拒绝（addon 侧是实际解析执行点，前缀白名单可被 `Application.ActiveDocument.Application.*` 绕过）；③`findInDocument` 段落索引改增量统计（原先每命中从 0 重扫 O(n·m)）；④删除遗留无调用的 `getSelectedText()`
  - **⚠️ 部署配套（必须）**：`js/main.js` 与 `js/wps-bridge.js` **必须一起**同步到已安装 addon 目录并**完全重启 WPS** 才生效（两者原子耦合：只同步其一会出现 `未支持的命令` 或返回形状错位）：
    `cp js/main.js js/wps-bridge.js ~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/js/`
  - **待办**：WPS 实机重开侧边栏端到端验证编辑命令（§8.4 停止门：把"foo"改成"bar"真能改成功）

- **v0.17（code 实施，2026-09-03 已落地，待实机重开侧边栏验证）**：
  - **wps-office-mcp 1 行改动**：`wps-client.ts:46` `const POLL_PORT = Number(process.env.WPS_POLL_PORT) || 58891;`（已 build 到 dist，默认行为不变）
  - **bridge 集中分配端口**（acp-bridge.py 新增职责）：`POST /poll-port/allocate` / `GET /poll-port` / `POST /poll-port/release`（59000+ 段，60s 释放宽限期防残留碰撞）；`session/new`/`session/load` 转发前强制注入 `env.WPS_POLL_PORT`（权威值，ACP schema env 为 `[{name,value}]` 列表）；`session/close` 自动回收；`session/new` 响应补记 `session_id → poll_port`；`/status` 暴露 `ports`/`session_ports`
  - **加载项 main.js**：`MCP_SERVERS` 从 http 改回 **stdio**（`{name:'wps',command:'node',args:[dist/index.js],env:[{name:'WPS_POLL_PORT',value:'<port>'}]}`）；`initTaskpane` 先 `allocatePollPort()`（同步 XHR，失败回退 58891）再连 ACP + 启动 WpsPollClient 轮询分配端口；`closeSession` 显式 `releasePollPort()`；acp-client.js 暴露 `getClientId()` 复用同一 clientId
  - **验证通过（Python 端到端，真实 qwenpaw acp）**：allocate 唯一且幂等；http 型 mcpServer 不占端口；`session/new` 注入后 qwenpaw spawn 的 wps-mcp 进程 environ 含 `WPS_POLL_PORT=<port>`；`session/close` 自动释放；release 后 60s 宽限期不复用
  - **审查加固（2026-09-03，code review 后）**：①多窗口请求 id 路由去重——`http_pending` 平铺 id 表改为**全局 FIFO 队列**（`_request_queue` + `_pop_request_owner`，qwenpaw 顺序处理/顺序回响应，同 id 响应按转发顺序归属，杜绝多窗口 session 串台/端口错配）；②`_inject_poll_port` 非对象 JSON 防护（`isinstance(msg, dict)`）；③`/status` 默认脱敏（端口/session 映射仅 `?debug=1` 暴露）；④分配池上限 64 + 1h 租期自动回收失联 client；⑤`_allocate_port` O(1) 占用集 + 宽限期满复用兜底；⑥加载项端口分配改**异步 XHR**（sync XHR 忽略 timeout 无法超时回退）+ ACP 重连时 `syncPollPort()` 重同步权威端口
  - **部署配套**：addon 文件已同步到 `~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/`；待 WPS 实机重开侧边栏端到端验收（§8.3）
  - **⚠️ 部署依赖（跨仓库）**：wps-office-mcp 的 `WPS_POLL_PORT` 支持只在 **opencode-wps 仓库未提交的工作区**（`src/client/wps-client.ts` + 重新 build 的 `dist/`）——若该仓库被从已提交源码重新 checkout/rebuild，`dist` 会退回 `POLL_PORT=58891`，路线 P 的多窗口隔离即失效。**需把该改动 commit 进 opencode-wps（或加 build 步骤）并固定版本**后再依赖它

- **v0.17**（2026-09-03）：wps MCP 路线 P 决策（取代 v0.16 http 化）
  - **双份加载根因确认**：qwenpaw 侧 `drivers/mcp/wps-office-mcp.yaml` 之前一直 enabled + ACP session 注入 → 双份 wps-mcp 加载（用户"问 agent 工具反馈两份"铁证）；用户已禁用 yaml = 已清除双份源
  - **多窗口并发定论**：每窗口 = 每 ACP session（"文档即会话"决策）；poll-server **单槽位无路由**（`mac-poll-server.ts:415-425` 谁先 poll 谁领走）→ 多窗口多进程抢 :58891 + 命令串台；http 化只解抢端口**不解命令串台** → 必须改 wps-office-mcp
  - **决策**：**路线 P**——wps-mcp `POLL_PORT` 支持环境变量（`wps-client.ts:46` 1 行，默认 58891 不变）+ 每 session mcpServers 注入 `WPS_POLL_PORT` + **bridge 集中分配端口**（poll port ↔ session id 映射，59000+ 段）；残留进程**接受**（多进程共存合法化，只占资源不再影响功能）；QwenPaw 零改动（mcpServers env 原生注入子进程，`mcp/client/stdio/__init__.py:127`）
  - **§6.1 例外修订**：允许 `POLL_PORT` 环境变量 1 行改动；http transport 例外被取代
  - **决策后更新**：§3.1 组件图、§3.3 协议表、§3.4 进程模型、§5.1 配置、§5.1.1 部署配套、§10 决策表、§13 全文（http 决策保留为历史）
- **v0.16**（2026-09-03）：wps MCP http 化决策（discuss agent 调研 + 用户拍板，code agent 回写文档；**已被 v0.17 路线 P 取代**）
  - **残留根因锁定**（§13.5）：qwenpaw acp 未走 `close_session → _remove_session_mcp` 清理 stdio 子进程（现场 5 个 wps-mcp，4 个父进程为 qwenpaw acp 137411，疑似 hang；29min 仅 18s CPU）；mcp.client.stdio 清理链本身健康（killpg SIGTERM→SIGKILL 兜底 2s）
  - **架构核实**（§13.5）：插件走 :58891 轮询（私有协议），**不是** MCP client → "qwenpaw + 插件共享同一 mcp server" 预设不成立 → http 化唯一真实动机 = 消除残留
  - **决策**：wps-office-mcp **轻 fork**（`mcp-server.ts` 加 `transport/port` 加法配置，默认 stdio 不变 + fork 独立入口 `index-http.js`）+ **手动常驻运行**（不写 systemd）+ QwenPaw 配 `streamable_http` url；noop 脚本（§5.1.1）仍保留（解决强制应用切换，与 http 化独立）
  - **§6.1 新增例外**：允许加法补丁 + 独立入口文件支持 http；其他 wps-office-mcp 逻辑修改仍不允许
  - **code 实施（本次，已落地）**：
    - `mcp-server.ts`：`McpServerConfig` 加 `transport/port/host`；`start()` 按 transport 分支；`setupRequestHandlers(server)` 改接收 server 参数；**http 模式每 session 独立 `Server` 协议实例 + 按 `mcp-session-id` 维护 Map**（MCP SDK 单 Protocol 只能连一个 transport，多 session 必须独立实例）；`stop()` 关 http server
    - 新增 `src/index-http.ts`（不改 `index.ts`）：解析 `--port`/`--host` → http 模式启动 + gracefulShutdown
    - 新增 `scripts/start-wps-mcp-http.sh`：start/stop/status 便捷管理
    - 插件 `js/main.js`：`MCP_SERVERS` 从 stdio 改 http（`type:'http'` + `url` + `headers:[]`）
    - **验证通过**：SDK 客户端 initialize+tools/list（14 工具）OK；真实 ACP 链路 session/new(http mcpServers)→prompt→审批→工具执行 OK；**测试前后 qwenpaw 子进程 wps-mcp 均为 0**；单一常驻实例同时服务 :18765（MCP）与 :58891（轮询桥）
  - **决策后更新**：§3.1 组件图、§3.3 协议表、§5.1 配置、§5.1.1 部署配套、§10 决策表、§13 全文
- **v0.15**（2026-09-03）：多实例 wps-mcp 端口冲突 + wps-bridge jsapi 访问修复（code agent 依据调试日志定位）
  - **现象**：AI 报告「第一个 MCP 连接断了，换另一套试试：两套 WPS MCP 都连不上。这个环境里没有 WPS 跑着」，并反问"当前文档"指什么——但 WPS 实际开着文档
  - **问题 1：多实例 wps-mcp 争抢 :58891（"两套 WPS MCP"的物理来源）**
    - 机制：每次 `session/new` 带 `mcpServers` → qwenpaw 为该 session spawn 一个 **transient MCP driver 子进程**（wps-mcp）。而 `:58891` 是**单例端口 + 懒启动**（首次工具调用时才占用）
    - 实测进程树：5 个 wps-mcp 并存——`75724`（**孤儿**，父进程退出被 init 收养，**占着 :58891**）、`74512`（qwenpaw app 的）、`132811/133234/133259`（当前 qwenpaw acp 的 3 个 session）
    - **错位失败**：角色 B 连的是占端口的孤儿实例，但工具调用走的是新 session 实例的 stdio → 新实例抢不到 :58891（日志 `[WARN] Port 58891 already in use` / `[ERROR] Unhandled Rejection: Port 58891 已被残留的 WPS 轮询服务占用`）→ 命令推不到角色 B → AI 看到"连不上"
    - **清理方法**：`pkill -f "wps-office-mcp/dist/index.js"` + 重启 bridge（连带重启 qwenpaw acp），确保单实例干净占用 :58891
    - **运维约束**：保持**单一活跃 ACP session**（不要同时开多个侧边栏页面），session 关闭时其 wps-mcp 会退出并释放 :58891
  - **问题 2：wps-bridge.js 的 WPS jsapi 访问模式错误**
    - 调试日志直接定位：`[js:poll] 收到命令 action=getActiveDocument` → `[js:wps] getActiveDocumentInfo 异常: jsapi prototype return null` → `[js:poll] 回报结果 success=false error=无活动文档`（**链路已通，失败在 JS API 访问**）
    - 根因：`if (window.Application.ActiveDocument)` 在 **if 条件中短路访问属性链**会触发 WPS jsapi 原型调用并抛 `jsapi prototype return null`
    - 修复：按 opencode-wps `word-handler.js` 的写法——`try { doc = Application.ActiveDocument; } catch(e){}` **单独读属性**再判空，且用全局 `Application`（不加 `window.` 前缀）；`getSelectedText` 同样处理
  - **调试日志价值验证**：v0.11 加的 bridge + 插件侧日志（`/debug/log`）让两个问题都能从日志直接定位，无需猜测
- **v0.14**（2026-09-03）：ACP 客户端轮询自愈修复（code agent 实施后回写）
  - **现象**：bridge 重启后，侧边栏发消息一直报「AI 会话未就绪」，但 WPS 桥正常（「WPS 桥: 已连接」）；调试日志显示 bridge 恢复后再无 `/acp/poll` 请求
  - **根因**：`acp-client.js` 的轮询循环在网络错误时 `setStatus('disconnected')` 后调 `scheduleNext()`，而 `scheduleNext` 用 `status === 'disconnected'` 做退出守卫 → 立即 return，定时器不再排 → **轮询循环永久死亡，bridge 重启后不恢复**（`wps-poll-client.js` 用独立的 `isPolling` 标志，无此 bug）
  - **修复**：新增 `running` 标志控制轮询循环（与 `status` 解耦），`poll/scheduleNext/stop` 一律按 `running` 判断；网络错误只递增 failCount 走退避，不杀循环；退避连续失败 >10 才标 disconnected（仅 UI）
  - **会话自愈**：bridge 重启后 qwenpaw acp 是新子进程，旧 sessionId 失效。`onUserSend` 在 `acpSessionId` 为空时主动 `ensureSession()` 重建并提示重发；`onAcpResponse` 收到 `session/prompt` 错误时清除旧 sessionId + 重建会话
  - **验证**：Node 模拟 XHR 加载真实 `acp-client.js`，模拟 bridge 断开 3s→恢复，轮询自动继续（断期间持续重试，恢复后立即发请求）
- **v0.13**（2026-09-03）：WPS 崩溃根因核实 + D++ 方案落地（discuss agent 决策后回写）
  - **核实完成**（4/4 前提，证据见 §12.1）：①`currentApp` 仅在 `switchApp` 成功后赋值，加载项接入不更新；②`setCurrentApp` 是 public 但内部零调用者、**无 HTTP 写接口**；③`switchScriptPath` 无环境变量配置；④Gateway 工具（`wps_office_execute`）最终走 `execLinuxPoll` → PollServer.executeCommand 同样触发切换
  - **D++ 方案决策**（详见 §12.2）：
    - **短期**：用 noop 脚本 `scripts/wps-auto-noop.sh` 替换 `opencode-wps-linux/wps-auto.sh`，骗过 `switchApp` 让 `currentApp` 置为 `word`，之后所有 word 类命令都不再触发切换。延迟成本约 2-3s（execFile 启动 + 强制 2s setTimeout），远小于真实切换的 20-30s
    - **长期**：给 wps-office-mcp 提 issue（issue 草稿见聊天记录，建议：暴露 `setCurrentApp` 为 `POST /set-current-app` HTTP 端点）。issue 合并后切回标准模式
  - **杠杆方向**：不维护 fork，给上游贡献。`setCurrentApp` 已存在但无外部入口 = 作者预留了扩展点，issue 是顺势而为不是 hack
  - **已知接受**：opencode-wps 的应用切换功能失效（用户不用 opencode-wps，无影响）
  - §5.1 加 wps-mcp 配套配置说明（noop 脚本替换步骤）；§6.1 加硬约束（noop 脚本是 wps-mcp 部署的强制配套）；§8.3 阶段 1 待完成项移除崩溃阻断（替换为 noop 脚本后端到端验收）
  - **issue 草稿不入文档**：issue 是给上游的对外材料，由 discuss agent 在对话中提供，避免文档/issue 双源真相（§12.3 仅留摘要表）
- **v0.12**（2026-09-03）：WPS 崩溃根因定位（code agent 依据调试日志 + wps-office-mcp 源码定位）
  - **现象**：简单对话正常；明确指定操作 WPS 文档时，think 过程 WPS "崩溃"
  - **调试日志定位**（bridge `/tmp/kilo/acp-bridge-debug.log` + wps-office-mcp `~/.wps-office-mcp/logs/combined.log`）：
    - bridge 日志：加载项角色 B 全程 **168 次「轮询失败 网络错误」、0 次「收到命令」**——角色 B 从未接入 :58891
    - wps-office-mcp 日志：`[REQUEST] getActiveDocument → [Linux] Starting poll server → [Mac] Switching app from none to word → [Poll] Executing switch script: opencode-wps-linux/wps-auto.sh switch word → stdout: "[WPS-Auto] 关闭所有 WPS 应用...\n[WPS-Auto] 启动 WPS 文字..."`
  - **根因（100% 确认）**：**WPS "崩溃" = wps-office-mcp 的强制应用切换**。`getActiveDocument` 的 `requiredApp='word'`，而 `currentApp` 恒为 `'none'`（**加载项轮询接入不更新 currentApp；`setCurrentApp()` 无任何调用者；`currentApp` 只在 `switchApp` 成功后更新**，见 `src/client/mac-poll-server.ts:242/534/631/670`）→ `word !== 'none'` → 触发 `wps-auto.sh switch word` → **`pkill` 强杀所有 WPS + 重启**（用户正在编辑的文档被强杀 = 看到"崩溃"）→ 新 WPS 打开 `opencode_auto_blank_*.docx` 时 Qt 初始化 SIGSEGV
  - **关键结论**：
    1. wps-office-mcp 在 Linux 下**没有禁用应用切换的配置开关**（`switchScriptPath` 只是脚本路径，切换逻辑硬编码）
    2. 无论用户是否已手动开好 WPS+文档，**每次 wps-office-mcp 进程启动后第一次 word 类命令必然触发强杀重启**
    3. 角色 B 连不上 :58891 是**结果**（WPS 被杀/新实例加载项未接入），不是原因
    4. 这解释了 8/28、8/29、9/3 全部三次 `opencode_auto_blank_*.docx` 崩溃
  - **属于架构层冲突（§9 需回 discuss）**：改 wps-office-mcp 的切换逻辑违反 §6.1（零 fork）。可选规避方向：
    - A. 在加载项接入时通过某种机制设置 `currentApp`（`/status` 端点已暴露 `currentApp`，但无写入接口）
    - B. 让 QwenPaw 侧 wps MCP 配置使用 `wps_check_connection` 先探活，或裁剪掉会触发切换的工具
    - C. 由 bridge 在命令执行前预置 `currentApp`（若 wps-office-mcp 暴露入口）
    - 具体方向待 discuss agent 决策
- **v0.11（补充）**（2026-09-03）：侧边栏按钮修复（code agent 实施后回写）
  - **问题**：启动 WPS 自动弹出空白侧边栏；点「AI 侧边栏」按钮没反应，反而点「状态」按钮才打开对话侧边栏
  - **根因**：`OnAddinLoad` 的 `setTimeout(OnShowTaskPane, 800)` 自动打开侧边栏——启动时文档/CEF 引擎未就绪，CreateTaskPane 得到**空白窗格**，其 ID 被缓存（taskpaneIdCache/PluginStorage）；之后点「AI 侧边栏」按钮 `OnShowTaskPane` 走 `GetTaskPane(缓存ID)` **复用空白窗格**（表现为没反应）；「状态」按钮 `OnStatusClick` 总是 `CreateTaskPane(正确URL)`，反而能打开
  - **修复**：①去掉 `OnAddinLoad` 自动打开（由用户点 ribbon 按钮打开）；②`OnShowTaskPane` 改为**总是新建正确对话窗格**（先隐藏旧窗格避免堆积，不复用可能空白的缓存窗格）；③`OnStatusClick` 改为纯只读诊断（不创建窗格，显示侧边栏 URL/ID 缓存/GetTaskPane 状态/ActiveDocument）
- **v0.11**（2026-09-03）：调试日志体系（code agent 实施后回写）
  - **背景**：用户测试"在光标位置加上你的介绍"时 WPS 崩溃（journalctl：`wps` 进程 sig=11 SIGSEGV，栈为 Qt 初始化 `QGuiApplicationPrivate::createEventDispatcher`，崩溃命令行 `wps /tmp/opencode_auto_blank_*.docx`）。崩溃在 **WPS 打开 opencode-wps 自动空白文档时**，非加载项 JS 直接调用所致，但需日志定位触发链
  - **bridge 侧**：acp-bridge.py 增加调试日志——每个 HTTP 请求（method/path/clientId）、上游 `upstream[...]: id/method/sid`（含 session/prompt 文本摘要、request_permission 的 tool/options）、下游 `downstream:`（含流式 chunk 摘要、响应/错误）、子进程 spawn/退出/重启；新增 `POST /debug/log` 端点接收插件侧日志统一落盘；新增 `--log-file` 参数（默认写 stdout，level=DEBUG）
  - **插件侧**：新增统一日志函数 `window.QPLog(tag,msg)`（main.js 定义，console.log + XHR POST `/debug/log`），各模块埋点——acp-client.js（连接状态/poll 收发/send/respond/handleMessage 消息类型）、wps-poll-client.js（poll/收到命令 action+params/命令完成耗时/sendResult）、wps-bridge.js（每次 WPS API 访问及其结果/异常，崩溃高发点）、main.js（会话创建/审批/发送/轮询命令分发/ribbon 事件）
  - **验证通过**：`/debug/log` 端点正常落盘；真实链路 session/new→prompt→close 的 upstream/downstream 日志完整记录
  - **排查线索**：日志显示 QwenPaw agent loop 会自发调用内置工具（如 `memory_search`，不触发审批）；WPS 崩溃与 opencode-wps 的 `wps-auto.sh` 自动建空白文档 + WPS 打开该 docx 时初始化 segfault 相关，待实机复现定位
- **v0.10**（2026-08-29）：ACP 会话挂载 wps MCP + 工具审批流（code agent 实施后回写）
  - **根因定位**：`main.js` 的 `session/new` 传 `mcpServers: []`（空）→ QwenPaw 会话无 wps-office-mcp 工具 → 能对话但无法操作文档
  - **main.js**：`session/new`/`session/load` 的 `mcpServers` 改为 `[{name:'wps', command:'node', args:['/data/myrepo/opencode-wps/wps-office-mcp/dist/index.js'], env:[]}]`（§5.1 配置），QwenPaw 会话即可看到 14 个 wps 工具
  - **acp-client.js**：新增 `onRequest(cb)` 回调 + `respond(id, result)` 方法，处理 ACP 服务端请求（有 `id`+`method`、无 `result` 的消息）——主要是 **`session/request_permission`** 工具审批请求
  - **main.js onAcpRequest**：wps 工具 policy 为 `default_effect: ask`（§8.1），每次工具调用需审批；MVP 自动批准（`allow_once`，仅本次会话本次调用），UI 显示「🔓 已批准工具调用」系统消息
  - **ACP 协议实测定论**：审批请求 `session/request_permission`（服务端→客户端请求，带 id+sessionId+toolCall+options）；客户端回 `{"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}`（`AllowedOutcome` 判别 outcome="selected"，`DeniedOutcome` outcome="cancelled"）；optionId 可选 `allow_once`/`allow_always`/`deny`。会话模式 `session/set_config_option` 传 `mode=bypassPermissions` 可整体关闭审批（未采用，保留审批）
  - **验证通过**：Python 模拟 JS 客户端走 HTTP 轮询，`session/new(挂 wps) → session/prompt → request_permission 到达 → 回 allow_once → 工具执行` 全链路 OK；QwenPaw 感知 14 个 wps 工具（`wps__wps_*`）
  - **注意**：工具实际执行需 **WPS 打开文档**（CEF 加载项引擎启动，角色 B 接入 :58891）。WPS 未开时工具报 `Connection closed`/10s 超时，属 §7.4 已知风险
  - **残留进程清理**：早期 `&` 后台启动的 acp-bridge（pid 2248985）占用 :8765/:8766 导致后续 bridge 启动失败，已 kill；以后统一用后台进程管理
- **v0.9（补充）**（2026-08-29）：taskpane 诊断清理 + 插件目录同步策略（code agent 实施后回写）
  - **taskpane.html 去除测试/诊断元素**：删除红色 `taskpane 已加载` 标记、JS 错误 alert、黄色「诊断：页面已加载」浮层，只保留干净聊天 UI（消息区 + 输入框 + 状态条）。原因：侧边栏实机加载正常，但诊断探针让页面看起来像"测试页"
  - **WPS 桥重连状态澄清**：`:58891` 为 wps-office-mcp 懒启动端口，QwenPaw 首次调 WPS 操作工具前不监听 → 加载项轮询客户端显示「WPS 桥: 重连中」是**预期行为**（ACP 聊天通道不受影响），工具调用后自动连上（§3.2/§7.4）
  - **插件目录同步策略变更**：原 `~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/` 与工作仓库 `/data/myrepo/wps-qwenpaw-addon` 通过链接指向同一目录；用户已取消该链接，目标插件目录改为**真实副本**，后续代码 agent 修改加载项文件后须手动同步（cp）到目标插件目录（`jsplugins.xml`/`publish.xml`/`authaddin.json` 注册路径不变：`wps-qwenpaw-addon_`）
- **v0.9**（2026-08-29）：阶段 1 剩余代码完成（code agent 实施后回写）
  - **acp-bridge.py 新增静态文件服务**：HTTP 前端 `:8766` 新增 `/ui/*` 端点，托管加载项 UI 文件（taskpane.html / css/*.css / js/*.js / index.html），根目录默认插件仓库根（`--ui-root` 可覆盖），带目录穿越防护 + MIME 映射 + CORS
  - **main.js CreateTaskPane URL 定稿**：`getTaskPaneUrl()` 从临时 `http://127.0.0.1:18765/taskpane.html` 改为 `http://127.0.0.1:8766/ui/taskpane.html`；`OnStatusClick` 诊断 URL 同步更新
  - **HTTP 侧端到端验证通过**（bridge 起真实 qwenpaw acp 子进程）：`/ui/*` 静态服务正常（200 / 404 / 路径穿越拦截），ACP 轮询链路 `initialize → session/new → session/prompt 流式 → session/close` 全通，`main.js` 托管内容已无 18765 残留
  - **剩余**：WPS 实机内侧边栏 → 发消息 → AI 回复 的人工端到端验收（需 WPS + 文档打开状态）
- **v0.8**（2026-08-28）：CreateTaskPane 加载方式实测定论（discuss agent 实测后回写）
  - **CreateTaskPane 可用性定论**：WPS Linux 下 `window.Application.CreateTaskPane(url)` API 存在且能创建窗格（返回 ID），但**本地文件路径（相对/绝对）加载后窗格空白**，只有 **HTTP URL 能正常渲染**
  - **acp-bridge 职责扩展**：HTTP 前端（`:8766`）新增静态文件服务，托管加载项 UI 文件（taskpane.html / js/*.js / css/*.css）。加载项通过 `http://127.0.0.1:8766/ui/taskpane.html` 访问侧边栏页面
  - **收益**：ACP 轮询（`/acp/send` `/acp/poll`）和 UI 静态文件同源，无 CORS 问题；不再依赖 WPS 加载项的本地文件加载机制
  - **入口方式不变**：ribbon 按钮调用 CreateTaskPane 打开侧边栏，只是 URL 从本地文件改为 acp-bridge 的 HTTP URL
  - **决策补充**：此方案优于"外部浏览器方案"——保留了 WPS 内嵌侧边栏体验，且不增加用户操作步骤
- **v0.7**（2026-08-28）：阶段 1 实现 + 阻塞记录（code agent 实施后回写）
  - **实现加载项 8 文件**：manifest.xml / ribbon.xml / taskpane.html / css/taskpane.css / 5 个 js 模块（acp-client / wps-bridge / chat-ui / wps-poll-client / main.js）+ index.html 入口页
  - **架构层实测发现：WPS Linux 沙箱拦截 WebSocket（:8765），只放行 HTTP（:58891 已证）**——ACP 传输层从 WebSocket 改为 **HTTP 短轮询**（与 wps-office-mcp :58891 同机制）
  - acp-bridge.py 增加 HTTP 前端 `:8766`（`/status` `/acp/send` `/acp/poll`，CORS `*`），acp-client.js 改用 HTTP 轮询 transport；**Python 侧端到端验证通过**（initialize→session/new→session/prompt 流式→close）
  - **WPS 加载项引擎（libjsapibrowser）无法启动**（阶段 0 正常，清 CEF 缓存 `blob_storage`/`Cache` 后损坏）——加载项无法在 WPS 内加载，端到端验收被阻塞，需回 discuss（候选：恢复 WPS 加载项环境/重装）
  - 新发现：WPS Linux 加载项入口页为 **index.html**（非 taskpane）；Linux 版 opencode 用 ribbon+外部浏览器，规避 CreateTaskPane
- **v0.6**（2026-08-28）：阶段 0.5 实现并验证完成（code agent 实测后回写）
  - 实现 `bridge/acp-bridge.py`（Python，WebSocket ↔ stdio 双向转发 + sessionId/请求 id 路由 + 子进程崩溃重启）
  - **ACP wire 协议实测定论**：NDJSON 帧（每行一条紧凑 JSON-RPC 2.0）；发消息方法为 **`session/prompt`**（非文档 v0.5 误写的 `session/message`）；流式下行通过 **`session/update` 通知**（无 id，带 sessionId），每 token 一条 `agent_message_chunk`
  - `session/load` 复用会话需 `cwd` + `sessionId` + `mcpServers`（同 session/new）
  - 端到端验证通过（§8.2 测试记录）：initialize → session/new → session/prompt 流式 → 断线重连 + session/load 会话不丢 → session/close；子进程崩溃自动重启
  - 新增 `bridge/test_bridge.py`（Python 自动化验证脚本）+ `bridge/test-page.html`（浏览器手动测试页）
  - 修正 §3.4：`session/message` → `session/prompt`；补 wire 协议细节
- **v0.5**（2026-08-28）：ACP 桥接方案落地（discuss agent 决策后回写）
  - **ACP 传输层冲突已解决**：采用方向 A —— `bridge/acp-bridge.py` Python 桥接服务，WebSocket ↔ stdio 双向转发，放在插件仓库内
  - 新增 §3.4「ACP 桥接服务设计」：架构定位、设计原则、核心功能、进程模型、会话路由
  - 新增阶段 0.5「ACP 桥接服务实现」：在阶段 0 和阶段 1 之间插入，作为 ACP 通道打通的独立里程碑
  - 实测确认：单 `qwenpaw acp` 进程支持多会话（session/new 两次成功）；ACP 方法名格式为 `session/new` 等（单数 + 斜杠）；`session/new` 必填 `cwd` + `mcpServers`（list）
  - §3.1 顶层组件图加 acp-bridge 层；§3.3 通信协议契约更新为"加载项 → WebSocket → acp-bridge → stdio → qwenpaw acp"
  - §6.1 加硬约束：桥接服务不修改 QwenPaw 源码、不实现任何 ACP 业务逻辑（纯转发）
- **v0.4**（2026-08-28）：阶段 0 实测完成（code agent 实测后回写）
  - **ACP 传输层结论**：`qwenpaw acp` 是**纯 stdio**，QwenPaw **没有**网络 ACP server（无 WebSocket/HTTP+SSE 服务端）——§3.3 原假设 `ws://localhost:8765/acp` **不成立**，属架构层冲突，需回 discuss agent 重新决策
  - 固化轮询协议：`/poll`（500ms）、`/result`、`/status`、CORS `*`、单槽位、30s 超时、退避、去重、结果重试（§3.3）
  - 验证 :58891 懒启动（首次 WPS 工具调用触发）+ **回环打通**：`getDocumentText` 返回真实文档内容
  - 验证 manifest 加载机制：`authwebsite.xml` 是 WPS 的 allowedOrigins 等价机制；**加载项需打开文档后才启动 CEF 加载项引擎**（libjsapibrowser.so）
  - QwenPaw MCP 挂载确认：`ai-developer` agent 的 `drivers/mcp/wps-office-mcp.yaml` 生效（tools=40）；`policy.default_effect: ask` 使每次工具调用需审批
  - 发现 `wps_execute_method` governance 白名单只放行 `ActiveDocument`/`ActiveWorkbook`/`ActivePresentation` 三个顶层属性，文档内容获取须走 `wps_get_active_document` 或 Gateway `wps_office_execute`
  - 新增 §8.1「阶段 0 测试记录」：P1-P6 探针的原始操作/观察/结论（含环境信息与原始返回），作为可复现实测存档
- **v0.3**（2026-08-28）：审查修正（code agent 审查后回写，涉及 §3/§4/§5/§7/§8）
  - 修正 §4 文件清单：5 个文件 → 8 个（补 `css/taskpane.css`）；`main.js` 依赖"三个"→"四个"
  - 修正 §5.2 工具数口径（Gateway 已含在 14 个直连内）与实现方式（删除 fork 选项，符合 §6.1）
  - 澄清 G5/G6 与 §7.3 的关系：docId 会话映射 + QwenPaw 侧持久化 / 加载项内存态清理
  - 新增阶段 0 步骤：ACP 传输层探测、轮询协议逆向固化、manifest 加载验证
  - 新增 §7.4 风险：ACP 传输层不确定性、manifest 加载/网络权限、会话持久化语义
- **v0.2**（2026-08-28）：加入 wps-office-mcp 实测发现
  - 修正工具数（14 个直连工具 + 250+ 个通过 gateway 间接暴露）
  - 新增 :58891 懒启动行为
  - 新增 `wps_check_connection` 在 Linux 下的"误报"行为
  - 新增阶段 0 的具体预热步骤
- **v0.1**（2026-08-28）：初版，架构收敛

---

## §1 背景与动机

用户希望实现"WPS 里的类 Cursor 体验"——用户在 WPS 写作时通过侧边栏对话界面，用自然语言让 AI 协助编辑 Word/Excel/PPT 文档。

**已确认的关键事实**：

1. WPS 加载项采用 HTML/JS 沙箱模型（Chromium 内嵌），能力受限（不能起 Node.js 进程、不能调系统命令、不能起 HTTP server）
2. 已有开源项目 `/data/myrepo/opencode-wps/wps-office-mcp`（v1.5.2）提供 WPS 操作的 MCP 封装：
   - 对外直接注册 **14 个工具**（含 Gateway 入口）
   - 内部另有 **250+ 个 COM Action** 通过 `wps_office_search` + `wps_office_execute` 两阶段调用
   - 工具集裁剪策略详见 §5.2
3. 该项目在 Mac/Linux 下采用"轮询桥"模式：Node.js 进程起 HTTP server `:58891`，WPS 加载项主动轮询拉取命令执行
4. QwenPaw 通过 stdio 自动拉起 wps-office-mcp 进程，对外表现为一个 MCP 客户端配置
5. QwenPaw 通过 ACP（Agent Client Protocol）对外提供接口供客户端连接——**阶段 0 已实测：`qwenpaw acp` 是纯 stdio 模式，QwenPaw 没有网络 ACP server**（无 WebSocket 也无 HTTP+SSE 服务端），加载项无法通过 TCP 连接它。见 §3.3 的架构层冲突说明

**架构动机**：避免重新发明已有能力。QwenPaw 提供智能体能力（推理、记忆、技能、工具调用循环），wps-office-mcp 提供 WPS 操作能力，加载项提供 UI 和平台兼容执行端。

---

## §2 目标

### 2.1 MVP 验收标准（必须全部满足）

- **G1**：在 WPS Linux 桌面版装上加载项后，Word 文档能打开侧边栏
- **G2**：用户在侧边栏输入自然语言指令（如"把第三段润色一下"），AI 能完成实际编辑
- **G3**：AI 的回复以流式方式显示在侧边栏（不是等全部完成才显示）
- **G4**：编辑操作完成后，WPS 文档里的对应段落确实被修改了
- **G5**：打开不同 Word 文档会创建独立会话（互不串味，按 docId 映射，见 §3.2）
- **G6**：会话关闭（文档关闭）后加载项运行态（内存中）会话状态被清理，不污染下次会话；QwenPaw 侧按 docId 持久化的历史允许重开同文档时恢复（见 §3.2、§7.3）

### 2.2 非目标（MVP 不做）

- 不支持 Excel/PPT（架构跑通后再扩展）
- 不支持 Mac/Windows（先 Linux 实机）
- 不做撤销/重做 UI
- 不做文档对比、版本控制
- 不做多用户协作
- 不做插件市场分发（仅本机安装）

---

## §3 系统架构（三层 + 双角色）

### 3.1 顶层组件图

```
┌──────────────────────────────────────────────────────────────┐
│  WPS 客户端（Linux 桌面）                                      │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  WPS 加载项（HTML/JS，单进程双角色）                  │    │
│  │  ┌────────────────────┐  ┌────────────────────────┐  │    │
│  │  │  角色 A：聊天 UI    │  │  角色 B：轮询执行端     │  │    │
│  │  │  - 消息渲染         │  │  - 连 :58891 拉命令     │  │    │
│  │  │  - 状态条          │  │  - 调 WPS JS API 执行   │  │    │
│  │  │  - 输入框          │  │  - 回传结果到 :58891    │  │    │
│  │  │  (走 ACP HTTP 轮询)  │  │  (走 HTTP)              │  │    │
│  │  └─────────┬──────────┘  └───────────┬────────────┘  │    │
│  └────────────┼─────────────────────────┼───────────────┘    │
└───────────────┼─────────────────────────┼───────────────────┘
                │                          │
        HTTP    │                  HTTP   │
        :8766   │                  :59000+│
                ▼                          ▼
┌────────────────────────────┐  ┌──────────────────────────────┐
│  acp-bridge（Python 进程）  │  │  wps-office-mcp (Node.js)    │
│  - HTTP Server :8766       │  │  - 14 直连 + 250+ Gateway    │
│    · 静态文件 /ui/*         │  │  - 工具 schema/调度         │
│    · ACP 轮询 /acp/*        │  │  - HTTP poll server :WPS_   │
│    · 集中分配 poll 端口      │  │    POLL_PORT（每 session     │
│      port↔session 映射     │  │    独立端口，§13 路线 P）    │
│  - WebSocket :8765（保留调试）│  │  (QwenPaw stdio 自动拉起,   │
│  - spawn qwenpaw acp 子进程 │  │   每 session 一个进程)      │
│  - ACP 消息双向转发        │  └──────────────────────────────┘
│  - 按 sessionId/clientId 路由  │
└──────────────┬─────────────┘
               │ stdio (ACP 协议 NDJSON)
               ▼
┌────────────────────────────┐
│  QwenPaw (Python)          │
│  - 推理/规划/记忆/技能     │
│  - ACP (stdio 模式)        │
│  - MCP Client (stdio)      │
│       │                    │
│       │ MCP stdio          │
│       │ (env.WPS_POLL_PORT)│
└───────┼────────────────────┘
        │
        ▼
   LLM API / 记忆 / 技能
```

> **架构说明（v0.17 路线 P）**：每个 ACP session 一个 wps-office-mcp 子进程（QwenPaw 通过 MCP stdio 拉起，注入 env.WPS_POLL_PORT），各自监听**独立 poll 端口**（bridge 集中分配，59000+ 段）。多窗口并发（每窗口一 session）下多进程共存是合法状态——各占独立端口，无 EADDRINUSE、无命令串台。残留进程只占资源不再影响功能。acp-bridge 解决三个问题：①`qwenpaw acp` 只有 stdio、②WPS 沙箱只放行 HTTP 不放行 WebSocket、③WPS CreateTaskPane 本地文件路径空白需 HTTP 托管；v0.17 新增：**集中分配 poll 端口**。

> **决策演进**：v0.16 曾决策 http 常驻（streamable http，`index-http.js`），v0.17 被路线 P 取代——P 侵入更小（wps-mcp 1 行）且原生解多窗口并发。详见 §13。

### 3.2 关键不变量（架构层硬约束）

- **加载项是单进程双角色**：同一份代码里同时跑 ACP 客户端和轮询客户端，两段代码互不调用
- **ACP 通道只管对话流**：用户消息上行、AI 回复下行、UI 协作类工具调用
- **MCP 通道只管文档操作**：QwenPaw 调 wps-office-mcp 的工具
- **轮询通道是 wps-office-mcp 内部实现细节**：QwenPaw 不直接感知，加载项的角色 B 是 wps-office-mcp 的执行代理
- **每层只知道自己该知道的**：QwenPaw 不知道 WPS JS API，wps-office-mcp 不知道 QwenPaw 记忆，加载项不知道 MCP 协议
- **Linux 下 :58891 是懒启动的**：wps-office-mcp 被拉起后默认不监听 :58891，**第一次真正调用 WPS 操作工具时才启动轮询服务器**。加载项的轮询客户端必须能处理"连上了又断开"的状态（带退避重连）
- **`wps_check_connection` 在 Linux 下是"进程级"检查**：它只扫描 `/proc` 看 WPS 主进程是否存活，不验证加载项是否真的接入了 :58891。不能用这个工具判断"加载项已连接"
- **会话按文档隔离（docId）**：加载项以文档标识（docId）为会话 key 映射到 QwenPaw 的 ACP session；关闭文档只清理加载项内存态（G6），QwenPaw 侧历史按 docId 持久化，重开同文档可恢复（§7.3）

### 3.3 通信协议契约

| 通信对 | 协议 | 端口/地址 | 用途 |
|---|---|---|---|
| 加载项 ↔ acp-bridge | HTTP（ACP 短轮询 + 静态文件） | `http://127.0.0.1:8766/acp/*` + `http://127.0.0.1:8766/ui/*` | 对话流、UI 协作、UI 文件托管 |
| 加载项 ↔ wps-office-mcp | HTTP loopback（轮询桥） | `http://localhost:58891/poll` `http://localhost:58891/result` | 拉取/回传 WPS 操作 |
| acp-bridge ↔ QwenPaw | ACP over stdio（NDJSON，每行一条） | acp-bridge spawn `qwenpaw acp` | ACP 消息转发 |
| QwenPaw ↔ wps-office-mcp | MCP over stdio（每 session 一个进程 + 独立 `WPS_POLL_PORT` env；§13 路线 P） | QwenPaw 自动拉起（stdio）+ bridge 集中分配 poll 端口 | 工具调用 |

> **✅ MCP 传输层决策（v0.17，§13）**：路线 P——每个 ACP session 注入 mcpServers（stdio + env.WPS_POLL_PORT），QwenPaw spawn 独立 wps-mcp，各自监听独立 poll 端口（bridge 集中分配，poll port ↔ session id 映射）。多窗口并发（每窗口一 session）下多进程共存为合法状态，无端口冲突、无命令串台。~~v0.16 的 streamable http 方案已被取代~~。

> **✅ ACP 传输层定论（v0.7 实测）**：
> - v0.5 决策：`qwenpaw acp` 是纯 stdio，加载项无法直连，引入 `bridge/acp-bridge.py` 桥接（WebSocket ↔ stdio）
> - **v0.7 实测修正：WPS Linux 沙箱拦截 WebSocket**——taskpane 页面 `new WebSocket('ws://127.0.0.1:8765')` 无任何连接尝试；而 HTTP XHR 到 :58891 可通。**因此 ACP 传输层改用 HTTP 短轮询**（与 :58891 同机制，WPS 已验证支持）
> - acp-bridge 现提供两个前端：**HTTP 轮询 `:8766`**（WPS 加载项实际使用，`/acp/send` 上行 + `/acp/poll` 下行，CORS `*`）+ WebSocket `:8765`（保留供调试/非 WPS）。两者共享同一 qwenpaw acp 子进程与下行路由表
> - Python 侧端到端验证通过：`/acp/send` initialize→session/new→session/prompt → `/acp/poll` 收流式 `session/update` 通知 → close

> **✅ CreateTaskPane 加载方式定论（v0.8 实测）**：
> - WPS Linux 的 `window.Application.CreateTaskPane(url)` API 存在，能创建窗格并返回 ID，但**本地文件路径（相对路径如 `taskpane.html`、绝对路径如 `/taskpane.html`）加载后窗格空白**——HTML/CSS/JS 都没渲染出来
> - **HTTP URL 加载完全正常**：`http://127.0.0.1:18765/taskpane.html`（python http.server 托管）能正常显示 UI，所有 JS 模块加载成功，WPS API（`window.Application.ActiveDocument` 等）可用
> - **因此**：acp-bridge 的 HTTP 前端 `:8766` 新增静态文件服务（`/ui/*`），托管加载项的 HTML/CSS/JS；CreateTaskPane 传入 `http://127.0.0.1:8766/ui/taskpane.html`
> - 好处：ACP 轮询和 UI 静态文件**同源**，无 CORS 问题；不依赖 WPS 对本地文件的加载机制；acp-bridge 一个进程搞定所有网络层

> **轮询桥协议（阶段 0 已逆向固化）**：
> - `GET /poll` — 加载项每 **500ms** 拉取命令；有活回 `{"command":{"action","params","requestId"}}`，没活回 `{}`
> - `POST /result` — 回报执行结果，body `{"requestId","result":{"success","data","error"}}`；服务端回 `{"ok":true}`，未知 requestId 回 `{"ok":true,"alreadyHandled":true}`
> - `GET /status` — 状态检查，回 `{"status","currentApp","hasPendingCommand"}`
> - `OPTIONS` — CORS 预检，响应头 `Access-Control-Allow-Origin: *`、`GET, POST, OPTIONS`
> - 服务端**单槽位**：一次只等一个命令，新命令 supersede 旧命令；默认超时 **30s**（部分命令 10s，如 getActiveDocument）
> - 加载项侧需：**requestId 去重**（poll 可能重复返回同一命令）、结果 POST **失败重试 3 次**（500ms 退避）、poll 网络错误**指数退避**（500ms→5s 封顶）

**QwenPaw 视角的工具调用链**：

```
QwenPaw agent loop 决定调 wps_word_set_font
  → QwenPaw 通过 MCP 发 tool_call
  → wps-office-mcp 收到
  → wps-office-mcp 通过 :58891 推给加载项（角色 B）
  → 加载项在 WPS 沙箱里执行
  → 加载项通过 :58891 回报结果给 wps-office-mcp
  → wps-office-mcp 通过 MCP 回报 tool_result 给 QwenPaw
  → QwenPaw 继续推理
```

QwenPaw **不感知**这条链路的中段细节，它看到的只是 `tool_call → tool_result` 的完整循环。

**加载项 ↔ QwenPaw 的 ACP 调用链（经 acp-bridge）**：

```
加载项 acp-client.js 发 ACP 消息（JSON-RPC）
  → WebSocket ws://127.0.0.1:8765
  → acp-bridge WebSocket server 收到
  → acp-bridge 写 stdio → qwenpaw acp 子进程
  → qwenpaw acp 处理（推理 / 工具调用 / 流式输出）
  → qwenpaw acp 写 stdout 返回 ACP 消息
  → acp-bridge 读 stdout，按 sessionId 路由
  → acp-bridge 写 WebSocket → 加载项
  → 加载项 acp-client.js 接收，更新 UI
```

acp-bridge **不做任何业务逻辑**，只做传输层转发（WebSocket ↔ stdio）+ sessionId 路由。

---

### 3.4 ACP 桥接服务设计

**定位**：解决"WPS 加载项只能走 WebSocket / HTTP，但 ACP server（`qwenpaw acp` 等）只有 stdio"的传输层断层。纯转发、不实现业务逻辑、不修改 ACP server 源码。

**server adapter 层（v0.23，plan-2026-09-05）**：
- bridge 的 spawn / agent 发现 / 切换语义 / 能力标志 由 `bridge/servers.py` 的 per-server adapter 提供（配置化描述，非协议归一化层，守"bridge 不做业务逻辑"铁律）
- 启动参数 `--acp-server <name>`（默认 `qwenpaw`，现状零回归）；当前支持的 adapter：
  - **qwenpaw**：`qwenpaw acp --agent X`，kill+restart 切换，daemon/CLI agent 发现（行为不变）
  - **opencode**：`opencode acp --cwd`（无 --agent），`mcpServers:[]` 兜底建会话，无 initialize 握手（V10 ✅），agent 枚举走 `opencode agent list`（mode/自定义 agent），mode 切换 = `session/set_config_option`（会话级，V11 ✅）
- `/config` 下发 `acpServer` + `capabilities`（能力标志，Phase 2 前端按标志适配：approval/thoughtHeartbeat/cancel/loadSession/honorMcpEnv/agents）

**设计原则**：

1. **透明转发**：ACP 消息内容原样透传，不解析、不修改、不新增字段
2. **零业务逻辑**：桥接服务只关心传输，不关心 ACP 消息语义
3. **同仓同生命周期**：放在插件仓库 `bridge/` 目录，跟加载项一起打包、一起启停
4. **Python 实现**：跟 QwenPaw 同语言栈，减少依赖；WebSocket 库用标准方案
5. **单进程单子进程**：MVP 阶段一个 acp-bridge 进程 spawn 一个 `qwenpaw acp` 子进程；多会话由 qwenpaw acp 内部管理，桥接服务只按 sessionId 路由消息

**核心功能**：

| 功能 | 说明 |
|---|---|
| HTTP Server :8766 | 统一 HTTP 前端，**WPS 加载项实际使用**（阶段 1 实测：WPS 沙箱只放行 HTTP） |
| ├─ 静态文件服务 `/ui/*` | 托管加载项 UI 文件（taskpane.html / js/*.js / css/*.css），供 CreateTaskPane 通过 HTTP URL 加载（v0.8 实测：本地文件路径空白，必须 HTTP） |
| ├─ ACP 轮询 `/acp/*` | `/status`、`/acp/send`（POST 上行）、`/acp/poll`（GET 下行，JSONL），CORS `*` |
| WebSocket Server :8765 | 供非 WPS 场景/调试（保留） |
| spawn ACP server | adapter 生成启动命令（qwenpaw：`qwenpaw acp --agent X`；opencode：`opencode acp --cwd`），管理 stdin/stdout/stderr |
| 上行转发 | 前端收到消息 → 写子进程 stdin |
| 下行转发 | 子进程 stdout → 解析 ACP 消息 → 按 sessionId/请求 id 路由到对应前端 |
| 生命周期管理 | 桥接服务启动 → 拉起 qwenpaw acp；退出 → 杀子进程；子进程异常退出 → 重启（指数退避） |
| 错误处理 | 前端断连不影响子进程（会话由 qwenpaw acp 持有）；子进程崩溃后优雅清理 |

**进程模型**：

```
加载项（WPS taskpane / index.html 页面）
    │ HTTP 短轮询 http://127.0.0.1:8766/acp/{send,poll}
    ▼
acp-bridge（Python 进程，1个，HTTP :8766 + WS :8765；--acp-server 选 adapter）
    │ stdin / stdout（ACP NDJSON，每行一条）
    ▼
ACP server 子进程（1个，由 adapter spawn：qwenpaw acp / opencode acp）
    │ MCP stdio（每 session 注入 env.WPS_POLL_PORT，§13 路线 P 决策）
    ▼
wps-office-mcp（Node.js 子进程，每 session 一个，各自监听独立 poll 端口 WPS_POLL_PORT）
```

> **路线 P（v0.17）**：每个 ACP session 一个 wps-mcp 进程，各自监听**独立 poll 端口**（bridge 集中分配，poll port ↔ session id 映射，见 §5.1.1）。多进程共存是合法状态，不再抢 :58891；残留进程只占资源不再影响功能。

**会话路由（阶段 0.5 实测确认）**：

- 实测确认：单 `qwenpaw acp` 进程支持多会话——`session/new` 两次返回不同 `sessionId`
- 桥接服务不需要自己实现会话管理，只需要**按 sessionId 路由 stdout 消息**到对应前端（HTTP 客户端按 clientId、WebSocket 按连接）
- ACP 方法名格式：`session/new`、`session/load`、`session/prompt`（发消息）、`session/close`、`session/update`（下行通知）等（单数 + 斜杠）
- `session/new` 必填参数：`cwd`（工作目录）+ `mcpServers`（list，不是 dict）
- `session/load`（复用会话）同样必填：`sessionId` + `cwd` + `mcpServers`

**Wire 协议（阶段 0.5 实测定论，ACP v0.12.2）**：

- **帧格式**：NDJSON——每行一条紧凑 JSON-RPC 2.0 消息（`json.dumps(msg, separators=(",",":")) + "\n"`，UTF-8）
- **请求**：`{"jsonrpc":"2.0","id":N,"method":"session/prompt","params":{...}}`
- **响应**：`{"jsonrpc":"2.0","id":N,"result":{...}}` 或 `{"error":{"code":-32602,"message":"...","data":{...}}}`
- **流式下行**：`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":S,"update":{"content":{"text":"...","type":"text"},"sessionUpdate":"agent_message_chunk"}}}`——**无 id 的通知**，每 token 一条；`sessionUpdate` 取值含 `agent_message_chunk`（文本增量）、`available_commands_update`、`usage_update`
- `session/prompt` 的 `prompt` 参数是 **list**：`[{"type":"text","text":"..."}]`；响应 `result.stopReason` 为 `end_turn`/`cancelled`
- 桥接服务**下行路由规则**：带 `params.sessionId` 的通知 → 按 sessionId 路由到对应连接；带 `id` 的响应 → 路由到发起该请求的连接（上行转发时记录 id→conn）；其余 → 广播

**MVP 约束**：

- 单用户单连接：MVP 阶段只有一个 WPS 实例、一个加载项、一个 WebSocket 连接
- 非 session 消息（如初始化消息、错误消息）默认走主连接
- 多连接场景下（如多文档多窗口），可平滑扩展为按 sessionId 路由的多连接模型，**架构不需要改**

**安全性**：

- WebSocket 只绑定 `127.0.0.1`，不暴露到局域网/公网
- 不做鉴权（本机回环 + 单用户场景，安全模型简化）
- 不持久化任何 ACP 消息内容（只在内存中转发）

---

## §4 加载项模块边界（MVP 8 个文件）

### 4.1 文件清单

| 文件 | 职责 | 依赖 |
|---|---|---|
| `manifest.xml` | WPS 加载项清单，声明 ribbon 入口 | 无 |
| `ribbon.xml` | WPS 功能区（QwenPaw AI 标签 + 侧边栏按钮） | 无 |
| `index.html` | 备用入口页（WPS 加载项默认加载，暂不用作主 UI） | `css/taskpane.css` |
| `taskpane.html` | 侧边栏 UI 骨架（通过 acp-bridge HTTP 静态文件服务托管，CreateTaskPane 加载 `http://127.0.0.1:8766/ui/taskpane.html`） | `css/taskpane.css` |
| `css/taskpane.css` | 侧边栏样式 | 无 |
| `js/acp-client.js` | 简化版 ACP 客户端（**HTTP 轮询 transport**，连 acp-bridge `:8766`，见 §3.4） | 零依赖 |
| `js/wps-bridge.js` | WPS JS API 轻量封装（选区/光标查询） | 零依赖 |
| `js/chat-ui.js` | 聊天界面渲染（纯 DOM 操作） | 零依赖 |
| `js/wps-poll-client.js` | 角色 B：连 :58891 拉取/回传命令 | 零依赖 |
| `js/main.js` | 入口胶水层，串起上面四块 | 上述四个 |

> **注**：另含 `bridge/` 目录（acp-bridge.py 桥接服务 + 测试脚本，见 §3.4/§8.2），不属于加载项沙箱内代码，是独立 Python 进程。

### 4.2 模块边界硬约束

- **`acp-client.js` 只懂 ACP 协议**——不知道 WPS 是什么、不知道 DOM 是什么
- **`wps-bridge.js` 只懂 WPS JS API**——不知道 ACP 是什么、不知道聊天 UI 是什么
- **`chat-ui.js` 只懂 DOM 渲染**——不知道协议、不知道文档
- **`wps-poll-client.js` 只懂 wps-office-mcp 的轮询协议**——不知道 ACP 是什么、不知道 UI 是什么
- **`main.js` 是唯一的耦合点**——它知道所有其他模块，但其他模块互不依赖

### 4.3 加载项对外暴露的接口（仅 `main.js`）

- `init()` — 启动加载项，建立 ACP 连接，创建会话
- `sendUserMessage(text)` — 用户发送消息
- `closeSession()` — 文档关闭时调用

### 4.4 加载项消费的接口（来自外部）

- ACP server 地址（在加载项配置里硬编码或从 `manifest.xml` 读取）
- wps-office-mcp 端口（默认 58891，从加载项配置读取）

---

## §5 QwenPaw 侧配置

### 5.1 MCP 客户端配置

wps-office-mcp 通过 **ACP 的 `session/new` mcpServers 动态注入**（每 session 一个，QwenPaw 建 transient driver + spawn 独立 stdio wps-mcp 进程）。**qwenpaw 侧不手动配置 wps-mcp**（v0.17：`drivers/mcp/wps-office-mcp.yaml` 已禁用，防止双份加载）。

**mcpServers 配置（ACP `session/new` 注入，路线 P）**：

```json
{
  "mcpServers": [
    {
      "name": "wps",
      "command": "node",
      "args": ["<仓库根>/third_party/opencode-wps/wps-office-mcp/dist/index.js"],
      "env": [
        { "name": "WPS_POLL_PORT", "value": "<bridge 分配的唯一端口>" }
      ]
    }
  ]
}
```

> **入口路径（submodule 化后）**：opencode-wps 作为 git submodule 固定在 `<仓库根>/third_party/opencode-wps/`，路径可确定。加载项不硬编码本机绝对路径——由 acp-bridge `GET /config` 下发 `wpsMcpEntry`（bridge 依据其 ui_root 解析），`js/main.js` 在 `initTaskpane` 时拉取并填入 mcpServers。`--wps-mcp-entry` 可覆盖。

> **schema 注意（实测）**：ACP `McpServerStdio` 的 `env` 是 **`[{name,value}]` 列表**（`acp/schema.py` `McpServerStdio.env: List[EnvVariable]`），不是 dict；且**没有** `transport`/`type` 字段（http/sse 型才有 `type:"http"|"sse"` + `url`，stdio 靠 `command`+`args`+`env` 判别）。上文早期版本把 env 写成 dict、加 `transport` 字段是**文档笔误**，以这里为准。

> **关键**：`env.WPS_POLL_PORT` 由 **acp-bridge 集中分配**（poll port ↔ session id 映射表），每 session 唯一。QwenPaw 原生支持 mcpServers 的 env 注入 stdio 子进程（`mcp/client/stdio/__init__.py:127`），零 QwenPaw 改动。

> ⚠️ **不要**在 qwenpaw 侧（drivers/mcp/*.yaml 或 agent.json）手动配置 wps-office-mcp——会导致**双份加载**（yaml + ACP 注入各 spawn 一个进程，抢同一端口）。v0.17 决策：**只走 ACP 注入**。

> ~~**目标配置（http，v0.16 决策，已被路线 P 取代）**~~：`type: http` + `url: http://127.0.0.1:18765/mcp` + `headers: []`（需显式 `type:'http'`+`headers:[]`，见 `acp/schema.py` `HttpMcpServer(McpServerHttp)`）。此方案已废弃，仅留档。

### 5.1.1 wps-office-mcp 部署配套（v0.13 强制 + v0.17 路线 P）

**问题**：wps-office-mcp 在 Linux 下默认会强制应用切换——任何有 `requiredApp` 的工具（几乎所有 word/excel/ppt 工具）都会触发 `wps-auto.sh switch <app>` → **pkill 强杀所有 WPS + 重启**。这会破坏用户正在编辑的文档（详见 §12.1 完整根因分析）。

**短期方案（noop 脚本替换）**：

1. 部署 noop 脚本到 wps-office-mcp 期望的固定路径：

   ```bash
   # 复制 noop 脚本（详见 §12.2.2；install.sh 自动完成）
   # <仓库根> 即 wps-qwenpaw-addon 仓库根（submodule 位于其下 third_party/opencode-wps/）
   cp <仓库根>/scripts/wps-auto-noop.sh \
      <仓库根>/third_party/opencode-wps/opencode-wps-linux/wps-auto.sh
   chmod +x <仓库根>/third_party/opencode-wps/opencode-wps-linux/wps-auto.sh
   ```

2. **路径说明**：`linux-poll-server.ts:24-29` 硬编码 `LINUX_SWITCH_SCRIPT = path.join(__dirname, '../../../opencode-wps-linux/wps-auto.sh')`，**wps-mcp 不提供配置开关**，只能替换这个文件
3. **副作用**：opencode-wps 自身的应用切换功能失效。本项目用户不使用 opencode-wps，**无影响**

**长期方案（issue 追踪）**：

- 给 wps-office-mcp 提 issue，建议暴露 `setCurrentApp` 为 `POST /set-current-app` HTTP 端点
- issue 草稿由 discuss agent 在对话中提供，issue 合并后切回标准部署
- **切换步骤**（issue 合并后）：
  1. 删除 noop 脚本（恢复 `opencode-wps-linux/wps-auto.sh`）
  2. 加载项侧在角色 B 接入 :58891 成功后，**调用 `POST /set-current-app: { "app": "word" }`** 预置 currentApp
  3. 验证：端到端测试 wps 工具调用不再触发切换

**v0.17 路线 P 部署（§13 决策，取代 http 化）**：

> noop 脚本替换**仍然需要**——路线 P 只解决多窗口多实例端口冲突，不解决"强制应用切换"。两者独立。

1. **wps-office-mcp 改动（仅 1 行）**：`src/client/wps-client.ts:46`
   ```ts
   const POLL_PORT = Number(process.env.WPS_POLL_PORT) || 58891;
   ```
   - `mac-poll-server.ts:279` `start(listenPort)` 已支持传入端口，只需 wps-client.ts 读 env 后传入
   - 保留默认 58891（env 未设时行为不变，兼容旧部署）
2. **bridge 集中分配端口**（acp-bridge 新增职责）：
   - 维护 `port ↔ session_id` 映射表（如从 59000 起递增分配空闲端口）
   - 每窗口加载项发起 `session/new` 时，bridge 为该 session 分配唯一 `WPS_POLL_PORT`，注入 mcpServers 的 `env`，并记录 `session_id → poll_port`
   - 加载项从 bridge 拿到分配给自己的 poll 端口（session 建立响应或初始化消息），轮询 `http://127.0.0.1:<port>` 而非写死 58891
   - 端口释放：`session/close` 时 bridge 回收端口；进程残留时端口标记可复用（带时间戳防碰撞）
3. **QwenPaw 侧**：零改动（mcpServers env 原生注入子进程）
4. **残留进程**：接受（多进程共存合法，各占独立端口）；可配 cron 清理"父进程已死 + 超时"的孤儿（可选，非必须）
5. **端口段建议**：59000~59999 避开 :8766、:8765、:58891

> ~~**v0.16 http 化部署（已废弃，留档）**~~：曾实现并验证通过——`mcp-server.ts` 加 http transport + fork `index-http.ts` + 手动常驻 `node dist/index-http.js --port 18765` + `scripts/start-wps-mcp-http.sh`（**文件仍在仓库，已废弃勿用**）。因路线 P 侵入更小（1 行 vs http transport）且能解多窗口并发，此方案被取代。仅留档参考。

### 5.2 工具集裁剪（MVP 阶段）

LLM 工具选择准确率随工具数量指数下降，**MVP 只暴露核心工具 + Gateway 兜底**。

**wps-office-mcp 实际暴露的工具盘点**（v1.5.2 实测）：

| 类别 | 工具数 | 说明 |
|---|---|---|
| **直连 MCP 工具** | 14 个 | 启动时通过 `tools/list` 全部暴露给 LLM |
| **Gateway 间接 COM Action** | 250+ | 通过 `wps_office_search` 搜索 + `wps_office_execute` 动态调用 |

**MVP 阶段 LLM 实际可见的工具集**（推荐）：

- **高频直连工具**：从 14 个里挑 ~10 个高频的（具体哪些由 code agent 决定）
- **Gateway 工具**：2 个（`wps_office_search` + `wps_office_execute`）保留兜底，**本就含在 14 个直连内**
- **隐藏工具**：剩余 ~2 个低频直连工具不暴露给 LLM（合计 14 = 2 Gateway + 10 高频 + 2 隐藏）

**实现方式**（实现细节由 code agent 决定，二选一或组合）：

- wps-office-mcp 的环境变量过滤
- QwenPaw 侧 MCP 客户端的工具白名单配置

（**不允许 Fork wps-office-mcp 加白名单**——§6.1 硬约束：外部依赖，零 fork）

### 5.3 ACP Server 配置

QwenPaw 通过 `qwenpaw acp` 命令暴露 ACP agent（**纯 stdio 模式，阶段 0 已实测**；无 WebSocket/HTTP+SSE 服务端，`--port` 参数不存在）。加载项如何连接待 discuss 决策（见 §3.3）。

---

## §6 硬约束（不允许的改动方向）

### 6.1 不允许动的边界

- **不允许修改 wps-office-mcp 源码逻辑**——它作为外部依赖使用，零 fork。**例外（v0.17 §13 决策）**：允许**最小加法改动**——`wps-client.ts:46` 的 `POLL_PORT` 支持环境变量（`const POLL_PORT = Number(process.env.WPS_POLL_PORT) || 58891`，1 行，默认行为不变），以支持路线 P（多实例多端口）。任何其他对 wps-office-mcp 逻辑的修改仍不允许。~~v0.16 曾允许 http transport 加法补丁 + 独立入口文件，已被路线 P 取代~~。
- **不允许修改 QwenPaw 主干**——配置项走标准 MCP 客户端配置；ACP 网络层通过 acp-bridge 外部补，不改 QwenPaw 源码
- **不允许把 wps-office-mcp 跑在非 Node.js 进程**——MVP 接受"装插件的机器要装 Node.js"这个事实
- **不允许绕过 wps-office-mcp 直接调 WPS JS API 做文档操作**——所有文档操作必须经 QwenPaw → MCP → wps-office-mcp 路径，加载项的角色 B 只是 wps-office-mcp 的执行代理
- **不允许在加载项里实现 LLM 调用逻辑**——所有智能体能力走 QwenPaw
- **不允许在加载项里实现记忆系统**——记忆由 QwenPaw 管
- **不允许把加载项的聊天流和 wps-office-mcp 的轮询流混在一个 WebSocket 连接里**——两者协议不同，通道必须独立
- **不允许 acp-bridge 实现任何 ACP 业务逻辑**——桥接服务只做传输层转发（WebSocket ↔ stdio）+ sessionId 路由，不解析消息内容、不修改消息结构、不新增字段
- **不允许 acp-bridge 替代 QwenPaw 做会话管理**——会话创建/加载/销毁全部由 `qwenpaw acp` 负责，桥接服务只按 sessionId 路由消息
- **不允许 acp-bridge 绑定 0.0.0.0 或暴露到局域网**——只绑定 `127.0.0.1`，本机回环场景
- **不允许加载项通过本地文件路径打开 taskpane**——WPS Linux 下 CreateTaskPane 加载本地文件会空白，必须通过 acp-bridge 的 HTTP 静态文件服务加载（v0.8 实测定论）
- **不允许绕过 wps-mcp 应用切换的 noop 脚本替换**——这是 wps-office-mcp 部署的强制配套，缺失会导致 WPS 强杀（详见 §5.1.1、§12.1）。issue 合并后可切回标准部署
- **不接受 opencode-wps 自身功能受损**作为否决 noop 脚本替换的理由——本项目与 opencode-wps 互斥（同一 wps-mcp 进程服务单一 MCP 客户端），本项目用户不使用 opencode-wps

### 6.2 不允许的简化（看起来省事但会埋坑）

- **不允许用单一 WebSocket 连接替代双通道**——ACP 协议不能承载 wps-office-mcp 的轮询协议
- **不允许把加载项的"工具调用"功能暴露给 LLM**——UI 协作类工具和 MCP 文档操作类工具是两套不同来源，加载项不注册自己的工具
- **不允许在加载项里缓存文档内容**——文档状态由 wps-office-mcp 实时管理，加载项不持有副本

### 6.3 允许的扩展方向（MVP 之后）

- **多 ACP server 后端（v0.23 已落地第一个）**：bridge server adapter 抽象（`bridge/servers.py`）支持 `--acp-server qwenpaw|opencode`；opencode 已可 spawn/建会话/对话/agent 枚举。后续可加 kilocode（待其配置修复）、更多 server；Phase 2 前端按能力标志适配协议偏好（审批/看门狗/中止/load），Phase 3 UI 配置化
- 添加 Excel/PPT 工具（MCP 侧挂更多工具）
- 添加 Mac/Windows 支持（wps-office-mcp 已支持，验证即可）
- 添加撤销/重做 UI（QwenPaw 会话记忆 + 加载项 UI）
- 添加文档对比/版本控制
- 把加载项打包成独立 .deb/.AppImage 分发

---

## §7 验收测试方向

### 7.1 单元测试

- `acp-client.js` 的连接、重连、错误处理
- `wps-poll-client.js` 的轮询循环、命令执行、结果回传
- `wps-bridge.js` 的选区查询（在不同 WPS 状态下）

### 7.2 集成测试

- 完整流程：用户输入 → ACP 到 QwenPaw → QwenPaw 调 MCP → wps-office-mcp 推 :58891 → 加载项执行 → 结果回报 → QwenPaw 流式返回
- 多文档并发：同时打开两个 Word 文档，两个会话独立
- 错误恢复：wps-office-mcp 进程崩溃后的重启行为

### 7.3 端到端验收（人工或脚本）

| 场景 | 期望 |
|---|---|
| 打开空文档，发"你好" | AI 回复问候语 |
| 输入"把'foo'改成'bar'" | 文档中所有"foo"被替换为"bar" |
| 输入"把第三段加粗" | 文档第三段字体加粗 |
| 选中一段文字，发"把这段润色一下" | 选中段落被改写 |
| 关闭文档，重新打开同文档 | 按 docId 恢复 QwenPaw 侧会话历史（加载项运行态已清理，见 G6） |
| 关闭文档，打开新文档 | 创建新会话，无历史污染 |

### 7.4 已知风险点

- **WPS Linux 沙箱对 `localhost:58891` 的访问限制**——MVP 阶段要先实测，限制可能因 WPS 版本而异
- **:58891 懒启动行为**——wps-office-mcp 默认不监听 :58891，第一次调 WPS 操作工具时才启动轮询服务器。加载项轮询客户端必须带退避重连逻辑
- **`wps_check_connection` 在 Linux 下是"进程级"检查**——只扫描 WPS 主进程是否存活，不验证加载项是否真的接入了 :58891。不能用它判断"轮询桥已连接"
- **wps-office-mcp 在 Linux 下的稳定性**——Node.js 进程崩溃后的行为需验证
- **MCP 工具集裁剪的实现方式**——具体走 wps-office-mcp 的环境变量还是 QwenPaw 侧过滤，由 code agent 决定
- **空文档误报**——没有加载项接入时，`getDocumentText` 等工具可能返回"空文档"而非明确报错。阶段 0 验证时要用加载项侧的实际结果为准，不能只看工具返回值非空就认为通了
- **ACP 传输层不确定性（v0.4 已实测定论）**——`qwenpaw acp` 为纯 stdio，QwenPaw **无**网络 ACP server。这是**架构层冲突**（§3.3），需回 discuss agent 决策，直接影响 `acp-client.js` 整个设计
- **WPS Linux 加载项加载与网络权限机制（v0.4 已实测）**——`authwebsite.xml` 是 allowedOrigins 等价机制；**加载项需打开文档后才启动 CEF 加载项引擎**（`libjsapibrowser.so` + `promecefpluginhost`）。没打开文档时加载项不加载、命令会超时
- **会话持久化语义**——G6 要求关闭即清理加载项运行态，§7.3 要求重开同文档恢复历史：二者通过"QwenPaw 侧按 docId 持久化会话历史 + 加载项内存态清理"调和（§3.2 不变量）

---

## §8 阶段划分与停止门

### 8.1 阶段 0：环境验证（必须先做）——✅ 已完成（2026-08-28）

**目标**：在动手写加载项代码之前，先把"沙箱能连 :58891"这个核心前提验掉。

**实测结果**：

- ✅ **:58891 懒启动 + 回环打通**：通过 QwenPaw app 触发 `ai-developer` agent 调 `wps_get_active_document`，wps-office-mcp 懒启动 :58891（`ss -tlnp` 确认 `127.0.0.1:58891` 监听）。回环验证成功：`wps_office_execute("getDocumentText")` 返回真实文档内容 `foo\nThis is paragraph two for phase0 test.`（43 字符），`wps_get_active_document` 返回 `{paragraphCount:2, wordCount:11}`——**非空文档误报排除**
- ✅ **轮询协议逆向完成**：端点/结构/超时/去重/退避已固化到 §3.3
- ✅ **manifest 加载机制验证**：`authwebsite.xml`（授权 `127.0.0.1:58891`）是 WPS 的 allowedOrigins 等价机制；`jsplugins.xml` + `publish.xml`（`enable_dev`）+ `authaddin.json` 完成注册；**关键：必须打开文档才会启动 CEF 加载项引擎**
- ✅ **QwenPaw MCP 挂载验证**：`ai-developer` agent 的 `drivers/mcp/wps-office-mcp.yaml`（stdio node dist/index.js）生效，tools=40；14 个 wps 直连工具全部 `enabled`（与 §5.2 盘点一致）；Gateway `wps_office_search`/`wps_office_execute` 可用
- ⚠️ **ACP 传输层冲突（架构层，待 discuss）**：`qwenpaw acp` 是纯 stdio，QwenPaw 无网络 ACP server，§3.3 原"ACP over WebSocket :8765"不成立。见 §3.3 警告

**阶段 0 测试记录（2026-08-28，按时间顺序）**：

> 环境：Linux aarch64（Kylin V10 SP1），WPS Office **12.8.2.20327**，wps-office-mcp v1.5.2，QwenPaw server 2.1.0（`ai-developer` agent 挂载 wps-office-mcp）。测试文档 `/tmp/kilo/phase0/test_doc.docx`（内容：`foo` + `This is paragraph two for phase0 test.`）。WPS 加载项 `opencode-wps-linux` 已安装于 `~/.local/share/Kingsoft/wps/jsaddons/opencode-wps-linux_/`。

| # | 操作 | 观察 | 结论 |
|---|---|---|---|
| P1 | `qwenpaw task --agent-id ai-developer --no-guard -i "调用 getActiveDocument"` | 日志 `tools=0`，agent 回复"无 wps 工具" | ❌ **headless task 模式不挂 MCP 工具**，改走 app 模式 API |
| P2 | `POST /api/console/chat/task`（`X-Agent-Id: ai-developer`）→ 审批 `POST /api/approval/approve` | 日志 `builder: tools=40`；审批 556bcd5b 批准后 `ss -tlnp` 见 `127.0.0.1:58891` 监听（pid=wps-office-mcp） | ✅ **app 模式挂 MCP 工具 + :58891 懒启动确认** |
| P3 | WPS 仅启动、**未打开文档**时调 `wps_get_active_document` | `GET /status` 回 `hasPendingCommand:true` 持续 → 命令 **10s 超时**；`wps_execute_method("getDocumentText")` 回 `method "getDocumentText" is not allowed. Only Application.ActiveDocument / ActiveWorkbook / ActivePresentation are permitted` | ❌ **加载项未接入**（无文档→无 CEF 加载项引擎）+ **execute_method governance 白名单限制** |
| P4 | 打开 `test_doc.docx` 后调 `wps_get_active_document` | WPS 生成 CEF 子进程（`libjsapibrowser.so` + `promecefpluginhost` renderer）；`/status` 首次轮询即 `hasPendingCommand:false`（命令被消费）；工具回 `{"name":"test_doc.docx","path":"/tmp/kilo/phase0/test_doc.docx","paragraphCount":2,"wordCount":11,"characterCount":43}` | ✅ **回环打通**；加载项须有打开文档才加载 |
| P5 | `wps_office_search` 搜索 `getDocumentText` | 回 `{"total":2,"results":[{"name":"getDocumentText","category":"word","appType":"wps","params":{...}},{"name":"getDocumentTextByRange",...}]}` | ✅ **Gateway 工具可用**（wps_office_search → wps_office_execute 两阶段） |
| P6 | `wps_office_execute(tool_name="getDocumentText", arguments={})` | 回 `文档文本内容 (43字符): foo\nThis is paragraph two for phase0 test.` | ✅ **完整回环返回真实文档内容**（非空误报排除，§7.4 风险验证） |

**附注**：`wps_execute_method` 直连工具受 governance 白名单限制（只放行 3 个顶层属性），文档内容获取/编辑必须走 `wps_get_active_document` 或 Gateway `wps_office_execute`——这条已反映在 §3.3 与 §5.2 的工具使用约束中。

**触发 WPS 工具调用的可行路径（供后续阶段参考）**：

- QwenPaw app HTTP API `POST /api/console/chat/task`（`X-Agent-Id: ai-developer`）+ `POST /api/approval/approve`
- `policy.default_effect: ask` 使每次 MCP 工具调用**需人工审批**（走 `/api/approval/list` + `/api/approval/approve`）——MVP 阶段需把 wps 工具 policy 改为 `allow` 或处理审批流
- `wps_execute_method` 受 governance 白名单限制：只放行 `ActiveDocument`/`ActiveWorkbook`/`ActivePresentation`；文档内容/编辑须走 `wps_get_active_document` 或 Gateway `wps_office_execute(tool_name=...)`

**停止门**：

- ✅ 能连通 + 能拿到真实文档内容 → **满足（阶段 0.5 已完成）**
- ✅ ACP 传输层冲突 → **已通过 discuss agent 决策解决**（方向 A：acp-bridge 桥接服务，阶段 0.5 已实现并验证通过，见 §3.4/§8.2）
- 不能连通 → 回到 discuss agent 重新讨论（未发生）
- 能连通但拿到空内容 → 检查 WPS 里是否真的有打开的文档，或者加载项是否真的接入了（实测中曾遇到：WPS 未打开文档时加载项不加载、命令超时——**先打开文档再触发**即解决）

**风险**：如果沙箱禁 loopback，需要修改 wps-office-mcp 监听地址 + 加载项 manifest 配置网络权限（`allowedOrigins` 为 Chrome 扩展概念，WPS 的等价机制是 **`authwebsite.xml`**，已实测验证）

### 8.2 阶段 0.5：ACP 桥接服务——✅ 已完成（2026-08-28）

**目标**：实现 `bridge/acp-bridge.py`，打通"加载项 WebSocket → 桥接服务 → qwenpaw acp stdio → 回复原路返回"的 ACP 通道。加载项侧用简单的测试 HTML/JS 验证，先不做正式 UI。

**交付物**：

- `bridge/acp-bridge.py` — Python 桥接服务（WebSocket server :8765 + spawn qwenpaw acp 子进程 + NDJSON 双向转发 + sessionId/请求 id 路由 + 子进程崩溃重启）
- `bridge/test_bridge.py` — Python 自动化端到端验证脚本
- `bridge/test-page.html` — 浏览器手动测试页（连接/session/new/load/close/发消息）

**阶段 0.5 测试记录（2026-08-28）**：

> 环境：acp-bridge（Python 3.12 / websockets 15.0.1）+ `qwenpaw acp --agent default`（QwenPaw 2.1.0）。wire 协议细节见 §3.4。

| # | 操作 | 观察 | 结论 |
|---|---|---|---|
| W1 | ws://127.0.0.1:8765 连接 + `initialize` | 回 `{agentCapabilities, agentInfo, protocolVersion}` | ✅ 传输层打通 |
| W2 | `session/new`（cwd + mcpServers:[]） | 回 `sessionId`（如 `1c8213d8...`） | ✅ 会话创建；单进程多会话（连发两次 ID 不同） |
| W3 | `session/prompt` 发"用一句话自我介绍" | 流式回 `session/update` 通知（`agent_message_chunk`，每 token 一条）+ 最终 `result.stopReason=end_turn` | ✅ 发消息 + 流式输出 |
| W4 | 断连 → 重连 → `session/load`（sessionId+cwd+mcpServers）→ 再发消息 | `session/load` 回 `{_meta:{...}}`；重连后 agent 记得上文（"你让我用一句话自我介绍"） | ✅ 会话不随 WS 断连丢失（qwenpaw acp 持有） |
| W5 | kill qwenpaw acp 子进程 | bridge 检测退出，自动 spawn 新子进程（父进程=bridge），重启后 `session/new` 正常 | ✅ 子进程崩溃自动重启 |
| W6 | `session/close` | 回 `{}`，正常关闭 | ✅ 会话销毁 |

**实测修正**：文档 v0.5 中 `session/message` 应为 **`session/prompt`**；`session/load` 需 `cwd` + `mcpServers`（同 session/new）；流式是 `session/update` 通知而非 SSE。

**验收标准（停止门）——全部通过**：

- ✅ 连 `ws://127.0.0.1:8765` 成功
- ✅ 发 `session/new` → 返回有效 sessionId
- ✅ 发消息 → 收到 AI 回复（非空、非错误）
- ✅ 关闭 WebSocket 再重连 → 能继续使用已有 session（`session/load` 复用，会话由 qwenpaw acp 持有）
- ✅ 杀掉 qwenpaw acp 子进程 → 桥接服务检测到并自动重启（有日志）

**进入阶段 1**：以上 5 条全过，可进入阶段 1（加载项骨架 + acp-client.js 集成）。

### 8.3 阶段 1：最小可跑（端到端骨架）——🚧 进行中（代码 + HTTP 侧已验证，剩 WPS 实机内侧边栏验收）

**已完成（代码 + 桥接侧验证）**：

1. ✅ 加载项文件全部实现：manifest.xml / ribbon.xml / index.html（入口页）/ taskpane.html / css/taskpane.css / 5 个 js 模块
2. ✅ `acp-client.js` 用 HTTP 轮询 transport（连 acp-bridge `:8766`）——因阶段 1 实测 WPS 沙箱拦截 WebSocket
3. ✅ `wps-poll-client.js` 角色 B：连 :58891 拉取/回传（handler 已实现 ping/getActiveDocument/getSelectedText）
4. ✅ `acp-bridge.py` HTTP 前端 `:8766` **Python 侧端到端验证通过**：`/acp/send` initialize→session/new→session/prompt → `/acp/poll` 收流式 → close
5. ✅ 加载项已安装到 `~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/`（含 publish/jsplugins/authwebsite 注册）
6. ✅ **WPS 加载项引擎已恢复**——ribbon 按钮可响应 alert，CreateTaskPane 可创建窗格
7. ✅ **CreateTaskPane 加载方式实测定论**——本地文件路径空白，HTTP URL 正常（v0.8，见 §3.3）
8. ✅ **acp-bridge.py 静态文件服务落地**（v0.9）——HTTP 前端 `:8766` 新增 `/ui/*` 端点，托管加载项 UI 文件（根目录=插件仓库根，`--ui-root` 可覆盖，目录穿越防护 + MIME 映射 + CORS）
9. ✅ **main.js CreateTaskPane URL 定稿**（v0.9）——`getTaskPaneUrl()` 返回 `http://127.0.0.1:8766/ui/taskpane.html`；`OnStatusClick` 诊断 URL 同步
10. ✅ **HTTP 侧端到端验证通过**（v0.9，起真实 qwenpaw acp 子进程）：`/ui/*` 静态服务 200/404/穿越拦截全过；ACP 轮询链路 `initialize → session/new → session/prompt 流式 → session/close` 全通

- **WPS 崩溃问题（v0.12 定位 → v0.13 解决）**：根因 = wps-office-mcp 强制应用切换（`wps-auto.sh` 强杀重启），任何 word 类工具都会触发。**解决方案**：用 noop 脚本替换 `opencode-wps-linux/wps-auto.sh`（详见 §5.1.1）。noop 脚本部署后，WPS 实机内侧边栏验收可继续进行

**待完成**：

- ✅ **noop 脚本已部署**（v0.13，2026-09-03 复核）：`opencode-wps-linux/wps-auto.sh` 已是 noop 版本（§5.1.1）
- ✅ **路线 P 代码落地**（v0.17，2026-09-03）：wps-mcp `WPS_POLL_PORT` env（1 行，已 build）+ bridge 集中分配端口（`/poll-port/*` + session/new 注入 + close 回收）+ main.js stdio mcpServers + WpsPollClient 轮询分配端口；Python 侧端到端验证通过（见 §0 v0.17 实施记录）
- 🚧 **端到端验收（路线 P）**：WPS 实机重开侧边栏 → 加载项分配端口 → 发消息 → ACP → AI 回复（人工：需 WPS + 打开文档 + acp-bridge 运行中）；验证多窗口并发各用独立端口、命令不串台

**阶段 1 期间的实测发现（按时间顺序）**：

- **WPS Linux 加载项入口页是 `index.html`**（WPS 自动加载，须逐个 `<script>` 加载模块），非 taskpane.html——已按此补 index.html
- **WPS Linux 沙箱拦截 WebSocket**（:8765 无连接尝试），只放行 HTTP（:58891 已证）→ ACP 传输层改 HTTP 短轮询（§3.3/§3.4）
- WPS 加载项引擎（CEF）因清缓存操作损坏过，现已恢复
- ✅ **CreateTaskPane 可用性定论（v0.8）**：API 存在、能创建窗格、但本地文件路径空白 → 通过 HTTP 托管解决（acp-bridge 加静态文件服务）

**停止门**：能完成"问 AI 一个问题、AI 回答"这条最小链路（WPS 内侧边栏 → acp-bridge → qwenpaw acp → 回复）。

### 8.4 阶段 2：编辑能力（核心功能）

- **加载项编辑命令已实现（v0.18，2026-09-03）**：`wps-bridge.js` 新增完整编辑命令集（插入/查找替换/取文本/取段落/字体/颜色/段落/行距/表格/页眉页脚/分节符/页面设置/书签/批注/图片/样式/目录/文档管理/保存/另存/打开/选区替换/单元格读写/演示信息/execute_method 白名单路径），`onPollCommand` 改为分发器；数据契约与 wps-office-mcp 工具对齐（Node 模拟测试 43 项通过）
- 任务清单（待 WPS 实机验证）：
  1. 验证 wps-office-mcp 的 find_replace 工具能跑通
  2. 验证 set_selected_text 工具能跑通
  3. 验证选区感知链路（用户在 WPS 选中文字 → QwenPaw 知道）
- **停止门**：用户说"把'foo'改成'bar'"能真的改成功

### 8.5 阶段 3：体验打磨（MVP 验收）

> **已独立为文档**：`docs/DEV-PLAN-Phase3.md`（2026-09-03，v1.3）——打磨项统一清单 P1-P15（用户反馈 9 项 + 前端打磨方向 A-G 直接整合 + 用户补充 P14 清除对话历史 / P15 历史对话加载）+ 后续多 ACP 后端计划 + 待验证项 V1-V7 + UX 验收标准 UX1-UX15；来源追踪见该文档 §2。
> 本小节仅保留进度状态。

- **任务清单**：见 `docs/DEV-PLAN-Phase3.md` §1（P1-P15）+ §4 优先级
- **停止门**：§2.1 的 G1-G6 全部满足 + DEV-PLAN-Phase3.md §5 的 UX1-UX15
- **进度**（2026-09-03）：
  - ✅ **批 1**（commit e2733b6）：P1/P2/P4/P5（状态合并/中断恢复/过程呈现/中止）
  - ✅ **批 2**：P3（agent 选择，bridge `/agents`+`/agent/set`）、P8（文档隔离 docId）、P10（Markdown 渲染，`js/markdown.js`）、P12（视觉）、P15（历史缓存 + session/load）
  - ✅ **批 3**：P6（附件文本降级 + 粘贴占位，V1 已核实无多模态）、P7（尽力自动展开）、P11（操作结果反馈）、P13（/clear）、P14（清空对话按钮）
  - ✅ **批 2/3 审查加固**：P8 doc 检测改轻量 `WpsBridge.getDocIdentity`（§3.2 会话按文档隔离的实现配套，避免周期检测触发重计数）；P7 自动展开只增不减；agent 切换清理 docStates 残留 sessionId；桥 switch_agent 复位重启退避
  - 🚧 **待 WPS 实机验收**：批 2/3 FE 改动端到端；P9 实机确认 V4（manifest 已含 wps/et/wpp hosts）
- **待验证项更新（2026-09-03 批 2/3 实施中核实）**：V1（QwenPaw ACP 无多模态，`_extract_text` 只取 text 块）→ P6 已按文本提取降级落地；V7（ACP 无 `session/clear`）→ P14 用 `session/close`+`session/new`；P3 用 `qwenpaw agent list` 作为 agent 列表来源

---

## §9 跨阶段约束

- **任何阶段发现问题，先暂停回到 discuss agent**，不要自行修改 §3 的架构层决策
- **每个阶段结束前必须做完整端到端测试**，不能跳过
- **所有改动必须在 Linux 实机验证**，不能只靠代码 review
- **不允许"为了跑通"修改 §6 的硬约束**——如需调整，回到 discuss agent

---

## §10 附录：决策历史摘要

为防止"上下文丢失"导致 code agent 重提已被否决的方向，记录关键决策如下：

| 决策 | 选择 | 否决的方案 | 否决理由 |
|---|---|---|---|
| 通信协议分层 | ACP 管对话 + MCP 管文档 | 全走 ACP | ACP 协议语义不覆盖 wps-office-mcp 内部执行 |
| 智能体后端 | QwenPaw | dumb LLM 直连 | 浪费记忆、技能、工具调用循环等已有能力 |
| 加载项实现 | 单进程双角色 | 双加载项 | 用户体验差、装两个麻烦 |
| WPS 操作入口 | wps-office-mcp | 自己调 WPS JS API | 已有 250+ 工具的成熟方案 |
| MCP Server 部署 | QwenPaw stdio 自动拉起（v0.2~v0.17）→ **v0.17 路线 P：每 session 独立 wps-mcp + 独立 poll 端口** | ~~http 化 + 手动常驻（v0.16 曾选）~~ | v0.16 因残留根因曾选 http 化（qwenpaw 不清理 stdio 子进程）；v0.17 发现多窗口并发（90%+ 场景）下 http 化不解命令串台，路线 P（每实例独立端口）侵入更小且原生解多窗口，取代 http 化（详见 §13） |
| MCP 传输层 | **stdio + env.WPS_POLL_PORT（v0.17 路线 P）** | ~~streamable http（v0.16 曾选）~~ / MCP http 桥（方案 B） | stdio 一对一管道无法多客户端共享 + 残留；但路线 P 让多进程共存合法化（各占独立端口），残留降级为资源堆积；http 化只解抢端口不解命令串台；http 桥多一层转发且协议转换工作量大（§13.3/13.4） |
| 工具集规模 | MVP 14 个直连中挑 ~10 高频直连 + 2 个 Gateway（含在 14 内）+ 2 隐藏 | 全量 250+ | LLM 工具选择准确率随数量指数下降（v0.2 实测修正：原估 30 个，实际只有 14 个直连） |
| 平台优先级 | Linux 先 | 三平台并行 | 实机环境约束 |
| 文档类型优先级 | Word 先 | 三类同时 | MVP 跑通再扩展 |
| 加载项轮询客户端重连策略 | 必带退避（懒启动友好） | 一启动就死等 | :58891 懒启动特性（v0.2 实测发现） |
| "加载项已连接"判定 | `ss -tlnp` 看 58891 + 实际工具返回非空 | `wps_check_connection` | Linux 下 check_connection 是进程级检查，不验证轮询桥连通（v0.2 实测发现） |
| ACP 传输层 | **纯 stdio，无网络 server（v0.4 实测定论）** | WebSocket :8765 | 实测 `qwenpaw acp` 为 stdio；QwenPaw 无 WebSocket/HTTP+SSE ACP 服务端，加载项无法连接，需回 discuss（v0.3 提出疑点，v0.4 实测定论） |
| ACP 桥接方案 | **acp-bridge（Python，同仓，纯转发）**，方向 A | 方向 B（走 app 8088 HTTP API）/ 方向 C（改 QwenPaw 源码）/ 方向 E（不用 ACP） | 方向 A 不改 QwenPaw 源码、保留 ACP 协议栈便于未来换 server、传输层干净、工作量可控（单文件 ~150 行）。方向 B 绕开 ACP 协议栈，将来换 ACP server 全部重写；方向 C 动主干违反 §6.1；方向 E 丢了 ACP 的标准化价值 |
| 桥接服务语言 | **Python** | Node.js | 跟 QwenPaw 同语言栈，减少依赖种类；WebSocket 库成熟 |
| 桥接服务存放 | **插件仓库 `bridge/` 目录** | 独立仓库 / 安装到系统 | 同生命周期、同部署包、一起启停；用户不需要额外安装 |
| 桥接进程模型 | **单进程单子进程（1 个 acp-bridge + 1 个 qwenpaw acp）** | 每连接 spawn 一个 qwenpaw acp | 实测单 qwenpaw acp 支持多会话，会话管理交给 QwenPaw；桥接服务只做路由，保持轻薄 |
| ACP 会话路由 | **按 sessionId 路由，桥接不做会话管理** | 桥接服务自己建会话表 | 会话是 ACP 协议层概念，交给 qwenpaw acp 原生实现更可靠；桥接只做传输，不碰业务 |
| ACP 方法名格式 | **`session/new`、`session/load`、`session/prompt` 等（单数 + 斜杠）** | `sessions.list` / `sessions/list` / `session/message` 等 | 实测 `session/new`/`session/load`/`session/prompt`/`session/close` 均有效；`sessions.list` 返回 Method not found（v0.5 误写 `session/message`，v0.6 实测应为 `session/prompt`） |
| session/new 必填参数 | **`cwd` + `mcpServers`（list）** | 不传 / 只传部分 | 实测缺 `cwd` 报错；`mcpServers` 必须是 list 不是 dict |
| ACP 帧格式 | **NDJSON（每行一条紧凑 JSON-RPC 2.0）** | content-length 分帧 / SSE | 实测 qwenpaw acp 用 `readline` + `json.loads`，发送用 `json.dumps(separators=(",",":"))+"\n"`（v0.6 实测） |
| ACP 流式输出 | **`session/update` 通知（无 id，带 sessionId），每 token 一条 `agent_message_chunk`** | SSE / 单次完整响应 | 实测 `session/prompt` 期间 qwenpaw 连续下发 `session/update` 通知，最终以 `result.stopReason` 收尾（v0.6 实测） |
| ACP 传输层（加载项侧） | **HTTP 短轮询连 acp-bridge :8766（/acp/send + /acp/poll）** | WebSocket :8765 | v0.7 实测：WPS Linux 沙箱拦截 WebSocket（taskpane `new WebSocket('ws://127.0.0.1:8765')` 无连接尝试），只放行 HTTP（:58891 已证）；HTTP 短轮询与 :58891 同机制，WPS 已验证支持 |
| CreateTaskPane 加载方式 | **acp-bridge HTTP 静态文件托管（:8766/ui/*）** | 本地文件路径 / 外部浏览器方案 | v0.8 实测：本地文件路径（相对/绝对）加载后窗格空白，HTTP URL 完全正常；acp-bridge 已有 HTTP 前端，加静态文件服务成本低且同源无 CORS；优于外部浏览器方案（保留内嵌侧边栏体验） |
| WPS 崩溃短期方案 | **noop 脚本替换 `wps-auto.sh`**（v0.13） | 改 wps-mcp 源码（违反零 fork）/ 完全不操作 WPS（丢失功能） | wps-mcp 强制应用切换是设计问题，零 fork 约束下只能绕外圈；setCurrentApp 已存在但无 HTTP 接口 = 作者预留扩展点；`switchScriptPath` 硬编码无法配置，文件替换是唯一非 fork 路径；用户不用 opencode-wps，opencode 功能受损无影响 |
| WPS 崩溃长期方案 | **issue 追踪：暴露 setCurrentApp 为 POST /set-current-app HTTP 端点**（v0.13） | 维护 wps-mcp fork / 加 SWITCH_APP_DISABLED 环境变量 / 接受持续 WPS 崩溃 | 杠杆方向对：只建议一个聚焦改动（顺势暴露作者已预留的 setCurrentApp 入口），issue 被采纳概率高；不加环境变量避免分散焦点（作者会问"setCurrentApp 不就够了？"）；issue 合并后可切回标准部署 |
| 侧边栏方案 | **WPS 内嵌 CreateTaskPane + HTTP 托管 UI** | 外部浏览器（类 opencode） | 内嵌体验更好（用户不用切换窗口）；acp-bridge 已有 HTTP server，加静态文件服务增量小；外部浏览器作为备选方案 |

---

## §11 文档维护

- 本文档由 discuss agent 维护，任何架构层调整需回到 discuss agent 重启讨论
- code agent 实施过程中如发现本文档某条约束不可行，**先回到 discuss agent**，不要自行绕过
- 本文档当前版本 v0.17，下次更新需在 §0 的变更历史里加一行

---

## §12 关键发现与 issue 追踪

> 本节沉淀**架构层关键发现**和**外部 issue 状态**，作为项目"技术债务 + 上游沟通"的追溯档案。
> 新发现用 "FINDING-YYYYMMDD-NN" 编号；issue 用 "ISSUE-YYYYMMDD-NN" 编号。

### 12.1 FINDING-20260903-01：WPS "崩溃" 根因完整链路

**现象**（v0.12 实测，可 100% 复现）：

- 简单对话正常；一旦 AI 决定调 wps 工具（如 `getActiveDocument`），WPS 进程消失 / 用户文档被强杀 / 新 WPS 打开 `opencode_auto_blank_*.docx` 时 Qt 初始化 SIGSEGV
- 复现链路：用户发消息 → QwenPaw agent loop 决定调 wps 工具 → wps-office-mcp 收到工具调用 → 执行 `wps-auto.sh switch word` → **pkill 强杀所有 WPS** → 重启 → 看到"崩溃"
- 桥接侧调试日志（v0.11 落地）显示：加载项角色 B 168 次轮询失败、0 次收到命令——**角色 B 从未接入 :58891**（是结果不是原因：WPS 被杀后新实例加载项未接入）

**根因链**（基于 `opencode-wps/wps-office-mcp/src/client/mac-poll-server.ts` 源码）：

```
[1] PollServer 构造：private currentApp: string = '';    // 初始空字符串 (line 242)
[2] 加载项轮询接入：PollServer 没有"接入时更新 currentApp"逻辑
[3] setCurrentApp(app: string): void 存在且是 public      // line 670
    但 grep 全文：wps-office-mcp 内部无任何调用者
[4] currentApp 唯一更新点：switchApp 成功后 this.currentApp = app;  // line 631
[5] executeCommand 检查：if (requiredApp && requiredApp !== this.currentApp)  // line 534
    由于 currentApp 恒为 ''，几乎所有 word/excel/ppt 工具都触发切换
[6] switchApp：execFile(switchScriptPath, ['switch', app], { timeout: 60000 })
    + setTimeout(resolve, 2000)  // 强制等 2s 让加载项连
[7] Linux 版：LINUX_SWITCH_SCRIPT = path.join(__dirname, '../../../opencode-wps-linux/wps-auto.sh')
    这是硬编码常量，无环境变量/配置文件覆盖
[8] wps-auto.sh switch word 执行：
    → close_all: pkill -f wps / wpspdf / wpsoffice  ← 强杀所有 WPS
    → start_app: 启动新的 wps writer                ← 重启
    → switch_to: pgrep 轮询直到新 WPS 出现
```

**核实前提表**（v0.13 4/4 完成）：

| 前提 | 结论 | 证据 |
|---|---|---|
| `currentApp` 只在 `switchApp` 成功后更新？ | ✅ 是 | `mac-poll-server.ts:242/631` + 全文 grep 无其他赋值 |
| `setCurrentApp` 有内部调用者吗？ | ❌ 无（public 仅供外部） | `mac-poll-server.ts:670` + 全文 grep |
| 有禁用切换的配置开关？ | ❌ 无（`switchScriptPath` 只是路径） | `mac-poll-server.ts:255-257` 构造函数 + 全文 grep |
| Gateway 工具会触发切换吗？ | ✅ 会（最终走 `execLinuxPoll`） | `wps-client.ts:196` → `mac-poll-server.ts:534` |

**关键推论**：

1. **零 fork 约束下无法根治**：改 `setCurrentApp` 调用链 / 加环境变量 / 暴露 HTTP 端点 都需要改 wps-mcp 源码
2. **`setCurrentApp` 存在但无外部入口 = 作者预留了扩展点**：从源码设计意图看，作者考虑过"外部预置 currentApp"这个需求（公开方法 + 无内部调用者），只是没把入口暴露成 HTTP
3. **Linux 版是 Mac 版的 31 行适配**（`linux-poll-server.ts`），切换逻辑全在 `mac-poll-server.ts`——所以这个 issue 不仅是 Linux 问题，是 Mac 版设计假设"opencode app 管理 WPS 生命周期"在多客户端场景下的局限性

### 12.2 D++ 方案落地步骤

#### 12.2.1 短期：noop 脚本替换

**原理**：替换 `wps-auto.sh` 为空操作脚本，让 `switchApp` "假成功"——`currentApp` 被赋值为 `app`，之后所有同类型命令都不再触发切换。

**noop 脚本**（`/data/myrepo/wps-qwenpaw-addon/scripts/wps-auto-noop.sh`）：

```bash
#!/bin/bash
# Noop script for wps-office-mcp on Linux.
# 原因：WPS-qwenpaw-addon 部署下，WPS 由用户手动管理。
# wps-mcp 的强制应用切换会 pkill 强杀用户已打开的 WPS，破坏工作流。
# 见 docs/ARCHITECTURE.md §12.1 完整根因分析。
#
# 长期方案：wps-mcp issue 合并后切回标准部署（见 §12.3）。
case "$1" in
  switch|start) exit 0 ;;
  *) echo "noop: $*" >&2; exit 0 ;;
esac
```

**部署命令**：

```bash
# 1. 复制到 wps-mcp 期望的固定路径（hardcoded in linux-poll-server.ts:24-29；install.sh 自动完成）
#    <仓库根> 即 wps-qwenpaw-addon 仓库根（submodule 位于其下 third_party/opencode-wps/）
cp <仓库根>/scripts/wps-auto-noop.sh \
   <仓库根>/third_party/opencode-wps/opencode-wps-linux/wps-auto.sh
chmod +x <仓库根>/third_party/opencode-wps/opencode-wps-linux/wps-auto.sh
```

**延迟成本分析**：

- `execFile` 启动开销：~50-100ms
- noop 脚本执行：~1ms
- 强制 `setTimeout(resolve, 2000)`：2s
- **总延迟约 2-3s**（只发生在 wps-mcp 进程启动后第一次工具调用），远小于真实切换的 20-30s

**副作用清单**：

| 副作用 | 严重程度 | 备注 |
|---|---|---|
| opencode-wps 应用切换功能失效 | 🟡 中 | 本项目用户不用 opencode-wps，无影响 |
| 跨应用命令（用户在 Word 里调 Excel 工具）"假切换"后失败 | 🟢 低 | 本来就该失败，无副作用 |
| `/status` 端点返回假的 `currentApp` | 🟢 无 | 仅显示信息 |
| 失败重试逻辑不触发（因为"假成功"） | 🟢 无 | 期望行为 |

**回滚**：

```bash
git -C /data/myrepo/opencode-wps checkout -- opencode-wps-linux/wps-auto.sh
# 或重新 git clone opencode-wps 仓库
```

#### 12.2.2 长期：issue 合并后切回标准部署

**触发条件**：wps-mcp 仓库合并了 §12.3 issue 中的建议实现。

**切换步骤**：

1. 删除 noop 脚本（恢复 `opencode-wps-linux/wps-auto.sh`）
2. 加载项侧在角色 B 接入 :58891 成功后，**调用 `POST /set-current-app: { "app": "word" }`** 预置 currentApp
3. QwenPaw MCP 客户端配置加 `env: ["SWITCH_APP_DISABLED=1"]`（如果 issue 实现了这个环境变量）
4. 验证：端到端测试 wps 工具调用不再触发切换

### 12.3 外部 issue 追踪（不写完整内容，issue 草稿由 discuss agent 在对话中提供）

> 设计文档只归档**根因 + 方案 + 落地步骤**（§12.1/§12.2），不重复 issue 内容。
> Issue 是给上游维护者看的对外材料，提交后会变化，不适合在文档里维护双源真相。

| 编号 | 标题 | 状态 | 链接 |
|---|---|---|---|
| ISSUE-20260903-01 | wps-office-mcp：暴露 `setCurrentApp` 为 `POST /set-current-app` HTTP 端点 | 待用户提交 | （提交后填） |

**Issue 核心要点摘要**（用于对话中沟通，不在文档里维护完整正文）：

- **问题**：wps-mcp 强制应用切换会 pkill 强杀用户 WPS，破坏工作流
- **根因**：`currentApp` 初始为空 + `setCurrentApp` 无内部调用者 + 加载项接入时不更新 currentApp（详见 §12.1 完整根因链）
- **建议实现**：HTTP 端点 `POST /set-current-app`（body: `{ "app": "word" }`），调用现有的 `setCurrentApp()` 方法；让客户端在接入 :58891 后主动预置 currentApp
- **复现路径**：接入 :58891 不调 setCurrentApp → 调任意 word 类工具 → 观察 wps-mcp 日志 + 用户 WPS 被 pkill
- **我们的临时方案**：替换 `wps-auto.sh` 为 noop 脚本（详见 §12.2.1）
- **设计依据**：`setCurrentApp` 已是 public 方法但无外部入口 = 作者预留的扩展点，暴露成 HTTP 是顺势而为

**对话中生成的 issue 草稿（完整正文）由 discuss agent 按需输出，不写入文档**。

### 12.4 问题归档规范（约定）

- 新发现用 FINDING-YYYYMMDD-NN 编号，沉淀到本节子节
- 外部 issue 用 ISSUE-YYYYMMDD-NN 编号，沉淀到本节子节
- 状态字段：待提交 / 已提交 / 已合并 / 已关闭-不修
- 任何与上游沟通的内容都归档到本节，不在聊天/临时文件中散落

---

## §13 wps MCP 连接模式：路线 P（多实例多端口，2026-09-03 已决策，取代 http 化）

> **状态**：✅ 已决策（2026-09-03 用户拍板）——**路线 P：wps-mcp 支持 `WPS_POLL_PORT` 环境变量 + bridge 集中分配 poll 端口（poll port ↔ session id 映射）+ 残留进程接受（资源堆积，不再影响功能）**
> **取代**：v0.16 的 http 化决策（§13.4/§13.5 历史保留）——路线 P 侵入更小（wps-mcp 改 1 行），且多窗口并发支持更好
> **触发背景**：v0.15 定位"两套 WPS MCP 连不上"= 多 wps-mcp 实例争抢 :58891 单例端口；残留根因 = qwenpaw acp 未走 `close_session` 清理 stdio 子进程；用户提出"wps mcp 用 http 模式 + 手动拉起常驻 server 更好"，后经多窗口场景分析转路线 P
> **决策链**（2026-09-03 讨论完整记录见 §13.5）

### 13.1 问题本质

- 每次 ACP `session/new` 带 `mcpServers` → QwenPaw 为该 session 建 **transient driver**（`acp_mcp_scope_id(session_id)` = 每 session 独立 scope + **独立 spawn 一个 stdio wps-mcp 进程**）
- `:58891` 是**单例端口 + 懒启动**（首次工具调用才占用）→ 多实例并存时：先占者（含**孤儿进程**，父退出被 init 收养）占住端口，后到者 `Port 58891 already in use` → 命令推不到角色 B → 工具失败
- 正常路径：`session/close` → `remove_transient_drivers` → 杀掉该 session 的 wps-mcp 并释放端口；**异常路径**（父崩溃/未 close）→ 孤儿残留占端口
- **多窗口并发是 90%+ 用户场景**（"文档即会话"架构决策）：1 word + 2 表格 = 3 文档 = 3 ACP session 同时工作 → stdio 单端口下 3 个 wps-mcp 抢 :58891，后 2 个 EADDRINUSE + 命令串台（poll-server 单槽位无路由，谁先 poll 谁领走）→ **stdio + 单 poll-server 架构上无法支撑多窗口并发**

### 13.2 已核实的约束（证据）

1. **wps-office-mcp 只有 stdio transport**：`src/server/mcp-server.ts:895` 硬编码 `new StdioServerTransport()`；`src/index.ts` 无 `--port`/`--http` 参数；无 http/sse transport 实现
2. **QwenPaw ACP mcpServers 支持三种**：`McpServerStdio`（command/args）、`McpServerSse`（url）、`McpServerHttp`（url，`transport: streamable_http`）——**http 类型不 spawn 进程**，连固定 URL
3. **transient driver 生命周期**：session 级 scope，`replace_transient_drivers` / `remove_transient_drivers`（`server.py:894-938`）；stdio 类型每 session 一个进程
4. **wps-office-mcp 不支持配置禁用切换**（v0.13 已核实），noop 脚本是当前部署配套
5. **POLL_PORT=58891 硬编码**：`wps-client.ts:46` `const POLL_PORT = 58891`；`mac-poll-server.ts:245` `private port: number = 58891`（`start(listenPort=58891)`）
6. **poll-server 进程级单例 + 懒启动**：`wps-client.ts:59/88` `if (!linuxPollServer.isRunning)`——每 wps-mcp 进程内只有一个 poll-server
7. **poll-server 单槽位 + 无路由**：`mac-poll-server.ts:415-425` `handlePoll`"谁先 poll 谁领走"，`pendingCommand` 唯一，**无 clientId/docId 分发** → 多窗口命令串台
8. **QwenPaw mcpServers 原生支持 env 注入子进程**：`mcp/client/stdio/__init__.py:127` `env=({**get_default_environment(), **server.env} ...)`——mcpServers 的 `env` 合并进子进程环境变量，**零 QwenPaw 改动**

### 13.3 候选方案

| 方案 | 做法 | 侵入 | 成本/风险 | 结论 |
|---|---|---|---|---|
| **P（多实例多端口）** | wps-mcp `POLL_PORT` 支持环境变量（`process.env.WPS_POLL_PORT \|\| 58891`，1 行）+ mcpServers 注入 env + bridge 集中分配端口 | **最小（wps-mcp 1 行）** | 残留降级为资源堆积（可接受）；引入端口分配复杂度（bridge 集中管理解决） | **✅ 最终采纳** |
| **Q（单实例 + docId 路由）** | 改 poll-server 支持按 docId/clientId 分发命令 | 大（poll-server 路由大改） | 单实例单 poll-server 服务所有窗口，但处理逻辑大改，不可知错误风险高 | ❌ 否决（用户评估：大改容易造成不可知错误） |
| **http 化（v0.16 曾选）** | wps-mcp 加 http transport + 独立常驻 | 中 | 只解"多进程抢端口"不解"命令串台"（单 poll-server 单槽位无路由，多窗口照样串台）；引入进程托管 | ❌ 被 P 取代 |
| **B（MCP http 桥）** | 常驻进程 spawn wps-mcp + 暴露 http 端点 | 大 | 协议转换工作量大；不解决 poll-server 单槽位问题 | ❌ 否决 |
| **C（stdio + 孤儿清理）** | 维持 stdio；启动/接入时清理孤儿 | 零（wps-mcp 不改） | 治标；多窗口并发下 3 wps-mcp 抢 58891 + 串台不可解 | ❌ 否决 |

### 13.4 决策要点（2026-09-03 用户拍板，最终版）

- **最终选择**：**路线 P**——wps-mcp `POLL_PORT` 支持环境变量（1 行改动），每 session 的 mcpServers 注入 `WPS_POLL_PORT`，bridge 集中分配端口
- **端口分配**：**bridge 集中分配**（用户拍板）——维护 `poll port ↔ doc id（即 session id）` 映射表；插件自分配容易互相冲突混乱，否决
- **残留进程**：**接受**（用户拍板）——路线 P 下多 wps-mcp 进程共存是合法状态（各占独立端口），残留只占资源不再影响功能；可定期手动清或 cron 清超时孤儿
- **多窗口并发**：MVP 必须（90%+ 用户场景，"文档即会话"：1 word + 2 表格 = 3 session）
- **http 化决策**（v0.16）**被路线 P 取代**：P 侵入更小（1 行 vs 加 http transport），且从机制上解决多窗口并发（每 session 独立端口），http 化只解抢端口不解命令串台
- **对 QwenPaw 侵入**：零（mcpServers 原生支持 env 注入 stdio 子进程，`mcp/client/stdio/__init__.py:127`）
- **对 wps-office-mcp 侵入**：1 行（`wps-client.ts:46` `const POLL_PORT = process.env.WPS_POLL_PORT || 58891`）
- **决策后需更新**：§3.1 组件图、§3.3 协议表、§5.1 配置、§5.1.1 部署配套、§10 决策表、§6.1 硬约束（本节 + 各节同步完成）

### 13.5 决策链与关键核实（2026-09-03 讨论记录）

**残留成因锁定**（13:48 现场排查）：

- 实测 5 个 wps-mcp 进程：4 个父进程是 `137411`（qwenpaw acp），启动时间 13:19×2 / 13:25×2；父进程 29min 仅 18s CPU（疑似 hang 等 stdin）
- **wps-office-mcp 是"只有父进程显式发信号才会死"的 stdio 进程**：`dist/index.js` 只监听 SIGINT/SIGTERM，不监听 SIGHUP、不监听 stdio close；`gracefulShutdown` 无"父进程已死"自检
- **mcp.client.stdio 清理链是健康的**（`stdio/__init__.py:189-230`）：关 stdin → 等 2s → `_terminate_process_tree`（killpg SIGTERM → 2s → SIGKILL）
- **qwenpaw 清理链健全**：`close_session → _remove_session_mcp → remove_transient_drivers → _shutdown_handler → MCPHandler._teardown → _client.close()`，`_shutdown_handler_with_timeout` 10s 兜底
- **根因**：qwenpaw acp **从未调用 close_session → _remove_session_mcp**（4 个 wps-mcp 从未收到 SIGTERM，否则 2s 内必死）

**架构核实（推翻"共享同一 server"预设）**：

- `linux-poll-server.ts` 头注释："MCP Server 作为 HTTP 服务端（端口 58891），WPS 加载项作为 HTTP 客户端轮询获取命令"
- 插件 `main.js:67` 角色 B：`serverUrl: 'http://127.0.0.1:58891'` —— **插件直接轮询 :58891，不走 MCP 协议层**
- 真实角色划分：QwenPaw ⇄(MCP)⇄ wps-office-mcp ⇄(:58891 私有轮询)⇄ WPS 插件（执行端）
- **插件从不、也不需要走 MCP** → "qwenpaw + 插件共享同一 mcp server" 预设不成立

**多窗口风险评估**（启动时清孤儿是否会误伤）：

- 所有 WPS 窗口共享**同一个** :58891 poll-server（`mac-poll-server.ts:279 listen :58891`，单例端口），多窗口 ≠ 多 wps-mcp 进程
- wps-mcp 内置 EADDRINUSE 处理（`mac-poll-server.ts:320-395`）：端口被占用时**不复用**，明确提示"清理残留进程后重试（launcher 会自动清理孤儿进程）"
- 结论：**不在启动时主动清孤儿**（多窗口下可能误杀正在服务的 wps-mcp）；http 化从机制上消除"qwenpaw spawn 子进程"，无需启动清理

**决策收敛**（14:41~14:59）：

1. stdio 是一对一管道，天然只支持一个客户端 → "qwenpaw + 插件共享同一 server" 在 stdio 下不可能 → 目标 A（残留）+ 共享 = 必须 http
2. 插件不走 MCP → http 化唯一真实动机 = 消除残留（治本）
3. 路线 2（wps-mcp 加 http transport）优于路线 1（bridge 协议转换）——工作量差一个数量级
4. 用户拍板：**http 化 + fork 新入口（轻 fork）+ 手动常驻（不写 systemd）+ 更新开发文档**

---

**决策推翻与收敛到路线 P**（15:48~16:2x，**取代 http 化**）：

**双份加载假设 + 核实**（15:48~15:58）：

- qwenpaw 侧 `wps-office-mcp.yaml` 存在（stdio），**用户确认之前一直 enabled，15:53 刚禁用**——双份加载铁证：用户"问 agent 工具反馈两份 wps mcp" = yaml(enabled) + ACP 注入双源
- 移除 qwenpaw 侧 yaml = **必须做且已做对**（消除双份加载源）
- qwenpaw 侧已无其他 wps-mcp 配置

**多窗口冲突定论**（15:59~16:12）：

- 每窗口 = 每 ACP session（"文档即会话"架构决策）；用户场景：1 word + 2 表格 = 3 session 同时工作 = **90%+ 用户场景，MVP 必须**
- poll-server 单槽位无路由（`mac-poll-server.ts:415-425`）：谁先 poll 谁领走，无 clientId/docId 分发 → **多窗口命令串台**
- http 化只解"多进程抢端口"，**不解命令串台**（单 poll-server 单槽位，多窗口照样串台）→ http 化不解决多窗口
- 多窗口并发必须改 wps-office-mcp（路线 P 或 Q）；"完全不改 wps-mcp"无解

**路线 P 可行性核实**（16:12，全绿）：

- **QwenPaw mcpServers 原生支持 env 注入 stdio 子进程**：`mcp/client/stdio/__init__.py:127` `env=({**get_default_environment(), **server.env} if server.env is not None ...)`——零 QwenPaw 改动
- `session_mcp.py:50` 把 server.env 标准化为 named values；`mcp_stateful_client.py:669-706` stdio spawn 接受 env 参数
- wps-mcp 仅需 1 行：`wps-client.ts:46` `const POLL_PORT = process.env.WPS_POLL_PORT || 58891`
- **关键洞察**：P 让"多 wps-mcp 进程共存"从错误状态变合法状态；残留从功能 bug 降级为资源堆积（各占独立端口不再打架）；http 化动机①消除抢端口→消失、②消除残留→降级为可接受

**路线 Q 被否**：poll-server 加路由 = 处理逻辑大改，不可知错误风险高（用户评估）

**最终拍板**（16:12~16:2x 用户）：

- 路线 P（多实例多端口）✅
- 端口分配：**bridge 集中分配**（poll port ↔ doc id/session id 映射表；插件自分配易冲突混乱，否决）
- 残留进程：**接受**（资源堆积，不再影响功能）
- 更新开发文档（v0.16 http 决策修订为路线 P）
