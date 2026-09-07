# opencode ACP 能力表（Phase 0 输出）

> **server**：opencode 1.18.23（PATH 中的 `opencode`；bridge 以 `OPENCODE_BIN` env / PATH 解析）
> **验证日期**：2026-09-05
> **验证方法**：真实 wps-office-mcp（`third_party/opencode-wps/wps-office-mcp/dist/index.js`）+ 一次性探针脚本（`/tmp/acp_probe*.py`）
> **关联**：`docs/plan-2026-09-05-acp-server-adapter.md`（v0.5，D6：第一实施目标 = opencode；V10/V11 待补测见 §7）
> **状态（2026-09-07 定案）**：opencode 是**唯一计划内的替代后端**——面向无法/不愿安装 QwenPaw 的用户，已能完整体验本项目功能。ACP server 兼容**到此为止**：qwenpaw 为主目标（默认），其余 code agent（claudecode / kimicode / qcoder 等）一律推迟，等有需要再说（详见 docs/ARCHITECTURE.md v0.25 §6.3）。

---

## 1. 能力表（V1-V9）

| # | 能力项 | 结果 | 证据 / 说明 |
|---|---|---|---|
| V1 | ACP stdio 模式 | ✅ | `opencode acp` 响应 initialize；**protocolVersion 是整数 `1`（u16）**，qwenpaw 用字符串 `"2025-03-26"` |
| V2 | honor `mcpServers[].env` | ✅ | session/new 带 `env.WPS_POLL_PORT=59123` → spawn 的 wps-mcp 进程 `/proc/<pid>/environ` 实读 `WPS_POLL_PORT=59123`（原样透传） |
| V3 | `session/new` 参数兼容 | ✅ | **`mcpServers` 必填数组**（缺了报 `Invalid input: expected array, received undefined`，传 `[]` 即可）；`cwd` 支持；返回 `sessionId` + `configOptions` + `available_commands_update` |
| V4 | `request_permission` option 形状 | ⚠️ 默认不发 | build(primary) 权限 `*` allow → 工具直接执行，无审批环节。前提：若把权限规则改成 `ask` 才会发，届时需补测 option 形状 |
| V5 | `agent_thought_chunk` 是否下发 | ❌ 不发 | 实测 update 类型仅：`tool_call` / `tool_call_update` / `agent_message_chunk` / `usage_update` / `available_commands_update` |
| V6 | `session/load` / `resume` 支持 | ✅ 支持历史恢复 | 实测：不 close 直接 load 成功且上下文恢复（prompt2 答出记忆词 `xyzzy-42`）；close 后 load 也成功（会回放历史消息）。**注意：`session/load` 需要 `cwd` + `mcpServers` 必填**（缺了报 Invalid params） |
| V7 | `session/cancel` 支持 | ❌ 不支持 | `session/cancel` 报 `Method not found`；`sessionCapabilities` 有 close/fork/list/resume，**无 cancel** |
| V8 | agent 概念与枚举 | ✅ | `opencode agent list` → `build (primary)` + permission 规则（`*` allow / `doom_loop` ask / `external_directory` ask）；`~/.config/opencode/agents/` 有自定义 wps-word/wps-expert 等（skill 式 agent）。**agent 语义 ≠ qwenpaw 命名 agent** |
| V9 | 切换模型参数格式 | ✅ 已确认 | **`session/set_config_option`（configId 参数）生效**：响应 currentValue flash→pro，日志实锤 `providerID=deepseek modelID=deepseek-v4-pro`；**`session/new` 的 `configOptions` 数组不生效**（只读返回，不能用于设置）。切换模型只能用 set_config_option |
| V10 | 无 initialize 直接 session/new | ✅ 接受 | 不发送 initialize 直接 session/new → 直接返回 `sessionId`（`ses_...`），随后正常下发 `available_commands_update`。**前端/bridge 现状流程无需握手注入** |
| V11 | configOptions 改 mode | ✅ 只读；set 生效且会话级 | session/new 带 `configOptions:[{id:"mode",value:"plan"}]` → 响应 mode `currentValue` 仍 `build`（只读）；`session/set_config_option(configId:"mode",value:"plan")` → `currentValue=plan`（生效）；**但新建会话默认仍 `build`（会话级，不跨会话持久）**。agent/mode 切换只能走 set_config_option |

---

