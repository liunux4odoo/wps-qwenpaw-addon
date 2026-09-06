# ACP Server Adapter 改造方案（v0.3：以兼容 opencode 为第一实施目标）

> **文档状态**：v0.3（2026-09-06，review 修订）
> **v0.1 → v0.2 变更**：目标从"泛化多 ACP 后端"**收敛为"先以兼容 opencode 为目标"**；纳入 opencode Phase 0 实测结果（V1-V5/V7 已验，V6/V8 待补）；kilocode 因配置错误推迟
> **v0.2 → v0.3 变更**：补 C9（ACP `initialize` 握手缺失，前端/bridge 现状从不发 initialize）耦合点与 V10/V11 待测项（Phase 1 前置门）；修正 C2 行号（429-499）；修订 §5.2 opencode agent 切换语义（与 V9 只读结论一致）；澄清 §6.2 盲选兜底（现状 `main.js:1156` 已有 `options[0]` 兜底）与 §6.3 看门狗实际缺口（tool_call 类不续命）；`docs/acp-servers/opencode.md` 移除明文 API key（已写入本机配置）
> **独立文档**：从 `docs/DEV-PLAN-Phase3.md` §3 F1（后续计划）提升为可实施计划；F1 原条目标注"仅规划，不在阶段 3 实施"，本文档为其落地方案
> **适用范围**：bridge（`bridge/acp-bridge.py`）+ 加载项前端（`js/main.js` / `js/acp-client.js`）的 server adapter 抽象
> **关联文档**：架构总纲 `docs/ARCHITECTURE.md`（v0.22）；阶段 3 打磨 `docs/DEV-PLAN-Phase3.md`（v1.5）；本文档只写"多 ACP 后端适配"，不覆盖阶段 3 打磨项
> **评估依据**：2026-09-05 迁移可行性评估 + opencode 1.18.23 Phase 0 实测（探针脚本 + 真实 wps-office-mcp）

---

## 0. 背景与范围

### 0.1 背景（评估结论摘要）

插件当前**不能无痛迁移**到其它 ACP server，但耦合高度集中，是"抽一个 server adapter"级工作量，不是重写：

- ✅ **零耦合**：前端传输层（`acp-client.js`，HTTP 轮询是 bridge 自有协议）、WPS 操作层（`wps-bridge.js` / `wps-poll-client.js`）、MCP 依赖（wps-office-mcp）——三者 grep "qwenpaw" 均 0 命中，换 server 不用动
- 🔴 **硬耦合（必须适配）**：bridge 的 spawn 命令硬编码 `qwenpaw acp --agent` + 三套 qwenpaw 专属 agent 发现机制（CLI / daemon HTTP / config.json）
- ⚠️ **软耦合（需验证/适配）**：
  1. 路线 P 多窗口隔离依赖 server honor `mcpServers[].env`（qwenpaw 行为，非 ACP 协议保证）——**最大风险，opencode 已实测通过（V2）**
  2. 工具审批自动批准依赖 `allow_once` option 形状（qwenpaw 特有）
  3. P2 看门狗心跳依赖 `agent_thought_chunk` 密集下发
  4. P15 `session/load` 恢复依赖 server 实现语义（有 fallback，功能降级不崩）

### 0.2 目标收敛（本次变更核心）

**第一实施目标 = opencode**。理由：

1. **已完成 Phase 0 实测**：opencode 1.18.23 的 ACP 实现已逐项验证（V1/V2/V3/V4/V5/V7），可行性已确认
2. **已配置可用模型**：`~/.config/opencode/opencode.json` 已加入 deepseek provider（`deepseek/deepseek-v4-flash`，OpenAI 兼容端点 `http://120.26.36.89:18080/v1`）并设为默认，探针全链路跑通
3. **qwenpaw 保持默认**：`--acp-server qwenpaw` 现状零回归；opencode 作为第一个"第二 server"落地
4. **kilocode 推迟**：CLI 被配置错误挡住（`/home/zero/.config/kilo/kilo.jsonc` 的 `Unrecognized key: web_search`），待用户修复后再补测

### 0.3 范围界定

