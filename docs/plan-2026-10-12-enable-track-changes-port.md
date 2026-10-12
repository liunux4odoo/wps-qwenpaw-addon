# 开发方案：移植 enableTrackChanges / getTrackChangesStatus 到插件执行器

> 状态：已实施并提交（10101dd + cef4fe6，js/poll.js + js/wps-bridge.js，静态/回归测试通过）；
> ⚠️ §5.0 真机探针 + E2E 验收待执行。
> 日期：2026-10-12（2026-10-12 重核后修订）
> 背景：`wps_word_enable_track_changes` / `wps_word_get_track_changes_status`
> 调用报「未支持的命令」。诊断确认是**上游 Linux 路径断链**：
> gateway/proofread.ts 有定义及 handler，**上游 Windows 路径（wps-com.ps1
> PowerShell COM）已完整实现并修复**（RC-3 谎报成功 / #401 缺省语义），
> 但 opencode-wps-linux 执行层（Linux/assistant/shared 三层）无实现——0 命中。
> WPS Linux JSAPI 已验证支持修订模式（`KyWpsDocument::put_TrackRevisions`
> /`get_TrackRevisions`），方案 A = 插件侧绕过断链直连 WPS JSAPI 实现，
> **契约对齐上游 Windows 实现 + 吸收 RC-3/#401 修复教训**。

---

## 1. 目标（WHAT）

在插件执行器（`js/poll.js` + `js/wps-bridge.js`）实现两个 action，使
`wps_word_enable_track_changes` / `wps_word_get_track_changes_status`
能从「未支持的命令」变为正常执行：

1. **`enableTrackChanges`**：开启/关闭当前活动 Word 文档的修订模式。
2. **`getTrackChangesStatus`**：查询当前活动 Word 文档的修订模式状态。

非目标（NOT scope）：
- 不改动上游 opencode-wps（零 fork 铁律；上游 Linux 路径本就不实现，改上游
  等于替上游补功能，超出零 fork 边界；上游 Windows 路径无需动）。
- 不实现 proofread 模块其余工具（replaceInParagraph / proofreadBasic /
  confirmBatchAiProofread——若也有 Linux 断链，另立方案）。
- 不改 WPS JSAPI 本身（已验证原生支持）。
- 不做 Windows/Mac 兼容（插件跑在 Linux；Windows 已有上游 wps-com.ps1 实现）。

---

## 2. 现状与接入点（已核实，2026-10-12 用上游 7e0128a 全树重核）

### 断链链路（Linux 路径）
```
wps_office_search 索引 ✅（gateway:262-263）
  → MCP handler ✅（proofread.ts enableTrackChangesHandler → executeMethod('enableTrackChanges'))
  → wps-client.ts 平台分流 ✅（win32→PowerShell COM / linux→linuxPollServer / darwin→macPollServer）
  → Linux 执行层 ❌（opencode-wps-linux / opencode-wps-assistant / shared / src/poll 四目录
                     trackChanges|TrackRevisions|Revisions|AcceptAll|put_Track 全 0 命中）
  → 插件执行器（原 ❌，现已实现 ✅）
  → 报「未支持的命令」（poll.js else 分支，未实现 action 的兜底）
```

### 上游现状（7e0128a 全树核实，修正此前"上游未修复"结论）
- **Windows 路径已完整实现**：`wps-office-mcp/scripts/wps-com.ps1` 有
  `enableTrackChanges`（`$doc.TrackRevisions = $enable` + 真实回读 `active`）
  与 `getTrackChangesStatus`（回读 + `Revisions.Count`）。
- **修复教训（移植必须吸收）**：
  - **RC-3 / Issue #395「enableTrackChanges 谎报成功」**：PS1 一次往返里
    `trackChanges = $enable`（回写入参回显）+ `active = $doc.TrackRevisions`
    （真实回读）同属一次往返，**无法区分「真生效」与「写入被静默拒绝」**。
    上游修复 = **另起一次独立 `getTrackChangesStatus` 往返**取真值，不一致即
    判失败（`proofread.ts` 中 `actual !== wantEnable → failResult`）。
  - **Issue #401「缺省语义反转」**：`wantEnable = !(enable === false)`——
    仅显式 false 才算请求关闭，缺省 = 开启（与治理层 `governance.js`
    `wantEnable` 同口径；此前 `enable === true` 把缺省误当 false）。
  - **Issue #382「method 放 params 里」**：兼容 `method` 参数位置（网关层）。