## 2. initialize 能力声明（原样记录）

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "embeddedContext": true, "image": true },
    "sessionCapabilities": { "close": {}, "fork": {}, "list": {}, "resume": {} }
  },
  "authMethods": [ { "id": "opencode-login", "name": "Login with opencode" } ],
  "agentInfo": { "name": "OpenCode", "version": "1.18.23" }
}
```

**要点**：
- **多模态**：`promptCapabilities.image: true`（qwenpaw 不支持）——图片上传在 opencode 可能可行
- **无 cancel**：`sessionCapabilities` 无 cancel，中止只能 close/fork/list/resume
- **无审批默认**：opencode 的审批不在 ACP 层，靠 permission 规则（build 全 allow）

---

## 3. session/new 返回（原样记录）

```json
{
  "id": 2,
  "result": {
    "sessionId": "ses_...",
    "configOptions": [
      { "id": "model", "category": "model", "type": "select", "currentValue": "deepseek/deepseek-v4-flash", "options": [...] },
      { "id": "effort", "category": "thought_level", "type": "select", "currentValue": "low", "options": [{"value":"low"},{"value":"high"},{"value":"max"}] },
      { "id": "mode", "category": "mode", "type": "select", "currentValue": "build", "options": [{"value":"build"},{"value":"plan"}] }
    ]
  }
}
```

**要点**：
- `configOptions` 是**数组**（model / effort / mode），不是对象
- 默认模型已切 deepseek（`~/.config/opencode/opencode.json`，见 §5）
- 建会话后还有下行通知 `available_commands_update`（前端需忽略）

---

## 4. 实测一次完整 prompt 生命周期（update 类型序列）

```
session/new
  → available_commands_update
session/prompt（"请用 bash 运行 echo hello-acp-probe"）
  → tool_call (bash, pending)
  → tool_call_update ×4
  → agent_message_chunk ×5（"hello-acp-probe" 逐段）
  → usage_update
  → result { stopReason: "end_turn" }
```

**对看门狗的意义**：opencode 思考/工具执行期间**没有任何 thought chunk**，只有 tool_call / agent_message_chunk / usage_update 等下行。**看门狗必须改为"任意下行续命"**，否则工具执行期会被误判中断（C6 必改）。

---

## 5. opencode 模型配置（2026-09-05 已就位）

`~/.config/opencode/opencode.json`（原配置已备份为 `opencode.json.bak.20260905212652`）：

- 新增 provider `deepseek`（`@ai-sdk/openai-compatible`）：
  - baseURL：`http://120.26.36.89:18080/v1`
  - apiKey：`<已写入本机 ~/.config/opencode/opencode.json，明文密钥不入库>`
  - model：`deepseek/deepseek-v4-flash`（端点还暴露 `-vision-exp` / `-pro`）
- 默认模型从 `ollama/qwen3.5:4b`（本地 ollama 未运行，连不上）改为 `deepseek/deepseek-v4-flash`
- 保留 agnes / ollama provider 与 `wps-office` MCP 配置不动

**验证**：`opencode run --model deepseek/deepseek-v4-flash "回复OK"` 返回 OK；ACP session/new 默认模型已生效。

---

## 6. 对 adapter 的具体含义（供 Phase 1/2）

| 项 | opencode adapter 要做 |
|---|---|
| spawn | `opencode acp --cwd <dir>`（无 `--agent`） |
| protocolVersion | 整数 `1`（qwenpaw 字符串） |
| initialize | **无需发送**（V10 ✅：无 initialize 直接 session/new 被接受） |
| session/new | 必带 `mcpServers` 数组（可为 `[]`） |
| agent 发现 | `opencode agent list`（build/plan + 自定义 skill agent），语义 ≠ qwenpaw |
| agent 切换 | `session/set_config_option(configId:"mode")`（V11 ✅：configOptions 只读、set 会话级，非 kill+restart） |
| 审批 | 默认无审批（能力标志 `no_approval`）；ask 规则时需手动确认 |
| 看门狗 | 任意下行续命（不依赖 thought chunk） |
| 中止 | `session/close`（破坏会话）或停止等待，不支持 cancel |
| 模型选择 | `set_config_option`（configId）或 configOptions 数组（V9 待确认） |

---

## 7. 待补测（进入 Phase 2/3 前）

- ~~V6~~ ✅ 已完成：`session/load` 支持历史恢复（close 后仍可 load，需 cwd+mcpServers 必填）
- ~~V9~~ ✅ 已完成：模型切换用 `session/set_config_option`（configId 参数）生效；session/new 的 configOptions 只读
- ~~V10~~ ✅ 已完成（2026-09-06）：**无 initialize 直接 session/new 被接受**（直接返回 sessionId）——前端/bridge 现状流程可直接跑 opencode，无需握手注入
- ~~V11~~ ✅ 已完成（2026-09-06）：**configOptions 改 mode 不生效（只读，同 model）；`set_config_option(configId:"mode")` 生效且为会话级**（新建会话默认仍 build）——agent/mode 切换只能走 set_config_option
- 若用户改 opencode 权限为 `ask`：补测 request_permission 的 option 形状（V4 前提变更时）
