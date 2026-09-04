# Agent 切换竞态 + MCP 入口兜底修复方案

> 状态：✅ 已实施（2026-09-04，code agent）
> 日期：2026-09-04
> 对应：DEV-PLAN-Phase3.md P3（agent 切换）的 **稳定性根因已实测定位**；本方案只覆盖
> "切换后会话无 wps MCP 工具"的两个根因：① 切换竞态 ② MCP 入口相对路径兜底。
> 仓库：`/data/myrepo/wps-qwenpaw-addon/`，文件：`bridge/acp-bridge.py` + `js/main.js`

---

## 1. 背景与现象

用户实机测试（WPS 演示文稿）：插件对话正常，但 **AI 没有 wps MCP 工具**。
用户对比发现"agent 自己配置了 wps-mcp（哪怕禁用）就能识别，没配置就不能"——
**该观察已被实测推翻**：qwenpaw 侧 4 组合验证（ai-developer / assistant × 传/不传
wps mcpServers）行为完全一致，**工具注入与 agent 自身配置无关**。

真实根因是两个独立的**时序/兜底**问题，均会表现为"会话能建立但无 wps 工具"。

## 2. 根因（诊断结论，证据链完整）

### 2.1 根因 1：切换 agent 后立即 session/new 被 bridge 静默丢弃

`bridge/acp-bridge.py`：

- `switch_agent()`（:479）：`/agent/set` 只做 `self.proc.kill()` 后**立即返回 ok**，
  新 qwenpaw acp 子进程由 `_wait_proc()`（:542）异步重启——`start_proc()`（:503）
  只是 `create_subprocess_exec` spawn，**不等待 initialize 握手就绪**。
- `_write_stdin()`（:636）：当 `self.proc.stdin.is_closing()`（kill 后/重启中）时
  **静默丢弃上行消息**（"dropping message"）。

`js/main.js`：

- `switchAgent()`（:412）：`/agent/set` 返回 ok 后**立即** `ensureSession()`（:453，
  若 connected）。此时新 qwenpaw 未就绪 → `session/new` 被 bridge 静默丢弃 →
  前端永远等不到 sessionId。
- `ensureSession()`（:779）：`session/new` 发出后记入 `pendingRequests[id]`；由于
  response 永不到达，该 pending 项**永不删除** → 后续 `ensureSession()` 被
  :782-785 的"防重入"检查**锁死**；`acpSessionId` 保持 null → `onUserSend`（:1051）
  每次发消息都走"会话未就绪"分支。**结果：该文档的会话卡死在"无工具/不可用"状态，
  且无超时、无重试、无用户可见错误。**

**实测复现**（完整 bridge HTTP 链，`/tmp/test_final_repro.py`）：

```
[1] assistant + session/new wps → 有工具
[2] 切 ai-developer（/agent/set 返回 ok）
[3] 立即 session/new → 30s 无响应（被丢弃）
[4] 等 8s 后 session/new → 有工具
```

新 qwenpaw 就绪时间实测 **≥ 8s**（含 spawn + initialize + workspace 加载）。

### 2.2 根因 2：MCP 入口相对路径兜底导致 wps-mcp spawn 失败

`js/main.js`：

- `WPS_MCP_ENTRY_DEFAULT = '../third_party/opencode-wps/wps-office-mcp/dist/index.js'`
  （:36）是**相对路径**；`MCP_SERVERS[0].args = [WPS_MCP_ENTRY_DEFAULT]`（:48）。
- 仅当 `loadBridgeConfig()`（:460）成功拉到 `http://127.0.0.1:8766/config` 返回的
  **绝对路径**才覆盖。`/config` 不可达（bridge 未就绪/超时）时，**保留相对路径**，
  且**无任何用户可见提示**。

qwenpaw 侧 `session/new` 收到相对路径 args 后，以 `cwd`（= 文档目录或 /tmp）为基
spawn `node ../third_party/...` → **找不到文件 → wps-mcp 起不来 → 无工具**。

**实测复现**（`/tmp/test_relpath.py`，cwd=/tmp）：

```
绝对路径 args            → has_wps=True（有工具）
相对路径 ../third_party/... → NO_SESSION（spawn 失败，会话都建不起来）
```

## 3. 修复目标（WHAT）

- **目标 1（切换竞态）**：切换 agent 后前端发起的首个 `session/new` 不得因 qwenpaw
  未就绪而被静默丢弃。两条路线可独立或组合实现：
  - **路线 A（bridge 侧）**：`/agent/set` 在返回 ok **之前**，等待新 qwenpaw acp
    子进程就绪（完成 initialize 握手），未就绪时前端请求不得被静默丢弃；
  - **路线 B（FE 侧）**：`ensureSession()` 的 `session/new` 发送后增加**超时 +
    自动重试**，且 session 建立失败时**清理 pending 锁死项**，不得永久卡死。
