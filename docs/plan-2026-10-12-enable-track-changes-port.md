# 开发方案：移植 enableTrackChanges / getTrackChangesStatus 到插件执行器

> 状态：已实施（js/poll.js + js/wps-bridge.js，静态/回归测试通过）；§5.0 真机探针 + E2E 验收待执行
> 日期：2026-10-12
> 背景：`wps_word_enable_track_changes` / `wps_word_get_track_changes_status`
> 调用报「未支持的命令」。诊断确认是上游断链：gateway/proofread.ts 有定义，
> 但 opencode-wps-linux 执行层无实现（更新上游后仍未修复）。WPS Linux JSAPI
> 已验证支持修订模式（`KyWpsDocument::put_TrackRevisions`/`get_TrackRevisions`），
> 方案 A = 插件侧绕过断链直连 WPS JSAPI 实现。

---

## 1. 目标（WHAT）

在插件执行器（`js/poll.js` + `js/wps-bridge.js`）实现两个 action，使
`wps_word_enable_track_changes` / `wps_word_get_track_changes_status`
能从「未支持的命令」变为正常执行：

1. **`enableTrackChanges`**：开启/关闭当前活动 Word 文档的修订模式。
2. **`getTrackChangesStatus`**：查询当前活动 Word 文档的修订模式状态。

非目标（NOT scope）：
- 不改动上游 opencode-wps（零 fork 铁律，且上游未修复）。
- 不实现 proofread 模块其余工具（replaceInParagraph / proofreadBasic /
  confirmBatchAiProofread——若也有断链，另立方案）。
- 不改 WPS JSAPI 本身（已验证原生支持）。
- 不做 Windows/Mac 兼容（插件跑在 Linux）。

---

## 2. 现状与接入点（已核实）

### 断链链路
```
wps_office_search 索引 ✅（gateway:262-263）
  → MCP handler ✅（proofread.ts enableTrackChangesHandler → invokeAction('enableTrackChanges'))
  → opencode-wps-linux 执行层 ❌（无 trackChanges action）
  → 插件执行器 ❌（POLL_ACTION_MAP 无 / wps-bridge.js 无）
  → 报「未支持的命令」（poll.js else 分支）
```

### 上游契约（入参/出参，必须对齐）
- **enableTrackChanges**：
  - 入参：`{ enable: boolean }`（true=开启，false=关闭）
  - 响应需含：`success: boolean`、`trackChanges: boolean`、`active: boolean`
  - 成功文案：`修订模式已开启/已关闭！所有后续修改将被跟踪记录。`
- **getTrackChangesStatus**：
  - 响应需含：`success: boolean`、`active: boolean`（读取修订状态）
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

---

## 4. 改动要求（WHAT）

### 4.1 `js/poll.js`
- `POLL_ACTION_MAP` 增加两个映射：
  - `enableTrackChanges: 'enableTrackChanges'`
  - `getTrackChangesStatus: 'getTrackChangesStatus'`

### 4.2 `js/wps-bridge.js`
- 新增 `enableTrackChanges(params)` 方法：
  - `getActiveDoc()` → 无文档 fail
  - `params.enable` 缺省/非 boolean 处理：按上游契约（缺省视为 true？或
    invalidParam？——**由 code agent 按上游定义决定，方案不预定**；但返回
    必须含 success/trackChanges/active）
  - 设置 `doc.TrackRevisions = enable`（精确属性形式实施时探针确认）
  - 返回 `ok({ success: true, trackChanges: enable, active: enable })`
- 新增 `getTrackChangesStatus()` 方法：
  - `getActiveDoc()` → 无文档 fail
  - 读 `doc.TrackRevisions`（或等价读 API）
  - 返回 `ok({ success: true, active: <实际状态> })`
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

### 回归
9. 现有 bridge/skill 测试全绿（`python3 bridge/test_skills_route.py`、
   `python3 bridge/test_adapter.py`）。
10. 同步到已安装 addon 目录，重启 WPS 后重复 4-8。

---

## 6. 交付物清单

| 交付物 | 说明 |
|---|---|
| `js/poll.js` | +2 个 POLL_ACTION_MAP 映射 |
| `js/wps-bridge.js` | +2 个方法（enableTrackChanges / getTrackChangesStatus） |
| 同步 | 复制到已安装 addon 目录（`~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/js/`） |
| 真机探针记录 | 5.0 步骤的确认结果（属性访问形式），附在提交说明 |