| 范围内 | 范围外 |
|---|---|
| bridge spawn / agent 发现抽象为 server adapter | wps-office-mcp 源码（零 fork 铁律不变） |
| 前端协议偏好假设（审批 / 看门狗 / load / 中止）按能力标志适配 | 非 ACP 协议的后端（HTTP API 类）——不存在"迁移"，是重写，不在本文档 |
| opencode 适配落地（本阶段目标） | 前端传输层重写（HTTP 轮询是 bridge 抽象，已通用） |
| 插件页面 ACP server 配置 UI | 多 server 同时热切换的复杂编排（先单 server 切换） |
| kilocode 能力补测（配置修复后） | 协议归一化层（见 D1） |

### 0.4 跨层分类说明（沿用 DEV-PLAN-Phase3 惯例）

- **FE**：加载项前端（`taskpane.html` / `js/*`）
- **BRIDGE**：`bridge/acp-bridge.py`
- **CONFIG**：bridge 启动参数 / 插件页面配置（新增配置面）

---

## 1. 耦合点清单（已核实，2026-09-05 源码逐行确认）

| # | 耦合点 | 位置 | 类型 | opencode 实测对照 |
|---|---|---|---|---|
| C1 | spawn 命令硬编码 `qwenpaw acp --agent X` | `acp-bridge.py:538` | 硬耦合 | opencode spawn = `opencode acp --cwd <dir>`，**无 `--agent` 参数**（agent 走 mode/configOptions） |
| C2 | agent 发现三套 qwenpaw 专属机制 | `acp-bridge.py:429-499` | 硬耦合 | opencode = `opencode agent list`（build primary + permission 规则），agent 语义完全不同（见 V8） |
| C3 | `/agent/set` 切换 = kill + 重启 | `acp-bridge.py:501-560` | 硬耦合 | opencode 切换 agent = 改 configOptions.mode / 自定义 agent，语义不同 |
| C4 | 路线 P `mcpServers[].env` 注入依赖 server honor env | `acp-bridge.py:_inject_poll_port` | 软耦合/最大风险 | **opencode V2 ✅ 已实测通过**（env 原样透传） |
| C5 | 审批自动批准 `allow_once` option 形状 | `main.js:onAcpRequest` | 软耦合 | **opencode 默认不发 request_permission**（build 全 allow）；改 ask 规则才会发 |
| C6 | 看门狗心跳依赖 `agent_thought_chunk` 密集下发 | `main.js:onAcpSessionUpdate` | 软耦合 | **opencode 不发 agent_thought_chunk**（只发 tool_call / agent_message_chunk / usage_update） |
| C7 | `session/load` 语义依赖 server 实现 | `main.js:ensureSession` | 软耦合 | opencode 声明 `loadSession:true` + `resume`（未实测） |
| C8 | `session/cancel` 依赖 server 支持 | `main.js:（中止逻辑）` | 软耦合 | **opencode 不支持**（`Method not found`），中止只能 `session/close` 或等待 |
| C9 | ACP `initialize` 握手缺失 | 前端从不发（`main.js:860` 注释称"initialize 由 acp-bridge 无需显式"，但 `acp-bridge.py` 全文无 initialize 逻辑，grep 0 命中） | 硬耦合 | qwenpaw 容忍无 initialize 直接 session/new（现状能跑通）；opencode **是否容忍未实测**（V1 只测显式 initialize 有响应），见 V10 |

---

## 2. 目标与非目标

### 2.1 目标

1. bridge 从"硬编码 qwenpaw"改为"per-server adapter + 配置面"，**默认仍是 qwenpaw**（现状零破坏）
2. **opencode 作为第一个第二 server 完整落地**：能 spawn、建会话、对话、工具调用（WPS 链路）
3. 能力差异通过**能力标志（capability flags）**下发给前端，前端按标志适配，不做无脑归一化
4. 迁移后多窗口隔离（路线 P）、审批、看门狗、中止在 opencode 下**正常工作或显式降级**，不静默错误

### 2.2 非目标

- ❌ 协议归一化层（把不同 server 的差异全部翻译成统一语义）——工作量大、违背"bridge 不做业务逻辑"铁律、杠杆方向不对
- ❌ 非 ACP 后端支持（HTTP API 类）
- ❌ 多 server 同时在线热切换的编排（先单 server 切换）
- ❌ 改 wps-office-mcp 源码（零 fork 铁律不变）
- ❌ kilocode 落地（配置修复前不实施，见 D7）

---

## 3. 方案总览（四阶段，前两个是门）