- **目标 2（相对路径兜底）**：`/config` 不可达时，前端不得静默使用相对路径去 spawn
  wps-mcp。二选一：
  - **(a) 绝对路径兜底**：兜底值改为可靠的绝对路径（经 `/config` 或可解析的仓库
    根获得），保证 spawn 一定成功；
  - **(b) 可见错误**：明确向前端展示"bridge 未就绪"错误，而非静默失败。
  二选一由 code agent 判断，**但不得出现"相对路径静默 spawn 失败"**。

## 4. 硬约束（不许违反）

- **约束 1**：**不改 wps-office-mcp 源码**（zero-fork 铁律，ARCHITECTURE.md §6.1）。
- **约束 2**：**bridge 不实现会话管理**（ARCHITECTURE.md §6.1 铁律）。修复 1 是
  "就绪等待 / 转发可靠性 / 前端重试"，**不是**由 bridge 代管 session 状态、缓存、
  聚合或加工消息。
- **约束 3**：不碰 qwenpaw 内部存储（守 ARCHITECTURE.md §6.1 铁律）。
- **约束 4**：保持现有 HTTP/WS 双通道与多窗口同 id 去重（`_pop_request_owner` FIFO，
  acp-bridge.py:550）语义不变——多窗口并发请求不得因修复而串台或丢消息。
- **约束 5**：不引入新的第三方依赖（bridge 保持 Python 标准库零依赖；前端保持
  无构建/无 npm 依赖）。
- **约束 6**：正常路径（`/config` 可达、不切换 agent）行为不得回退；就绪等待不得
  给正常请求引入额外延迟或往返。

## 5. 边界情况（期望行为）

| # | 边界 | 期望行为 |
|---|---|---|
| 1 | **切换 agent 后立即 session/new**（qwenpaw 未就绪） | 不静默丢弃：bridge 等到就绪再转发，或前端超时重试直到拿到 sessionId（重试 ≤1 次内成功） |
| 2 | **session/new 无响应（response 丢失）** | 前端有超时机制，清理 pending 项，可重试；不得永久卡在"ACP: 创建会话…" |
| 3 | **qwenpaw 崩溃循环**（重启反复失败） | 就绪等待/重试必须有上限（不得无限挂起）；超时走明确失败路径（用户可见错误） |
| 4 | **/config 不可达**（bridge 未就绪/超时） | MCP_SERVERS 传给 session/new 的 args 必须是可 spawn 成功的绝对路径，或用户明确看到"bridge 未就绪"提示 |
| 5 | **/config 可达（正常）** | 行为与现状完全一致：用 /config 返回的绝对路径，wps 工具可用 |
| 6 | **多窗口并发 + 其中一个切换 agent** | 另一窗口请求不受影响，不串台、不丢消息（同 id FIFO 语义保持） |
| 7 | **切换后重建会话的 prompt 注入**（P16 preamble） | 目标 1 修复不得破坏"新会话首条 prompt 注入环境上下文"（preamblePending 逻辑） |
| 8 | **session/load vs session/new** | 修复只针对 session/new 的竞态；session/load 现有的"失败清缓存回退"降级逻辑保持 |

## 6. 验收标准（可执行）

> 通过 = 全部满足。下列命令在 bridge + 真实 qwenpaw 环境下执行。

### 6.1 切换竞态回归（核心）

```bash
# 启动 bridge（agent A），/agent/set 切到 agent B，返回 ok 后立即 session/new
# 验收点：必拿到 sessionId（重试 ≤1 次内），且新会话里 wps 工具可用
python bridge/test_bridge.py   # 现有端到端：initialize -> session/new -> prompt 流式
# + 新增切换场景脚本（code agent 自建）：/agent/set -> 立即 session/new -> 断言 sessionId
```

### 6.2 前端锁死回归

```bash
# 模拟 session/new 无响应（如桥接启动期间），观察前端状态
# 验收点：不永久卡在"ACP: 创建会话…"；有超时/重试/明确错误；pendingRequests 不泄漏
```

### 6.3 相对路径兜底回归

```bash
# 模拟 /config 不可达（如停 bridge 的 /config 或改 URL），加载插件
# 验收点：不会带 '../third_party/...' 相对路径去 spawn（用绝对路径或可见错误）
```

### 6.4 正常路径回归