- **当前插件实现（10101dd）与上游教训的差距**：
  - `enableTrackChanges` 直接返回 `active: enable`（回写入参回显）——
    **正是 RC-3 bug 修复前的行为**，需补独立回读（§4.2）。
  - 缺省语义已对齐（`enable === undefined/null → true`，非布尔拒绝）✅。

### 上游契约（入参/出参，必须对齐）
- **enableTrackChanges**：
  - 入参：`{ enable: boolean }`（true=开启，false=关闭；缺省=开启）
  - 响应需含：`success: boolean`、`trackChanges: boolean`、`active: boolean`
  - 成功文案：`修订模式已开启/已关闭！所有后续修改将被跟踪记录。`
  - ⚠️ 上游 handler 会**另起一次** `getTrackChangesStatus` 独立回读校验，
    插件响应不一致时由 handler 判失败。插件自身也应按 RC-3 教训返回
    **真实回读值**（见 §4.2 修订），双保险。
- **getTrackChangesStatus**：
  - 响应需含：`success: boolean`、`active: boolean`、`revisionCount: number`
    （上游 Windows 返回 `trackChanges` + `revisionCount`）
- 上游 handler 期望从 `executeMethod` 返回 `{ success, data: { active } }` 结构。

### WPS JSAPI（已验证存在）
- `libwpsapi.so`：`KyWpsDocument::put_TrackRevisions` / `get_TrackRevisions`
- 对应 JS 访问形式：`Application.ActiveDocument.TrackRevisions`（属性读写，
  与 word-handler.js 现有 `Application.ActiveDocument` 直访问模式一致）
- 残余风险：属性名精确形式（`TrackRevisions` vs `set_TrackRevisions`）需
  实施时真机探针确认（§5 验收含此步）。

### 插件执行器现有模式（移植参考）
- `js/wps-bridge.js` `getComments`（918 行）：`getActiveDoc()` → 读属性 →
  `ok({...})` / `fail(msg)` 返回。
- `js/poll.js` `POLL_ACTION_MAP`（14 行起）：`action: '方法名'` 映射。

---

## 3. 契约冻结项（Frozen Contracts）

1. **上游入参/出参格式不变**（§2 所列）——MCP 侧 handler 直接消费插件响应，
   格式不对会导致搜索/调用方解析失败。
2. **POLL_ACTION_MAP 分发模式不变**：`action → WpsBridge 方法` 映射，
   `wps-bridge.js` 方法返回 `ok()/fail()/invalidParam()` 结构不变。
3. **`getActiveDoc()` 语义不变**：无文档返回 fail('没有打开的文档')。
4. **WPS JSAPI 直连**：不经过上游断链，插件直接调 `Application.ActiveDocument`。
5. **poll.js else 分支「未支持的命令」保留**：作为未实现 action 的兜底，
   不改动（新增的 action 只是不再落入该分支）。
6. **⚠️ RC-3 独立回读（重核后新增冻结）**：enableTrackChanges 必须独立回读
   `doc.TrackRevisions` 取真值，不得直接回写 `active: enable` 造成假成功；
   不一致判失败。对齐上游 Issue #395 修复语义。
7. **⚠️ 缺省语义（重核后新增冻结）**：`enable` 缺省 = 开启（true），仅显式
   `false` 才算请求关闭；非布尔值显式拒绝。对齐上游 Issue #401 修复语义。

---

## 4. 改动要求（WHAT）

### 4.1 `js/poll.js`
- `POLL_ACTION_MAP` 增加两个映射：
  - `enableTrackChanges: 'enableTrackChanges'`
  - `getTrackChangesStatus: 'getTrackChangesStatus'`

### 4.2 `js/wps-bridge.js`（10101dd 已实现，⚠️ 待补 RC-3 独立回读）

**`enableTrackChanges(params)`（已实现，需修订）：**
- `getActiveDoc()` → 无文档 fail
- 缺省语义（已对齐上游 #401）：`enable === undefined/null → true`；非布尔
  → `invalidParam('enable 必须为布尔值')`（当前实现已满足 ✅）
- 设置 `doc.TrackRevisions = enable`（精确属性形式实施时探针确认）
- **⚠️ 修订点（RC-3 教训）**：当前返回 `ok({ success: true, trackChanges:
  enable, active: enable })` 是**回写入参回显**——`TrackRevisions` 写入被
  静默拒绝时无法发现（正是上游 RC-3 修复前的 bug）。**必须改为独立回读**：
  - 设置后**另起一次**读 `doc.TrackRevisions` 取真值 `actual`
  - `actual !== enable` → 返回 fail（含"修订模式设置未生效"文案 + 期望/回读值）
  - 一致 → `ok({ success: true, trackChanges: actual, active: actual })`
  - （上游 handler 侧还有第二道校验，插件先自校验，双保险）

