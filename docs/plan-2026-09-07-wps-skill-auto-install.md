# WPS Skill 自动安装脚本（方案 C：独立脚本，文件复制 + enable）

> 状态：✅ v2 已实施（2026-09-08 落地更新；实施记录见 §11）
> 日期：2026-09-07（v2 追加同日，2026-09-08 实施）
> 对应：wps skill 接入决策（5 分裂 skill 保持 opencode-wps 结构 / 先实机评估 /
> P16 preamble 增强 / **v2 降级要求**）；本方案只覆盖「QwenPaw 侧 skill 自动安装」。
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
5. **（v2 追加）降级要求**：同一 agent 有两个对话入口——WPS 插件（ACP 注入
   wps-mcp，工具可用）与 QwenPaw 网页控制台（无 wps-mcp，无工具）。skill 是
   工作区级共享，两个入口都会加载；为避免网页控制台触发 skill 时「找不到工具 →
   幻觉调用」，安装时给 5 个 skill 统一追加「环境检查与降级要求」块（标准文案
   与决策依据见 §12）。

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
8. **安装期 transform（v2 新增）**：复制每个 skill 的 SKILL.md 时统一追加
   「环境检查与降级要求」块（标准文案见 §12）。源目录（submodule）保持上游原样，
   不直接改源文件；判据 = 当前会话工具列表是否存在 `wps_` 前缀工具。transform
   幂等：目标已含降级块则跳过（§5 #12）。

## 3. 硬约束（不许违反）

- **约束 1**：**零 fork**——不改 wps-office-mcp 源码、不改 QwenPaw 源码、
  不改 opencode 侧任何东西。
- **约束 2**：**不碰 opencode skills**——绝不写 `~/.opencode/skills/`。
- **约束 3**：**不手动改 skill.json**——启用的唯一途径是 QwenPaw 官方 CLI/API，
  由它自己管理状态文件。
- **约束 4**：**不引入外部依赖**——只用标准库 / 系统命令，风格对齐项目现有
  `scripts/`（install.sh、check-wps-macro-security.sh）。
- **约束 5**：脚本放 `scripts/` 目录，命名自定。
- **约束 6（v2 新增）**：**不改源目录**——`third_party/opencode-wps` 是 git
  submodule（.gitmodules → lnxsun/opencode-wps），降级块只能在复制时注入
  （transform），禁止直接编辑源 SKILL.md。

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
- 5 个 skill 全部引用 `wps_` 前缀工具（公共入口：wps_office_execute /
  wps_get_active_document / wps_execute_method 等）→ 降级判据统一用「工具列表
  是否有 `wps_` 前缀」，不依赖具体 skill 的工具差异
- 降级块以「## ⚠️ 环境检查与降级要求」标题为唯一标记（transform 检测 / #11 升级
  判定 / #12 防重复追加都用它）

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
| 10 | **源/目标同名但内容不同** | 判定基准 = **transform 后的预期内容**。目标含降级块且其余与源一致 → 就位（无操作）；目标**缺降级块** → 未装好，重新复制（#11）；目标有降级块但其余内容与源不一致 → 已知限制：报告差异但不覆盖 |
| 11 | **已安装但 SKILL.md 缺降级块**（升级场景，v2 新增） | 视为未装好：重新复制（带 transform），其余 skill 不动，退出码 0 |
| 12 | **源已自带降级块**（上游未来更新后，v2 新增） | transform 幂等：检测到已含降级块则跳过追加，不重复（源与目标都查） |

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
5. 单元测试覆盖 §5 边界表 12 个场景（原 10 + v2 新增 #11/#12），全绿
6. `--help` 文档化退出码契约
7. 安装后每个 SKILL.md 末尾含「环境检查与降级要求」块，且只有一份（不重复追加）
8. 源目录未被修改（`git -C third_party/opencode-wps status --porcelain` 干净）
9. 单元测试覆盖 §5 边界表 #10（transform 后基准）/ #11 / #12
10. 实机行为验收（不属单元测试）：在 QwenPaw 网页控制台（无 wps 工具）触发
    wps skill → agent 不调用不存在的工具、给出引导而非编造（§8 诊断候选）

## 8. 诊断候选（🟡 不预定结果）

以下方向只是候选，code agent 可独立选择/组合/另辟蹊径，只要满足 §2 任务 +
§3 约束 + §5 边界 + §7 验收：

- ⚠️ **未验证点**：复制后立即调 `qwenpaw skills enable`，在「清单调和」发生之前，
  enable 是否会失败 / 找不到条目？若会，需要什么补齐动作（触发调和 / 重试 /
  其它）才能让 enable 生效。独立诊断并选最稳妥路径，但必须遵守「不手动改
  skill.json」约束。
- 检测「已安装且启用」的判据：读 skill.json vs 跑 `qwenpaw skills list`，各自
  的准确度 / 开销 / 与「清单调和」时序的关系，由 code agent 实测决定。
- 🟡 **降级块行为有效性（v2 新增）**：模型是否真的在无 `wps_` 工具时遵守
  「不调用 / 不编造 / 引导用户」？由实机在网页控制台入口验证（§7 验收 10），
  不由单元测试覆盖；若实测模型不遵守，再考虑 P16 preamble 兜底强化。

**任何方案必须同时考虑「不手动改 skill.json」与「enable 在调和前失败」两个约束。**

## 9. 非目标（不做）

- ❌ 不做 bridge 集成（`QwenpawAdapter.switch_agent` 检测调脚本）——后续单独任务
- ❌ 不做「内容不一致时自动覆盖」——已知限制，升级需单独决策。**唯一例外**：
  SKILL.md 缺降级块 = 未装好，重新复制（§5 #11），这是 ensure 语义的一部分而非
  覆盖语义。
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

