# WPS Skill 自动安装脚本（方案 C：独立脚本，文件复制 + enable）

> 状态：📋 已定稿待实施（2026-09-07，方案 C）
> 日期：2026-09-07
> 对应：wps skill 接入决策（5 分裂 skill 保持 opencode-wps 结构 / 先实机评估 /
> P16 preamble 增强）；本方案只覆盖「QwenPaw 侧 skill 自动安装」。
> 仓库：`/data/myrepo/wps-qwenpaw-addon/`，交付物：`scripts/ensure-wps-skills.*`
> （命名自定）+ 单元测试；**不修改 bridge/servers.py**（bridge 集成是后续单独任务）。

---

## 1. 背景与现象

wps-qwenpaw-addon（WPS 侧边栏 AI 助手，默认后端 QwenPaw 作为 ACP server）。
wps-office-mcp 暴露 250+ WPS 操作工具，QwenPaw agent 需要「skill 使用指南」才能
正确选择工具。opencode-wps 上游已提供 5 个现成分裂 skill（wps-office / wps-word /
wps-excel / wps-ppt / wps-proofread），但只装在 `~/.opencode/skills/`（opencode
后端专用）。QwenPaw 的 skill 按工作区隔离（`$QWENPAW_WORKING_DIR/workspaces/
{agent_id}/skills/`），默认工作区没有这些 skill → QwenPaw 侧 agent 只能靠裸工具
描述多轮试错找工具。

已定决策（2026-09-07）：
1. 保持 opencode-wps 的 5 个分裂 skill 结构；
2. 先实机使用一段时间评估效果，再决定后续；
3. P16 preamble 增强（操作 WPS 前先参考对应 skill）——独立于本方案；
4. **采用方案 C**：写一个独立脚本，负责把 5 个 wps skill 复制到指定 QwenPaw
   agent 工作区并启用。脚本独立可测；bridge 的 `QwenpawAdapter.switch_agent`
   后续会「检测缺则调脚本」。

## 2. 任务（WHAT）

实现一个独立脚本，语义 = **ensure**：确保「5 个 wps skill 在指定 QwenPaw agent
工作区已安装且启用」；不满足则补齐，满足则无操作。

必须支持：
1. 指定目标 agent_id（必填）
2. 解析 QWENPAW_WORKING_DIR（环境变量优先，也支持显式传入）
3. 从源目录复制缺失的 skill（SKILL.md + 配套 README.md，如有）
4. 启用：走 QwenPaw 官方 CLI（`qwenpaw skills enable`）让 QwenPaw 自己更新
   skill.json —— **不手动改 skill.json**
5. 幂等：重复运行无副作用、无重复复制
6. 输出对 bridge 友好的状态摘要（哪些已存在 / 新装 / 启用失败）
7. 退出码语义明确的契约（见「退出码契约」）

## 3. 硬约束（不许违反）

- **约束 1**：**零 fork**——不改 wps-office-mcp 源码、不改 QwenPaw 源码、
  不改 opencode 侧任何东西。
- **约束 2**：**不碰 opencode skills**——绝不写 `~/.opencode/skills/`。
- **约束 3**：**不手动改 skill.json**——启用的唯一途径是 QwenPaw 官方 CLI/API，
  由它自己管理状态文件。
- **约束 4**：**不引入外部依赖**——只用标准库 / 系统命令，风格对齐项目现有
  `scripts/`（install.sh、check-wps-macro-security.sh）。
- **约束 5**：脚本放 `scripts/` 目录，命名自定。

## 4. 已核实的上下文（可直接用，不必重新探索）

- 源目录：`third_party/opencode-wps/skills/` 下 5 个目录，各含 `SKILL.md`
  （frontmatter 含 name + description 触发词）；`wps-office`/`wps-word`/
  `wps-excel`/`wps-ppt` 另含 `README.md`
- 目标路径：`$QWENPAW_WORKING_DIR/workspaces/{agent_id}/skills/{skill_name}/`
- skill.json：`$QWENPAW_WORKING_DIR/workspaces/{agent_id}/skill.json`，
  结构 `skills.<name>.enabled: bool`