```
Phase 0  目标 server 能力验证（阻塞门）→ opencode 已全部完成（V1-V11 ✅），kilocode 待补
Phase 1  bridge server adapter 抽象（C1-C3/C8/C9）→ ✅ 已完成（2026-09-06）：--acp-server qwenpaw|opencode，
         bridge/servers.py adapter，qwenpaw 零回归 + opencode 可建会话（test_adapter.py / test_switch_race.py / test_bridge.py 全绿）
Phase 2  前端协议偏好按能力标志适配（C4-C7）→ opencode 差异显式化
Phase 3  UI 配置化（F1 完整形态）→ 插件页面配置 ACP server
```

**Phase 0 是门**：先验证目标 server 的能力，再决定后续阶段做多少。验证不过的能力项，对应功能显式降级（不是隐藏 bug）。

---

## 4. Phase 0：目标 server 能力验证

> opencode 已实测通过的项目用 ✅ + 证据标注；未测的列出待办。能力表落 `docs/acp-servers/opencode.md`（已生成）。

### 4.1 opencode 1.18.23 实测结果

| # | 待验证项 | 结果 | 证据 / 说明 |
|---|---|---|---|
| V1 | ACP stdio 模式 | ✅ | `opencode acp` 响应 initialize；**protocolVersion 是整数 `1`（u16）**，qwenpaw 用字符串 `"2025-03-26"` |
| V2 | honor `mcpServers[].env` | ✅ | session/new 带 `env.WPS_POLL_PORT=59123` → spawn 的 wps-mcp 进程 `/proc/<pid>/environ` 实读 `WPS_POLL_PORT=59123`（原样透传） |
| V3 | `session/new` 参数兼容 | ✅ | **`mcpServers` 是必填数组**（缺了报 `Invalid input: expected array, received undefined`，传 `[]` 即可）；`cwd` 支持；返回 `sessionId` + `configOptions` + `available_commands_update` |
| V4 | `request_permission` option 形状 | ⚠️ 默认不发 | build(primary) 权限 `*` allow → 工具直接执行，无审批环节。**前提：若用户把权限规则改成 `ask`，opencode 才会发 request_permission，届时需补测 option 形状** |
| V5 | `agent_thought_chunk` 是否下发 | ❌ 不发 | 实测 update 类型仅：`tool_call` / `tool_call_update` / `agent_message_chunk` / `usage_update` / `available_commands_update` |
| V6 | `session/load` / `resume` 支持 | ✅ | 实测：不 close 直接 load 成功且上下文恢复（prompt2 答出记忆词）；close 后 load 也成功（回放历史）。**`session/load` 需 cwd + mcpServers 必填** |
| V7 | `session/cancel` 支持 | ❌ 不支持 | `session/cancel` 报 `Method not found`；`sessionCapabilities` 有 close/fork/list/resume，**无 cancel** |
| V8 | agent 概念与枚举 | ✅ | `opencode agent list` → `build (primary)` + permission 规则（`*` allow / `doom_loop` ask / `external_directory` ask）；`~/.config/opencode/agents/` 有自定义 wps-word/wps-expert 等（skill 式 agent）。**agent 语义 ≠ qwenpaw 命名 agent** |

### 4.2 opencode 新增待补项（V9）——已补测完成

| # | 待验证 | 结果 | 结论 |
|---|---|---|---|
| V9 | 切换模型参数格式 | ✅ | **`session/set_config_option`（configId 参数）生效**：响应 currentValue 变化 + 日志实锤实际请求用新模型；**`session/new` 的 `configOptions` 数组不生效（只读返回）**。Phase 3 模型选择用 set_config_option |

### 4.3 opencode 新增待补项（V10/V11）——Phase 1 前置阻塞项

> **背景**：review（2026-09-06）发现两个 V1-V9 未覆盖的耦合点，均可能阻断 Phase 1/2 落地，必须在进入 Phase 1 前实测。**已实测完成（见下表 ✅），无阻塞。**

| # | 待验证 | 影响 | 状态 |
|---|---|---|---|
| ~~V10~~ | opencode **无 initialize 直接 session/new** 是否被接受（C9） | Phase 1 spawn/建会话（C9） | ✅ 已实测：**接受**，直接返回 sessionId（无需握手注入，D9 落地为"前端不发送 initialize，bridge 纯传输不变"） |
| ~~V11~~ | opencode `session/new` 的 `configOptions` 改 **mode** 是否生效 | Phase 2/3 agent 切换语义（C3 / §5.2 / §7） | ✅ 已实测：**configOptions 数组不生效（mode 仍 build，同 V9 model 只读结论）；`session/set_config_option` 生效（currentValue 变 plan）且为会话级（新建会话默认仍 build）**。agent 切换只能用 set_config_option |