### v2 实施记录（2026-09-08，降级要求——已完成）

- 交付物（v1 同名文件内追加，无新文件）：
  - `scripts/ensure-wps-skills.py`：新增 `DEGRADATION_MARKER` / `DEGRADATION_BLOCK`
    常量（文案对齐 §12）、`transform_skill_content`（幂等 transform）、
    `has_degradation_block`、`skill_needs_install`、改写 `copy_skill_files`
    （SKILL.md 带 transform 写入，README.md 原样 copy2）、`collect_diffs`
    （SKILL.md 基准 = transform 后预期内容）、`ensure_one_skill`
    （缺 SKILL.md 或缺降级块 → copy/re-copy）。
  - `scripts/test_ensure_wps_skills.py`：全 12 边界场景 + 3 附加，ALL PASS。
- 判据定案：
  1. 降级块检测 = **完整降级块位于内容末尾**（`content_has_degradation_block`，
     `endswith(DEGRADATION_BLOCK.rstrip)`）。比「标题子串任意位置」更严：标题孤行 /
     残缺块不会误判为已装好（§5 #11 保证可补全），与 `collect_diffs` 的「transform
     后基准 = 末尾整块」一致。review 后收紧（原实现为子串判定）。实测
     wps-proofread 源内容自带 `## ⚠️ 批次大小限制` 标题，精确匹配可正确区分。
  2. `skill_needs_install`：目标 SKILL.md 缺失**或**缺完整降级块 → 重装（§5 #11）；
     含降级块但其余与源不一致 → 不重装、`collect_diffs` 报告差异不覆盖（§5 #10）。
  3. 复制后 enable 语义不变（v1 已核实调和机制）；re-copy 已完成但 skill 本就
     enabled → 状态记 `repaired`（action=re-copy），区别于全无操作。
  4. dry-run 升级场景（已装缺块）先查 `skill_info` 启用态，报 `would re-copy` /
     `would re-copy+enable`（与实际运行一致）；CLI 不可用时回退 `re-copy+enable`。
     （review 后补充，原实现一律报 re-copy+enable。）
- 退出码契约无变化（0/1/2/3/4 同 v1，§6 冻结）。
- 实测验收（真实 qwenpaw 2.2.0 + 临时 agent `wps-skill-v2-test-0908`，已清理）：
  首次全装 → 5 skill 各含降级块恰好 1 份、enabled=true、退出 0；二次运行幂等
  （5 ok 无动作）；strip 1 个 skill 降级块后重跑 → 该 skill `repaired`，降级块
  恢复且仍 1 份；源 submodule `skills/` 零改动；default 工作区未污染。
- 新增测试：transform 追加（边界3 扩展）/ 幂等不重复（#12，源已含块）/ 缺块升级
  重装（#11）/ 含块内容不一致报告不覆盖（#10 改造）/ 源目录未被修改 / 标题孤行
  视为未装好补全 / dry-run 对已启用缺块 skill 报 re-copy 不虚报 enable。

---

## 12. 决策记录（2026-09-07 v2：skill 降级要求）

### 背景

同一 agent 有两个对话入口：
- **WPS 插件**（ACP session/new 注入 wps-mcp → transient driver，工具可用）；
- **QwenPaw 网页控制台**（无持久 wps driver，无工具）。

skill 是工作区级，两个入口共享。多窗口是刚需（每 wps-mcp ↔ 打开的 WPS 文档
1:1，见 ARCHITECTURE.md 路线 P），因此 qwenpaw 侧持久配置 wps-mcp 不可行：
单实例单端口 58891 → 多窗口端口抢占 / 命令串台（v0.15/v0.17 已实测）；且网页
控制台没有「当前文档」语义（没有 addon 在监听它该连的端口）。**结论：保留
ACP 注入，skill 层优雅降级。**

### 降级块标准文案（安装期 transform 追加到每份 SKILL.md 末尾）

```markdown
## ⚠️ 环境检查与降级要求

本 skill 依赖 wps-mcp 提供的 `wps_*` 工具。这些工具只在「WPS 侧边栏插件入口」
的会话中存在（该入口经 ACP 注入 wps-mcp）。

**执行任何 WPS 操作前，先检查当前会话工具列表中是否有 `wps_` 前缀的工具。**

- 有 → 正常执行本 skill 描述的操作。
- 没有（例如在 QwenPaw 网页控制台等其它入口对话时）→
  1. 不要尝试调用不存在的 wps 工具；
  2. 不要编造或猜测操作结果；
  3. 不要承诺「帮你打开 WPS」这类无法兑现的动作；
  4. 明确告知用户：当前入口未挂载 WPS 能力，请在 WPS 侧边栏插件入口操作。
```

### 判据可靠性

`wps_` 前缀工具的可见性来自模型自身 function schema（工具存不存在是可见事实），
比让模型猜「我在哪个入口」可靠；与 9/4 四组合实测结论一致（工具有没有只看
session 注入，与 agent 自身是否配置 wps-mcp 无关）。

### 实现要点

- transform 挂在 `copy_skill_files`（ensure-wps-skills.py:208 附近），复制时追加；
- 幂等：源或目标已含降级块则跳过（§5 #12）；
- 升级：已装缺块 = 重新复制（§5 #11）；
- 源 submodule 保持上游原样（§3 约束 6）；
- 行为有效性（模型是否遵守）由实机在网页控制台入口验收（§7 验收 10 / §8）。
