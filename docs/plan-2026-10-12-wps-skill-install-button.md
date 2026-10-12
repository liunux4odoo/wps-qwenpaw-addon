# 开发方案：WPS 插件 skill 安装入口（切换 agent 时检测缺失 + 安装按钮）

> 状态：已实施（2026-10-12，按评审意见：路径 X `--check-only`、检测 120s/安装 300s 超时、opencode server 隔离）
> 日期：2026-10-12
> 背景：`ensure-wps-skills.py` 已存在但从未被任何流程调用，5 个 wps-* skill
> 从未安装到任何 agent 工作区，导致智能体报「wps-word skill 不存在」。本方案
> 给这个脚本提供一个**用户可见的触发入口**：切换 agent 时检测该 agent 是否缺
> 少 wps-* skill，缺失则在前端提示并提供「一键安装」。

---

## 1. 目标（WHAT）

1. **检测**：插件侧能查询"当前 agent 是否已安装并启用 5 个 wps skill"。
2. **提示**：切换 agent（或打开侧边栏）后，若检测到该 agent 缺 skill，在插件界面给出明确提示。
3. **安装**：提示处提供「安装 skill」按钮，点击后为该 agent 安装 5 个 wps skill，完成后刷新检测状态。

非目标（NOT scope）：
- 不自动静默安装（用户要能看见并掌控）。
- 不改 `ensure-wps-skills.py` 的退出码契约与既有行为。
- 不新增「按文档类型只装部分 skill」的粒度（5 个全装）。
- 不实现"所有 agent 一键全装"（一次只装当前选中的 agent）。
- 不处理安装后 P16 preamble 的 skill 引导文案（独立议题，见 §7 遗留）。

---

## 2. 现状与接入点（已核实）

| 层 | 现状 | 本次改动点 |
|---|---|---|
| 后端脚本 | `scripts/ensure-wps-skills.py` 现成：复制 SKILL.md + transform 降级块 + `qwenpaw skills enable`；退出码 0/1/2/3/4 冻结 | **不改**，直接调用 |
| bridge | `acp-bridge.py` 已有 `asyncio.create_subprocess_exec` 先例（536 行启动 ACP 子进程）；HTTP 路由在 `_handle_http`（868 行起 if/elif 链）：`/status /config /agents /agent/set /servers /server/set ...` | **新增 2 个路由**（见 §4） |
| 前端 | `agents.js` 已有 agent 列表加载（`/agents`）+ 切换（`/agent/set`）；`taskpane.html` 有 `agentSelect` 下拉 + `settingsPanel` 设置面板 | **新增检测/提示/安装按钮**（见 §5） |

依赖关系：前端 XHR → bridge HTTP 路由 → `ensure-wps-skills.py`（subprocess）→ qwenpaw CLI → 目标 agent 工作区。链路每跳都已有先例，无新机制引入。

---

## 3. 契约冻结项（Frozen Contracts）

这些是**不可破坏的现有契约**，改动必须保持：

1. `ensure-wps-skills.py` 退出码契约（bridge 已依赖）：
   - `0` 全部就位（本次无操作或补齐成功）
   - `1` 用法/配置错误（缺 --agent-id、源目录缺失、agent 不存在、找不到 qwenpaw CLI）
   - `2` qwenpaw CLI 调用失败
   - `3` 部分失败（部分 skill 复制/启用失败）
   - `4` 完全失败
2. 调用方式：`python scripts/ensure-wps-skills.py --agent-id <ID> --json`（`--json` 输出机器可读摘要）。
3. 前端既有 XHR 模式：`XMLHttpRequest` + `http://127.0.0.1:8766/<path>`，timeout 需覆盖子进程执行耗时（见 §5 提示）。
4. 前端现有状态容器 `QP.state` 与消息通道 `ChatUi`（提示/错误展示用），不新造机制。

---

## 4. Bridge 改动（WHAT）

**新增路由 A：`GET /skills?agent=<ID>` — 检测**
- 入参：`agent`（agent id）。
- 行为：对 5 个 wps skill 各做一次"是否存在且启用"判定。
- 返回：`{"ok": true, "agent": <ID>, "missing": [skill...], "installed": [...], "detail": {skill: {installed, enabled, path}}}`。
- 判定方式：**不许**自己读文件/解析 skill.json，必须复用脚本能力（见 §4.3）。

**新增路由 B：`POST /skills/install?agent=<ID>` — 安装**
- 入参：`agent`（agent id）。
- 行为：调用 `ensure-wps-skills.py --agent-id <ID> --json`，等待完成。
- 返回：透传脚本 JSON 摘要 + 退出码映射：
  `{"ok": bool, "exit_code": 0|1|2|3|4, "summary": {...}, "skills": {...}}`。
- 超时：脚本执行可能数十秒（5 个 skill 逐个 `qwenpaw skills info` + `enable`，qwenpaw 冷启动慢），超时上限需明显大于单次 qwenpaw 调用 60s 上限（脚本内部已有 QWENPAW_TIMEOUT=60s，外层应给到 ~180s）。