### 4.4 kilocode 状态

**blocker**：CLI 报 `Unrecognized key: web_search`（`/home/zero/.config/kilo/kilo.jsonc` 新版严格校验）。修复配置后按 V1-V8 流程补测。未修复前不进入 Phase 1/2。

---

## 5. Phase 1：bridge server adapter 抽象（C1-C3/C8）

### 5.1 adapter 契约（WHAT）

adapter 是 bridge 内部的一个**配置化描述**（不是代码插件），必须能回答：

1. **spawn**：从配置生成 ACP server 的启动命令与参数（argv / env / cwd）
2. **agent 发现**：如何枚举可用 agents（命令、解析方式；无 agent 概念的 server 返回空列表）
3. **agent 切换**：切换的语义（kill+restart / 改 configOptions / 单 agent 不可切换 / 其它）
4. **能力标志**：声明 V2/V4/V5/V6/V7/V8 的验证结果（供前端适配）
5. **握手策略**：`initialize` 是否/如何发送（qwenpaw 现状不发也能建会话；opencode 待 V10 实测）。倾向：由前端按能力标志发送、bridge 保持纯传输（守 §6.1 铁律），不做 bridge 内自动注入

### 5.2 opencode adapter 要点（已实测；agent 切换语义已定）

- **spawn**：`opencode acp --cwd <dir>`（无 `--agent` 参数；`protocolVersion` 用整数 `1`）
- **session/new**：必须带 `mcpServers`（数组，可为 `[]`）——bridge 建会话逻辑需保证默认传空数组
- **agent 语义**：`opencode agent list` 枚举（build/plan + 自定义 skill agent）；**切换 = `session/set_config_option(configId:"mode", value:<mode>)`**（V11 已实测：configOptions 数组只读不生效，set_config_option 生效且为**会话级**——新建会话默认仍 build）。与 qwenpaw 的 kill+restart 不同
- **中止**：不支持 `session/cancel`，前端中止走 `session/close`（破坏会话）或等待自然结束

### 5.3 配置面（CONFIG）

- bridge 新增启动参数 `--acp-server <name>`（默认 `qwenpaw`，现状零破坏）
- server 定义（spawn 命令 / agent 发现命令 / 能力标志 / protocolVersion 等 wire 参数）放配置文件（如 `bridge/servers/` 或 `config.json`），bridge 启动时按 name 加载
- 现状迁移：qwenpaw 的现有逻辑（CLI / daemon / config.json 发现、switch_agent、重启退避）原样搬进 qwenpaw adapter，**行为不变**

### 5.4 验收

- `--acp-server qwenpaw` 启动：与现状行为完全一致（现有测试全绿）→ **✅ 通过**（test_switch_race.py 基线/切换竞态/相对路径注入 + test_bridge.py WS 流式全绿）
- `--acp-server opencode` 启动：能 spawn、能建会话（`mcpServers:[]` 兜底）、能收发消息 → **✅ 通过**（test_adapter.py opencode：session/new + prompt 流式）
- opencode 下 agent 枚举走 `opencode agent list`，agent 选择 UI 反映 opencode 语义（mode/自定义 agent），不报错 → **✅ 通过**（`/agents` 返回 11 个 build/plan/自定义 agent；`/agent/set` config_option 语义正常）

**回归工具**：`bridge/test_adapter.py`（qwenpaw / opencode 双 E2E，自 spawn 独立端口）

---

## 6. Phase 2：前端协议偏好按能力标志适配（C4-C8）

> 前置：Phase 0 拿到能力标志，bridge `/config` 下发 `capabilities` 字段。

### 6.1 路线 P 注入（C4）——opencode ✅

- **V2 实测通过**：opencode 完整透传 `mcpServers[].env`，注入逻辑**保持现状**
- 其它 server（如 kilocode）V2 未测，走"先验后定"：不通则降级单 wps-mcp（见下）
- **验收**：opencode 下多窗口独立端口隔离正常（WPS_POLL_PORT 各自独立）

### 6.2 审批自动批准（C5）——opencode 默认无审批