**`getTrackChangesStatus()`（已实现，对齐上游 Windows 契约 ✅）：**
- `getActiveDoc()` → 无文档 fail
- 读 `doc.TrackRevisions` → `active`；`doc.Revisions.Count` → `revisionCount`
  （读失败降级 0，不崩）
- 返回 `ok({ success: true, active, trackChanges: active, revisionCount })`
  （当前实现已满足 ✅；`active` 为 plan 附加字段，与 enableTrackChanges 对齐）
- 遵循现有错误处理：try/catch → `fail('...失败: ' + msg)`。

### 4.3 边界情况（8 维清单）

| 维度 | 期望行为 |
|---|---|
| **无文档** | fail('没有打开的文档')，不崩溃 |
| **enable 非 boolean** | 按上游契约处理（code agent 定：缺省 true 或 invalidParam），不静默 |
| **非 word 文档**（excel/ppt 活动） | WPS 修订是 word 能力；若 doc 无 TrackRevisions 属性 → fail 带明确提示（不抛 TypeError 裸异常） |
| **设置失败**（WPS 拒绝） | fail 返回错误信息，不假成功 |
| **读状态失败** | fail 返回错误信息 |
| **属性访问异常**（JSAPI 形式不符） | try/catch → fail，且日志记录实际属性访问错误（便于探针修正） |
| **返回值格式** | 严格对齐上游契约（success/trackChanges/active） |
| **并发/重复调用** | 无状态操作，天然安全；不引入锁 |

### 4.4 性能/兼容约束
- 不引入新依赖、不修改 WPS API。
- 方法实现与现有 wps-bridge.js 风格一致（IIFE 闭包、ok/fail、errMsg 模式）。
- 属性访问失败时错误信息需含实际异常，便于真机排查。

---

## 5. 验收（可执行）

### 5.0 前置探针（实施第一步，真机）
- 在 WPS 里打开 Word 文档，控制台执行：
  - `typeof Application.ActiveDocument.TrackRevisions`（读属性存在性）
  - `Application.ActiveDocument.TrackRevisions = true; Application.ActiveDocument.TrackRevisions`
    （写读闭环）
- 确认 JS 侧属性访问形式后，再按 4.2 实现。若 `TrackRevisions` 不可访问，
  **停止实施并回报**（可能需改用 `TrackRevisions` 的 get/set 包装或别的 API），
  不得静默改用未验证的 API。

### 单元/集成（静态）
1. `node --check js/poll.js`、`node --check js/wps-bridge.js` 通过。
2. `POLL_ACTION_MAP` 含新映射（grep 断言）。
3. wps-bridge.js 新方法存在（grep 断言）。

### 端到端（真机 WPS）
4. 打开 Word 文档 → 调用 `enableTrackChanges {enable: true}` → 返回
   `success: true`，`active: true`；文档状态栏/修订按钮显示开启。
5. 调用 `getTrackChangesStatus` → 返回 `active: true`。
6. 调用 `enableTrackChanges {enable: false}` → 返回 `active: false`；
   再查 `getTrackChangesStatus` → `active: false`。
7. 无文档时调用 → fail('没有打开的文档')。
8. 非 word 应用（如打开表格）调用 → 明确错误，不崩溃。
9. **⚠️ RC-3 回读验证（修订后新增）**：enableTrackChanges 返回值中的
   `active`/`trackChanges` 必须是**真实回读值**而非回写入参——真机确认：
   开启成功后返回值与文档实际修订状态一致；若 WPS 拒绝写入（如只读文档），
   插件返回 fail 而非假成功（可临时用只读文档验证）。

### 回归
10. 现有 bridge/skill 测试全绿（`python3 bridge/test_skills_route.py`、
    `python3 bridge/test_adapter.py`）。
11. 同步到已安装 addon 目录，重启 WPS 后重复 4-9。

---

## 6. 交付物清单

| 交付物 | 说明 | 状态 |
|---|---|---|
| `js/poll.js` | +2 个 POLL_ACTION_MAP 映射 | ✅ 10101dd 已提交 |
| `js/wps-bridge.js` | +2 个方法（enableTrackChanges / getTrackChangesStatus） | ✅ 10101dd 已提交 |
| RC-3 修订 | enableTrackChanges 改独立回读真值（§4.2） | ✅ cef4fe6 已提交 |
| 同步 | 复制到已安装 addon 目录（`~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/js/`） | ⬜ 待 RC-3 修订后同步 |
| 真机探针记录 | 5.0 步骤的确认结果（属性访问形式），附在提交说明 | ⬜ 待执行 |