**4.3 检测判定方式（重要边界）**
`ensure-wps-skills.py` 目前**没有"只检测不安装"的独立子命令**。两个可选实现路径，请在方案评审时二选一敲定：

- **路径 X（推荐）：给脚本加 `--check-only` 标志**。脚本内部已有 `skill_info()` 与"need_install"判定逻辑，只加一个不落盘、不 enable 的分支，输出与现有 `--json` 同构。**契约影响**：新增可选参数，不改既有默认行为与退出码（`--check-only` 下退出码沿用现有语义：0=全部就位，3=部分缺失，4=全部缺失）。
- 路径 Y：bridge 直接解析 `qwenpaw skills info`（绕过脚本）——**不推荐**，违反"复用脚本、不手动改 skill.json/不重复判定逻辑"的既定原则，造成两处判定逻辑漂移。

> 敲定建议：路径 X。改动最小、复用现有 `skill_info()`，且保持"唯一判定源在脚本"。

---

## 5. 前端改动（WHAT）

**检测时机**（两处）：
1. **agent 切换成功后**（`agents.js` 的 `switchAgent` 成功后）→ 触发一次检测。
2. **侧边栏打开/加载完成时**（初始化链路已有 `loadAgentList`）→ 对当前 agent 触发一次检测。

**UI 呈现**：
- 在 `taskpane.html` 的**设置面板**（`settingsPanel`）内新增一行：当前 agent 的 wps skill 状态。
  - 全就位 → 显示「wps skill 已就绪 ✅」（不打扰）。
  - 缺失 → 显示「当前 agent 缺少 wps-word / wps-excel / wps-ppt / wps-office / wps-proofread」+ **「安装」按钮**。
- 安装按钮点击后：调 `POST /skills/install`，按钮变「安装中…」并禁用；完成后刷新检测状态；失败则用 `ChatUi.addMessage('error', ...)` 展示脚本摘要中的错误。

**交互细节约束**：
- 检测接口 timeout 需 ≥ 15s（5 个 skill 逐个判定，qwenpaw 冷启动可能慢）；安装接口 timeout 需 ≥ 180s。
- 安装期间不阻塞对话主流程（异步 XHR）。
- 所有提示文案用中文，与现有 UI 一致。

---

## 6. 验收（可执行）

**单元/集成（bridge 侧）**：
1. `python scripts/ensure-wps-skills.py --agent-id <真实agent> --check-only --json` → 输出 `missing` 含 5 个 skill（当前确实未装）。
2. `python scripts/ensure-wps-skills.py --agent-id <真实agent> --json` → 退出码 0/3（补齐后应 0），summary 显示 repaired。
3. 再次 `--check-only` → missing 为空。
4. 启动 bridge → `curl "http://127.0.0.1:8766/skills?agent=<真实agent>"` → 返回 missing 列表。
5. `curl -X POST "http://127.0.0.1:8766/skills/install?agent=<真实agent>"` → 返回 ok=true，summary.repaired=5（或 ok=5）。
6. 重复 4 → missing 为空。

**端到端（真机 WPS）**：
7. 重启 WPS + 打开文档 + 打开侧边栏 → 设置面板显示「wps skill 已就绪」或缺失提示。
8. 切换 agent（选一个未装 skill 的）→ 设置面板出现缺失提示 + 安装按钮。
9. 点「安装」→ 完成后提示消失；对该 agent 发指令触发文档操作 → 智能体能读到 `wps-word` skill（不再报「不存在」）。

**回归**：
10. `node --check` 全部 JS 通过；`python -m pytest bridge/` 全绿（现有 bridge 测试不回归）。

---

## 7. 遗留（非本次 scope，单独决策）

- **P16 preamble 引导**：即使 skill 装好了，智能体默认不知道去读它。09-07 拍板"preamble 加一句'操作 WPS 前先参考 wps-word/excel/ppt skill'"未落地，与本方案无依赖，独立排期。
- **安装粒度**：当前 5 个全装；是否需要"只装当前文档类型对应 skill"（word 文档只装 wps-word）留待后续评估，避免过度设计。

> 2026-10-12 补充定案：**升级覆盖语义已实施**（`ensure-wps-skills.py`）。
> 源与目标内容不一致（源更新）不再只报告，`--check-only` 会将该 skill 计入
> `missing`（message=「源已更新（内容不一致），可重装」），安装时 `re-copy`
> 覆盖旧内容（含 README.md），保持幂等。

---

## 8. 交付物清单

| 交付物 | 说明 |
|---|---|
| `bridge/acp-bridge.py` | +2 路由（`/skills`、`/skills/install`） |
| `scripts/ensure-wps-skills.py` | +`--check-only` 分支（路径 X 敲定后） |
| `taskpane.html` + `css/taskpane.css` | 设置面板 skill 状态行 + 安装按钮样式 |
| `js/agents.js` | 检测触发（切换后 + 加载时）+ 安装交互 |
| 测试 | bridge 路由测试（`bridge/test_*.py`）+ 真机 E2E 步骤（§6） |