- 能力标志声明该 server 是否发审批（opencode=`no_approval`，build 全 allow）
- **opencode 下**：无审批环节 → 自动批准路径不触发，工具直接执行（无需改动，但不能误以为 qwenpaw 的 `allow_once` 逻辑在用）
- **降级兜底**：若用户把 opencode 权限改成 `ask`（会发 request_permission），映射不到 option 时**弹 UI 手动确认**，不盲选第一个。⚠️ 现状 `main.js:1156` 已有"盲选 `options[0]`"兜底，Phase 2 必须按能力标志改造该分支（qwenpaw 保留自动批准；opencode 默认无审批则整条路径不触发；ask 场景改手动确认），否则该行仍会盲选
- **验收**：opencode 默认配置下工具调用直接执行，无假审批 UI

### 6.3 看门狗心跳（C6）——opencode 必改

- opencode **不发 agent_thought_chunk / status_update** → 现心跳的 thought 续命（`main.js:1095`）与 status_update 续命（`main.js:1108`）在 opencode 下不触发。实际缺口是**工具执行期**：opencode 只下发 `tool_call` / `tool_call_update` / `usage_update`，三者均不调用 `touchActivity` → 长工具链会误报中断。注意 `touchActivity` 现状已由 agent_message_chunk / status_update / request_permission 触发，不是只靠 thought chunk
- **必改**：看门狗改为**任意下行消息都续命**（`touchActivity` 扩展为协议通用行为：agent_message_chunk / tool_call / tool_call_update / usage_update / available_commands_update / 未识别 update 一律刷新）
- **验收**：opencode 长思考 + 工具执行期不误报中断

### 6.4 session/load（C7）——opencode ✅ 支持

- opencode 实测：`session/load` 支持历史恢复（close 后仍可 load），**需 cwd + mcpServers 必填**（adapter 注意）
- P15 历史恢复在 opencode 下可用（AI 上下文记忆恢复）
- **验收**：opencode 重开文档 P15 历史恢复正常；load 必填参数由 bridge adapter 补齐

### 6.5 中止（C8）——opencode 不支持 cancel，新增适配

- opencode 不支持 `session/cancel` → 前端中止按钮改为调用 `session/close`（破坏当前会话，下次重建）或提供"停止等待"但不销毁会话的降级
- **验收**：opencode 下点击中止有明确行为（销毁会话重建 / 停止等待），不静默无效

---

## 7. Phase 3：UI 配置化（F1 完整形态）

- 插件设置区提供 ACP server 配置（选择 server / 自定义命令 / 参数 / agent），持久化到 localStorage
- bridge 暴露 `/servers`（可用 server 列表 + 能力标志）与 `/server/set`（切换，qwenpaw 复用 `/agent/set` 重启机制；opencode 复用 spawn 重启）
- opencode 特有：模型选择（configOptions 的 model/effort/mode）交互——**用 `session/set_config_option`（configId），session/new 的 configOptions 只读不生效**（V9 已确认）
- **验收**（UX）：页面可选择 server 并记住上次选择；切换后会话重建、状态正确；能力差异在 UI 上有说明（如 opencode 无审批 / 中止为重建会话）

---

## 8. 优先级与排期

```
Phase 0（opencode 已完成）→ 门：能力表落盘（docs/acp-servers/opencode.md ✅）+ V1-V11 ✅
Phase 1（bridge adapter）→ ✅ 已完成（2026-09-06）：--acp-server qwenpaw|opencode，qwenpaw 零回归 + opencode 可建会话（A1/A2 过）
Phase 2（前端能力适配）→ 门：opencode 全链路可用或显式降级
Phase 3（UI 配置）→ 门：UX 验收
kilocode → 配置修复后按 V1-V8 补测，再决定是否进入 Phase 1/2
```

- **Phase 0 单独先做**就值回票价：验证结果决定"迁移"是真可行还是该砍掉重想（opencode 已验证可行）
- Phase 1 与 Phase 2 可并行推进（bridge 侧 / 前端侧）
- Phase 3 依赖 Phase 1（配置面先有 server 列表；Phase 1 已落地 `--acp-server` + `/config` 能力标志）
- opencode 的 **V10/V11 已实测通过（§4.3）**，Phase 1 无阻塞

---

## 9. 验收标准（停止门）