```bash
# bridge 正常 + /config 可达 + 不切换 agent
# 验收点：session/new 一次成功，wps 工具可用，无额外延迟
```

### 6.5 语法检查

```bash
node --check js/main.js
python -m py_compile bridge/acp-bridge.py
```

## 7. 诊断候选（🟡 不预定结果）

以下方向只是候选，code agent 可独立选择/组合/另辟蹊径，只要满足 §3 目标 +
§4 约束 + §6 验收：

- 根因 1 路线 A：bridge 在 `switch_agent()` 里等待新子进程就绪（如监听
  initialize 响应 / stdin 可写 + 握手完成信号）后再返回 ok；或 `_write_stdin`
  在未就绪时改为**排队/阻塞**而非静默丢弃。
- 根因 1 路线 B：前端 `ensureSession()` 的 `session/new` 加看门狗（超时 → 清
  pending → 重试一次 → 仍失败则可见错误）；`onUserSend` 未就绪分支复用同一机制。
- 根因 2：(a) `WPS_MCP_ENTRY_DEFAULT` 改绝对路径（需能跨机器可靠解析，参考 bridge
  `/config` 如何解析 submodule 绝对路径）；(b) `loadBridgeConfig` 失败时置可见
  错误状态 + UI 提示。

**任何方案必须同时考虑"不破坏多窗口并发"与"不把 bridge 变成会话管理者"。**

## 8. 非目标（不做）

- ❌ 不修复 qwenpaw 侧 transient MCP 机制（实测已正常，与 agent 配置无关）
- ❌ 不改 ai-developer 的 `wps-office-mcp.yaml`（enabled: false 是用户有意为之，
  且与本次根因无关）
- ❌ 不改 DEV-PLAN-Phase3.md P3 的 agent 下拉/记忆 UI（那是功能层，本次是稳定性）
- ❌ 不扩展 bridge 读 qwenpaw 内部存储（守 §6.1 铁律）
- ❌ 不引入依赖、不改 ACP 消息分帧协议

## 9. 契约冲突上抛

实施过程中若发现 §4 约束与 §3 目标存在不可调和冲突（例如"就绪等待"与"不引入
额外延迟"矛盾），**不要自己找 workaround**——归档到 `QUESTIONS.md` 上抛，说明
冲突点 + 你尝试过的方向 + 建议裁决。

---

## 10. 实施记录（2026-09-04 code agent）

### 10.1 根因 1（切换竞态）— 路线 A + 路线 B 组合

**bridge 侧（路线 A）** `bridge/acp-bridge.py`：

- `switch_agent()`：kill 前重置 `_proc_started` 事件，返回 ok 前 `await asyncio.wait_for`
  新 qwenpaw acp 子进程 spawn 就绪（`SWITCH_READY_TIMEOUT=8s`，超时返回 ok，由排队+前端重试兜底）。
  实测 /agent/set 从 kill 到就绪约 1.1s（原行为立即返回 → 前端 session/new 落在"stdin 不可用"窗口）。
- `_write_stdin()` 重构为排队包装 + `_write_stdin_now()`：stdin 不可用（切换 kill 后/重启中）时
  **不静默丢弃**，排入 `_upstream_queue`；`start_proc()` spawn 后触发 `_flush_upstream()` 顺序转发。
  排队有 `UPSTREAM_QUEUE_MAX=512` + `UPSTREAM_QUEUE_TTL=30s` 上限；`_flushing` 守卫保证同一时刻
  仅一个排空者，保持全局 FIFO（多窗口同 id 去重语义不变，守 §4 约束 4）。
- 就绪等待不引入正常路径额外延迟：proc 就绪且队列空时 `_write_stdin_now` 直通（约束 6）。

**前端侧（路线 B）** `js/main.js`：

- `ensureSession()` 拆分为 `ensureSession` + `ensureSessionSend`：发送 session/new（或 session/load）
  后启动 `SESSION_TIMEOUT_MS=25000` 看门狗；超时 `onSessionTimeout()` **清理 pendingRequests 防锁死**、
  自动重试 ≤1 次；重试用尽 → 用户可见错误卡（`ChatUi.addErrorCard`），绝不永久卡在"ACP: 创建会话…"。
- `session/load` 超时沿用既有降级（清缓存回退 session/new，守边界 #8）；成功/失败响应都会
  `clearSessionWatchdog()`，建立成功 `sessionRetries=0`（下次切换重新计时）。

### 10.2 根因 2（MCP 入口相对路径兜底）— 绝对路径权威注入 + 前端门禁

**bridge 侧（权威注入，主兜底）** `bridge/acp-bridge.py` `_inject_poll_port()`：