- QWENPAW_WORKING_DIR 实际值：`/data/ai_work/qwenpaw-data`（bridge 经 env 传递）
- CLI：`qwenpaw skills enable <name>... --agent-id X` 启用；
  `qwenpaw skills list --agent-id X` 查状态
- 已知机制：手动放置 SKILL.md 后，QwenPaw 在「下次清单调和」时检测并写入
  skill.json（默认 disabled）→ 所以复制后必须走 enable

## 5. 边界情况（期望行为，测试用例来源）

| # | 边界 | 期望行为 |
|---|------|---------|
| 1 | **空源目录**（skills 源缺失） | 失败 + 明确错误，非 0 退出码 |
| 2 | **目标 agent 工作区不存在**（未知 agent_id） | 失败 + 明确错误，非 0 退出码（不擅自创建 agent） |
| 3 | **首次运行**（全缺） | 5 个 skill 目录 + skill.json enabled=true，退出码 0 |
| 4 | **已全装且启用** | 无操作，退出码 0 |
| 5 | **已存在但 disabled** | 只补 enable，不重新复制 |
| 6 | **部分缺失**（缺 1 个） | 只补缺的那个，其余不动 |
| 7 | **QWENPAW_WORKING_DIR 无法解析** | 失败 + 明确错误，非 0 退出码 |
| 8 | **qwenpaw CLI 不可用 / enable 失败** | 不得静默吞掉，反映在退出码和输出里 |
| 9 | **幂等**（连续运行两次） | 第二次与首次退出码一致，无重复复制 |
| 10 | **源/目标同名但内容不同** | **本任务只做「缺失则复制」；内容不一致 = 已知限制：报告差异但不覆盖**，升级覆盖语义需单独决策 |

## 6. 退出码契约（冻结，bridge 依赖）

外部消费者依赖，必须文档化并稳定：
- **0 = 全部就位**（本次无操作，或补齐成功）
- **非 0 = 失败**；建议进一步细分（本就齐全 / 补齐成功 / 部分失败 / 完全失败），
  具体数值自定，但必须写进 `--help` 和测试
- 任何「enable 失败」必须可见，不允许静默忽略

## 7. 验收标准（可执行）

在 `/data/myrepo/wps-qwenpaw-addon` 下执行（用临时 agent_id 测试，**不得污染
default 工作区现有配置**）：

1. 对不存在的 agent_id 运行 → 明确失败 + 非 0 退出码 + 可读错误
2. 对临时 agent_id 首次运行 → 5 个 skill 出现在 `workspaces/{tid}/skills/`，
   skill.json 对应条目 enabled=true，退出码 0
3. 再次运行 → 幂等，退出码一致，无重复复制
4. 删掉某 1 个 skill 目录后运行 → 只补那 1 个，其余不动
5. 单元测试覆盖 §5 边界表 10 个场景，全绿
6. `--help` 文档化退出码契约

## 8. 诊断候选（🟡 不预定结果）

以下方向只是候选，code agent 可独立选择/组合/另辟蹊径，只要满足 §2 任务 +
§3 约束 + §5 边界 + §7 验收：

- ⚠️ **未验证点**：复制后立即调 `qwenpaw skills enable`，在「清单调和」发生之前，
  enable 是否会失败 / 找不到条目？若会，需要什么补齐动作（触发调和 / 重试 /
  其它）才能让 enable 生效。独立诊断并选最稳妥路径，但必须遵守「不手动改
  skill.json」约束。
- 检测「已安装且启用」的判据：读 skill.json vs 跑 `qwenpaw skills list`，各自
  的准确度 / 开销 / 与「清单调和」时序的关系，由 code agent 实测决定。

**任何方案必须同时考虑「不手动改 skill.json」与「enable 在调和前失败」两个约束。**

## 9. 非目标（不做）

- ❌ 不做 bridge 集成（`QwenpawAdapter.switch_agent` 检测调脚本）——后续单独任务
- ❌ 不做「内容不一致时自动覆盖」——已知限制，升级需单独决策
- ❌ 不改 wps-office-mcp / QwenPaw / opencode 源码
- ❌ 不碰 opencode skills（`~/.opencode/skills/`）
- ❌ 不引入第三方依赖