| ID | 验收项 | 度量 |
|---|---|---|
| A1 | qwenpaw 零回归 | `--acp-server qwenpaw` 现有行为/测试全绿 |
| A2 | opencode 基本可用 | 可建会话（`mcpServers:[]` 兜底）、可对话、可工具调用（V1-V3 过前提下） |
| A3 | 能力差异显式化 | 每个能力标志对应 UI 可见状态（支持 / 降级 / 禁用），无静默错误 |
| A4 | opencode 无审批路径正确 | 默认配置下工具调用直接执行，无假审批 UI；改 ask 规则时弹 UI 手动确认不盲选 |
| A5 | 看门狗通用 | 任意下行续命；opencode 长思考 + 工具执行不误报 |
| A6 | 多窗口隔离诚实 | opencode V2 ✅ 多窗口正常；未验证的 server 明示降级不假装支持 |
| A7 | 配置持久化 | 页面选择 server 后重启加载项仍生效 |
| A8 | opencode 中止有明确行为 | 中止按钮不静默无效（close 重建或停止等待） |

---

## 10. 待验证项汇总

| # | 待验证 | 影响 | 状态 |
|---|---|---|---|
| ~~V6~~ | opencode `session/load` / `resume` 实际语义 | P15 历史恢复（C7） | ✅ 已实测：支持历史恢复，close 后仍可 load，需 cwd+mcpServers 必填 |
| ~~V9~~ | opencode 切换模型参数格式 | Phase 3 模型选择 | ✅ 已实测：用 set_config_option（configId）；session/new configOptions 只读 |
| V10 | ~~opencode 无 initialize 直接 session/new（C9）~~ | Phase 1 spawn/建会话 | ✅ 已实测：接受直接 session/new，无需握手注入 |
| V11 | ~~opencode `configOptions` 改 mode 是否生效~~ | Phase 2/3 agent 切换（C3） | ✅ 已实测：configOptions 只读；`set_config_option` 生效且会话级 |
| kilocode V1-V8 | 修复 `kilo.jsonc` 的 web_search 键后全流程补测 | 是否进入 Phase 1/2 | ⏸ blocker（待用户修配置） |

**opencode 的 V1-V11 已全部验证完成，进入 Phase 1/2 无阻塞。**

---

## 11. 决策留痕

| # | 决策 | 否决方案 | 理由 |
|---|---|---|---|
| D1 | per-server adapter（配置化描述）而非协议归一化层 | 统一归一化层 | 归一化工作量大、违背 bridge 不做业务逻辑铁律、杠杆方向不对（成本落在共用基础设施） |
| D2 | 能力标志下发给前端按标志适配 | 前端对所有 server 做兼容分支 | 能力差异是事实，标志是显式声明，前端盲兼容会静默错 |
| D3 | Phase 0 验证先行（阻塞门） | 直接动手改 adapter | 不验证就改 = 盲改；V1 不过则迁移不可行，前功尽弃 |
| D4 | 默认仍 qwenpaw（`--acp-server qwenpaw`） | 默认空/要求显式选择 | 现状零破坏，现有部署/测试不回归 |
| D5 | 非 ACP 后端明确排除 | 顺带支持 HTTP API | 不是"迁移"是重写，范围失控 |
| D6 | **第一实施目标 = opencode** | 泛化多 server 齐头并进 | opencode 已完成 Phase 0 实测 + 已配可用模型（deepseek），可行性格最低；先落地一个真实第二 server 再泛化 |
| D7 | **kilocode 推迟** | 与 opencode 并行 | 配置错误（web_search 键）挡 CLI，修前无法测；不阻塞 opencode 主线 |
| D8 | **opencode 中止走 session/close**（破坏会话）而非 cancel | 硬等自然结束 / 找非标 cancel | opencode 明确无 session/cancel；close 是 ACP 标准能力，语义可接受（中止=放弃该会话） |
| D9 | **initialize 握手：前端不发送，bridge 保持纯传输**（V10 实测 opencode 容忍无 initialize 直接建会话） | bridge 内自动注入 initialize | V10 确认 opencode 无需握手即接受 session/new；注入是多余改动且违背 bridge 纯传输铁律 |

---

## 12. 文档路由

- 架构总纲：`docs/ARCHITECTURE.md`——本文档落地后，§3.4（ACP 桥接服务）补 adapter 层说明、§6.3（允许的扩展方向）登记"多 ACP 后端"、版本头更新（v0.23+）
- 阶段 3：`docs/DEV-PLAN-Phase3.md` §3 F1 状态从"仅规划"改为"已实施（见本计划）"
- 目标 server 能力表：`docs/acp-servers/opencode.md`（✅ 已生成，Phase 0 输出）
- 项目记忆：决策链沉淀到 ARCHITECTURE.md §13（新增 §13.x 多 ACP adapter 决策）