- session/new / session/load 转发前，把 wps mcpServer 的 `args[0]` **强制**为 bridge 依据仓库根解析的
  `self.wps_mcp_entry` 绝对路径（覆盖前端传入的任何相对/旧路径）。任何相对路径都不可能到达 spawn。
- 端口分配失败不再中断路径注入（原 `if port is None: return raw` 改为仅跳过端口注入）。

**前端侧（门禁 + 可见错误）** `js/main.js`：

- `WPS_MCP_ENTRY_DEFAULT` 相对路径占位改为 `null`（永不用于 spawn）；`MCP_SERVERS.args` 仅由
  `/config` 下发权威绝对路径填充（`fetchBridgeConfig`）。
- `loadBridgeConfig` 失败重试（1s/3s/5s，共 3 次），仍失败给用户可见错误卡（不静默）。
- `ensureSession` 门禁：`wpsMcpEntryReady` 之前不发 session/new（不携带相对/空路径去 spawn），
  先 `ensureBridgeConfigThenSession()`（2 次重试）；确认失败置状态 `ACP: bridge 未就绪` + 可见错误；
  `/config` 恢复后自动继续建会话。

### 10.3 验证（全部通过）

```bash
node --check js/main.js                                  # ✅ 语法
conda run -n py312 python -m py_compile bridge/acp-bridge.py   # ✅ 语法
conda run -n py312 python bridge/test_bridge.py           # ✅ 现有端到端（正常路径无回退）
conda run -n py312 python bridge/test_switch_race.py assistant ai-developer
# ✅ 基线 session/new / 切换后立即 session/new（必拿 sessionId，bridge 日志见
#    "switch_agent: 新 qwenpaw acp 子进程就绪"）/ 相对路径 args 自动注入绝对路径（日志见
#    "inject authoritative wpsMcpEntry=..."）
node bridge/test_frontend_race.js                         # ✅ 前端行为（全新环境加载真实 main.js）
#   A: /config 不可达 → 不发送 session/new + 可见错误 + 状态 bridge 未就绪
#   B: /config 恢复 → 用绝对路径建会话
#   C: 看门狗超时 → 重试 ≤1 → 响应到达即成功
#   D: 重试用尽 → 可见错误 + 无无限循环 + pending 不泄漏（可重新建会话）
```

**未自动化（需 WPS 实机）**：§6.2/§6.3 的 UI 观感（错误卡样式、状态文案）、
多窗口并发 + 单窗口切换的实机表现（逻辑已由 FIFO 语义保持，未见回归点）。

### 10.4 审查加固（本地 code review 后，2026-09-04）

- `_wait_proc` 退避改为**可被 switch_agent 唤醒**（`_restart_seq` 递增即退出等待循环）：
  修正"切换发生在 crash loop 退避睡眠中时，8s 就绪等待超时返回 false-ok，且 `_restart_delay`
  复位被 `_wait_proc` 醒来后的翻倍覆盖"的缺口。
- `_flush_upstream`/`_write_stdin` 直连写失败（flush 期间子进程又退出）→ **try/except 放回队首
  重发**，不丢消息、不中断排空（原实现会丢一条消息且剩余队列停滞）。
- `_enqueue_upstream`：**条数 + 字节双上限**（`UPSTREAM_QUEUE_MAX` + `UPSTREAM_QUEUE_MAX_BYTES`），
  覆盖超大单条消息的积压；并**丢弃同 client 被取代的旧 session/new|session/load**，防止
  看门狗重试/崩溃恢复后重复建会话抢占同一 poll 端口（根因 1 目标不因重试退化而失效）。

---

## 附：给 code agent 的上下文起点（不是路线图）

- 根因文件：`bridge/acp-bridge.py`（`switch_agent` :479 / `start_proc` :503 /
  `_wait_proc` :542 / `_write_stdin` :636）、`js/main.js`（`WPS_MCP_ENTRY_DEFAULT`
  :36 / `MCP_SERVERS` :45 / `switchAgent` :412 / `loadBridgeConfig` :460 /
  `ensureSession` :779 / `onAcpResponse` :838 / `onUserSend` :1051）
- 复现脚本（调用方临时产物，参考用）：`/tmp/test_final_repro.py`、
  `/tmp/test_relpath.py`、`/tmp/test_cmds_matrix.py`、`/tmp/test_invoke_matrix.py`
- 现有端到端：`bridge/test_bridge.py`
- 相关文档：`docs/ARCHITECTURE.md` §6.1（bridge 铁律）、`docs/DEV-PLAN-Phase3.md`
  P3（agent 切换）、P16（session bootstrap）