## 10. 契约冲突上抛

实施过程中若发现 §4「已核实上下文」与实际不符，或契约层冲突（例如 enable 在
调和前必然失败且无法用官方 CLI 规避），**不要自己找 workaround 悄悄调和**——
归档为已知限制，在交付说明里明确列出，等真实 caller 证据触发再决定怎么修。

---

## 11. 实施记录（待 code agent 填写）

- 实施日期：2026-09-07
- 交付物：
  - `scripts/ensure-wps-skills.py`（主脚本，方案 C：文件复制 + enable）
  - `scripts/_fake_qwenpaw.py`（测试用 qwenpaw CLI 模拟器，行为对齐真实 CLI）
  - `scripts/test_ensure_wps_skills.py`（单元测试，§5 边界表 10 场景 + 附加 2 场景）
- 退出码表（已写进 `--help` 与测试）：
  - `0` 全部就位（本次无操作，或补齐成功；human/JSON summary 区分 `ok` vs `repaired`）
  - `1` 用法/配置错误：缺 `--agent-id`、源目录缺失/为空、agent 不存在（不擅自创建）、找不到 qwenpaw CLI
  - `2` qwenpaw CLI 调用失败（`agents list` 失败 / 输出非 JSON）
  - `3` 部分失败：部分 skill 复制/启用失败（其余已就位）
  - `4` 完全失败：需要处理的 skill 全部失败
- 已核实的边界（§5 表 10/10）：空源目录 / 未知 agent / 首次全装 / 全装启用无操作 /
  已存在 disabled 只 enable / 部分缺失只补缺 / workspace 无法解析（走 agents list +
  CLI 探测）/ enable 失败可见非静默 / 幂等 / 同名内容不同报告差异不覆盖。
- 健壮性（review 后补充）：单次 qwenpaw 调用超时 60s（`QWENPAW_TIMEOUT`）防挂死；
  主循环捕获 `QwenpawError`/`OSError`，意外 CLI/文件系统错误映射为 FAILED 状态
  （exit 3/4），不产生 traceback、不破坏退出码契约（新增测试覆盖）。
- 已核实的关键机制（§8 诊断结论）：
  1. **复制后立即 enable 可行**：`skills list` / `skills info` / `skills enable` 任一
     调用都会触发「清单调和」识别磁盘上新放的 SKILL.md，无需额外触发动作；
     `skills enable` 复制后直接调用即成功（实测验证）。
  2. **启用/存在性判据采用官方 `skills info`**（`--agent-id`）：exit 1 + `not found` =
     未安装；`Enabled: yes/no` = 状态。比 `skills list` 表格解析更稳，比读 skill.json
     更符合「不手动改 skill.json」约束（判据本身也只经官方 CLI）。
- 与方案 §2/§3 的差异（按用户指示调整）：
  - **不手动解析 QWENPAW_WORKING_DIR**：workspace 目录一律由 `qwenpaw agents list`
    的 JSON `workspace_dir` 字段解析（官方命令），环境变量不再参与路径构造。
  - **不手动创建 agent 工作区**：agent 存在性由 `agents list` 判定，不存在即失败；
    测试用临时 agent 走 `qwenpaw agents create` / `delete --remove-workspace --yes`
    （官方命令），已清理，未污染 default。
- 发现的契约疑虑 / 已知限制：
  1. `qwenpaw skills install` 仅接受 http(s) URL（`bundle_url must be a valid http(s) URL`），
     本地目录无法经 install 导入 → 复制步骤仍必须由本脚本完成，这是「方案 C」的固有边界。
  2. 内容不一致 = 已知限制：只报告差异不覆盖（§5 #10），升级覆盖语义未做（符合方案 §9）。
  3. `agents delete` 需交互确认 → 使用 `--yes --remove-workspace`；本脚本不创建/删除 agent，
     只做只读存在性检查，故不涉及该交互。
