# 开发方案：打开文档瞬间 Path 未就位导致历史/会话丢失的修复

> 状态：待开发（方案 v5，评审通过；2026-10-15 补 G1-G6 修订，G1-G3 为必须项）
> 日期：2026-10-15
> 背景：打开已保存文档时，taskpane 窗格初始化瞬间 `ActiveDocument.Path` 可能
> 尚未填充（空字符串），`makeDocId()` 走 volatile 分支生成
> `appType::unsaved::<随机token>::<文件名>` 的 docId。该 docId：
> （a）不落 localStorage（P23 规则），历史消息全部"看不见"；
> （b）`loadCachedSessionId` 也为空，跳过 session/load 直接 session/new ——
> 用户看到"打开文档历史丢失、AI 失忆"。
>
> 实测：2026-10-15 16:43:37 窗格 A 未恢复历史（直接 session/new），
> 4 秒后窗格 B 正常恢复 16 条历史 —— 同一文件、同一时间窗，差异仅在
> Path 是否已就位。

---

## 1. 目标（WHAT）

1. **打开已有文档时**，即使窗格初始化瞬间 `Path` 未就位，也要**恢复该文档的历史消息与 AI 会话**（与 Path 已就位时行为一致）。
2. **新建文档时**，行为**零变化**（现有 volatile 路径，不等待、不延迟建会话）。
3. **首次打开无历史文档时**，行为**零变化**（直接新建会话，不等待）。

非目标（NOT scope）：
- 不改 `makeDocId()` 的 docId 生成规则（已保存 = `appType:path:name`，未保存 = `appType::unsaved::<token>::name` 保持冻结）。
- 不改 P23 volatile 不落盘的规则（新建草稿关闭即弃，语义不变）。
- 不引入 WPS 事件监听（`ApiEvent` 在 Linux 版可用性未验证，不作为依赖）。
- 不解决"打开文档后 Path 永久为空"的 WPS 异常态（视为极端边界，超时降级即可）。

---

## 2. 现状与接入点（已核实）

| 层 | 现状 | 本次改动点 |
|---|---|---|
| `js/doc-state.js` | `getDocId()` 读 `WpsBridge.getDocIdentity()` → `makeDocId(info)`；`isVolatileDocId(id)` 判定 `::unsaved::`；`startDocCheck()` 已有 3s 周期轮询 | **新增**：volatile docId 的历史反查 + Path 就位等待逻辑 |
| `js/main.js` | `initTaskpane()` 中 `S.currentDocId = getDocId()` → `loadHistory` → restore/showEmptyHint → `startDocCheck()` → `loadBridgeConfig` → `ensureSession` | **改动**：初始化时若 volatile，先走反查判定 |
| `js/app-state.js` | `historyKey(docId)` = `qp.history.<docId>`；`loadHistory/loadCachedSessionId` 对 volatile 一律返回空 | **新增**：遍历 localStorage 反查同名历史 key 的工具函数（只读，不改 P23 落盘语义） |
| `js/session.js` | `ensureSession()`：有缓存 sessionId → session/load；无 → session/new | **必须**（G1）：`ensureSession` 入口加 `S.docIdPending` 门禁——等待判定未结束前跳过建会话，判定收敛后由收敛逻辑补触发 |

依赖关系：`initTaskpane` 初始化时序（main.js）→ docId 判定（doc-state.js）→ 历史/会话读取（app-state.js）→ 会话建立（session.js，docIdPending 门禁）。改动集中在**前三步**，session.js 仅加一行门禁，不触下游语义。

---

## 3. 契约冻结项（Frozen Contracts）

这些**不可破坏**，改动必须保持：

1. **docId 生成规则**（`makeDocId`）：已保存 = `appType:path:name`；未保存 = `appType::unsaved::<instanceToken>::<name>`。instanceToken 每 taskpane 实例随机。
2. **volatile 不落盘**（P23）：`loadHistory/loadCachedSessionId/saveHistory/saveCachedSessionId` 对含 `::unsaved::` 的 docId 一律不读不写。
3. **localStorage key 格式**：`qp.history.<docId>` / `qp.session.<docId>`。已保存 docId 的 key 形如 `qp.history.wps:/path/to/dir:filename.docx`。
4. **加载顺序**（AGENTS.md）：app-state → doc-state → … → main（main 最末）。新增函数只能挂在 `globalThis` 或模块内部，不得改变加载顺序。
5. **`ChatUi.restore/showEmptyHint` 语义**：restore 清空并重渲染；showEmptyHint 仅在无消息时显示引导。不改变。

---

## 4. 前端改动（WHAT）

### 4.1 核心判定流程（`initTaskpane` 初始化时序）

初始化时 `getDocId()`：

- **Path 非空**（已保存）→ 走现有逻辑（恢复历史 + session/load），零变化（`docIdPending` 恒 false，零回归）。
- **volatile**（Path 空但 name 有值）→ 进入**反查判定**。
- **`default`**（name 也没有）→ 不反查（无 name 可比），走现有 volatile 路径，零变化（G6）。

进入反查判定即**置位 `S.docIdPending = true`**（会话门禁，见 §4.4），流程：

1. **反查 localStorage**：遍历 `qp.history.*` / `qp.session.*` 的 key，查找是否存在与当前 volatile docId 的**文件名（name）完全匹配**的已保存 docId 历史 key（匹配规则见 §4.2）。
2. **命中**（存在同名已保存历史）→ 判定为"**打开中的已保存文档，Path 未就位**"：
   - 进入**短轮询等待 Path 就位**（**setTimeout 链**，每步 500ms，上限 ≤ 3s；不用 setInterval——测试 harness 的 fakeSetInterval 不触发，setTimeout 链才能被确定性驱动，G5）。
   - Path 就位 → **幂等收敛**（G2）：等待期间若 3s docCheck 已抢先判定并迁移 `currentDocId` 到稳定 id（见 §6 B8），则不二次判定，直接按当前 stable id 恢复历史 + session/load；否则置 `currentDocId = 反查 docId`，恢复历史 + 对应 sessionId（若有）。
   - 超时仍未就位 → **降级**：直接用反查到的已保存 docId 恢复历史 + 对应 sessionId（若有）建会话（见 4.3 降级语义）。
   - 任一路径收敛后：清 `S.docIdPending`，**补触发 `ensureSession()`**（门禁挂起的建会话在此释放；未连接时调用无害，后续 connect 事件再触发）。
3. **未命中**（无同名已保存历史）→ 判定为"**真新建 / 首次打开**"→ 清 `S.docIdPending`，走现有 volatile 路径（立即建会话），零等待。反查是同步遍历，在 loadBridgeConfig 回调（异步）之前完成，故未命中路径 ACP 连接事件必然在门禁已清除之后到达，无需补触发。

### 4.2 反查匹配规则（重要边界）

- **匹配对象**：volatile docId 中 `::` 分隔的**最后一段 name**（真实文件名，如 `全球小堆创新合作联盟筹备组工作周报（第7期）-2026.10.15.docx`）。
- **匹配范围**：localStorage 全部 `qp.history.*` / `qp.session.*` key，取 `:` 后段（name 部分）做**全等匹配**。
- **防御性跳过（G4a）**：含 `::unsaved::` 的 volatile key（P23 前的旧数据可能残留）与 `default` 的 key 直接跳过，不参与匹配。
- **多命中择一（G4c）**：同名 key 有多个（不同目录同名文件）→ 有 `qp.session.<docId>` 的优先（会话更新信号），再比历史条数最多者；最终只取**一个** docId，该 docId 的 history 与 session **成对**读取（不混用两个 key 的结果）。localStorage 无可靠写时间戳，不做"时间最新"直接判断。
- **只读**：反查不写、不删、不迁移任何 key。
- **name 提取假设（G7）**：文件名含 `:` 时 `split(':').pop()` 会失配（Linux 允许、Windows 非法）——接受该假设，不做特殊处理。

### 4.3 超时降级语义

等待超时（Path 仍未就位）时的降级行为，**二选一**（评审敲定）：
- **路径 X（推荐）**：直接用反查到的已保存 docId 恢复历史 + 会话（不等 Path）。风险：若该文件实际是新建后被用户保存成同名文件（罕见），会误挂旧历史——但此时 Path 也快就位，3s 内 docCheck 会纠正。
- **路径 Y**：丢弃反查结果，按 volatile 新建（与现状一致，历史仍丢）。仅当确认"宁可丢历史不误挂"时选。

> 敲定建议：路径 X。本方案目的就是恢复历史，超时后 Path 仍未就位属极端场景，直接恢复比丢弃更符合目标；同名误挂由 3s 周期的 `docCheckNow` 后续纠正。

**路径 X 的后续纠正代价（G3，评审必补项）**：降级恢复用的 docId 与 Path 到位后的真实 docId 若不同（B2 多命中选了另一目录的同名文件），`docCheckNow` 会 `switchToDoc` 到真实路径——该路径无 docStates/无历史 → 展示空状态 + 会话清空（文档隔离正确性优先，可接受）。**常见情形（同一路径）下 `makeDocId` 结果一致，无纠正、无副作用。**

**降级结果不被 docCheck 抹掉（评审修复 R1）**：`doSwitchIfChanged` 增加守卫——当 `currentDocId` 已是稳定 id（降级/就位收敛产物）而 WPS 身份仍是**同名** volatile docId（Path 永久空）时，不切回 volatile（否则 switchToDoc 会抹掉刚恢复的历史/会话，使降级自毁）。Path 真正就位后 id 变稳定，守卫自然放行，G3 纠正语义不变。

### 4.4 会话门禁（G1，硬约束）

`S.docIdPending` 标志（app-state.js `state` 新增字段）：

- 进入反查判定时**置位**，判定收敛（就位 / 降级 / 未命中）时**清除**。
- `ensureSession()`（session.js）**入口硬门禁**：`if (S.docIdPending) return;` —— 等待期间 ACP 即使已连上也不发 session/new/load（避免拿 volatile docId 建会话，恰是本 bug 路径）。
- `onAcpConnChange('connected')` 中的自动 ensureSession 同样被门禁（同一入口）；判定收敛后由收敛逻辑**主动补触发** `ensureSession()`（未连接时调用无害，后续 connect 事件再触发）。
- 仅等待分支涉及；Path 非空（正常已保存）时 `docIdPending` 恒为 false，零回归。

### 4.5 UI 状态（等待期不卡死）

等待 Path 期间（≤3s）：
- 输入框占位文案显示「正在识别文档…」（复用 `ChatUi.setPlaceholder`）。
- 不显示空状态引导（`showEmptyHint` 延迟到判定结束后）。
- 不阻塞：判定结束前不建会话、不启用发送（与现有"连接中/创建会话中"禁用语义一致）。

---

## 5. 验收（可执行）

**单元/集成（前端行为验证，`node bridge/test_frontend_race.js` 扩展或新增场景）**：

1. **正常已保存**：mock `getDocIdentity` 返回 path 非空 → 恢复历史（现有行为不回归）。
2. **打开已保存但 Path 空 + 有同名历史**：mock path 空 + localStorage 存在 `qp.history.wps:/dir:同.docx` → 进入等待 → mock path 就位 → 恢复该历史。
3. **打开已保存但 Path 空 + 有同名历史 + 等待超时**：mock path 一直空 → 超时降级 → 恢复反查到的历史 + 会话（路径 X，按 §4.3 敲定）。
4. **新建文档（无同名历史）**：mock path 空 + 无同名 key → 立即建会话，**不等待**（断言无等待定时器 / 立即 session/new）。
5. **首次打开无历史文档（Path 空）**：mock path 空 + 无同名 key → 立即建会话，零等待。
6. **新建"文字文稿5"但无同名历史**：mock name=文字文稿5 + 无同名 key → 立即建会话（不被误判为打开）。
7. **保存过"文字文稿5"文件（有同名历史）**：mock name=文字文稿5 + 存在 `qp.history.wps:/dir:文字文稿5` → 进入等待并恢复（覆盖用户提醒的反例）。
8. **多命中同名**：两个不同目录的同名历史 key → 有 session key 的优先、再比条数，不崩溃（G4c）。
9. **等待期 ACP 先连上（G1 门禁）**：mock path 空 + 有同名历史 → 进入等待 → `conn('connected')` → 断言**无** session/new → mock path 就位 → 收敛后断言 session/load（非 session/new）+ 历史恢复。
10. **等待期 docCheck 抢先迁移（G2 幂等）**：mock path 空 + 有同名历史 → 进入等待 → 等待中 mock path 就位 + `checkDoc()` 迁移到 stable → 触发等待收敛 → 断言不二次判定、恢复 stable 历史、会话建立不重复。
11. **反查防御（G4a）**：localStorage 含 `qp.history.wps::unsaved::…` 旧数据或 `qp.history.default` → 跳过不参与匹配，不影响判定。
12. **B7 等待期文档关闭（R2）**：等待期 ACP 连上 + 文档消失 → 收敛后**不主动建会话**（G1，不拿陈旧 volatile docId 发 session/new）；docCheckNow 落定 `default` 后才建会话。
13. **永久空 Path 降级不被抹掉（R1）**：等待超时降级 X 恢复历史 + session/load 后，`checkDoc()`（同名 volatile 身份）不切回 volatile、不抹掉降级结果、不额外建会话。
14. **`node --check`** 全部 JS 通过。
15. **回归**：现有前端行为测试场景 A-K 全绿。

**端到端（真机 WPS）**：

16. 打开已有文档（有历史）→ **立即**点开侧边栏（赶在 Path 就位前）→ 历史恢复、AI 会话恢复（不出现"新会话"）。
17. 新建文档 → 打开侧边栏 → 立即建会话，无感知延迟。
18. 反复打开/关闭同一文件 → 历史每次都恢复（现有 P8 路径不回归）。
19. 打开"文字文稿5"（若用户有该保存文件）→ 历史恢复（如无历史则新建，均正确）。

---

## 6. 边界情况 → 期望行为表（每个 case 必须有对应测试）

| # | 边界 | 期望行为 |
|---|---|---|
| B1 | Path 空 + 同名历史唯一 | 等待 → 就位恢复 / 超时降级恢复 |
| B2 | Path 空 + 同名历史多个（不同目录） | 取最近写入，不崩溃 |
| B3 | Path 空 + 无同名历史（新建/首开） | 立即建会话，零等待 |
| B4 | name=文字文稿N + 无同名历史（真新建） | 立即建会话（不被 Name 误判） |
| B5 | name=文字文稿N + 有同名历史（保存过的同名文件） | 等待 → 恢复（Name 不参与判定，反查命中即恢复） |
| B6 | Path 空 + localStorage 无任何 history key | 按新建，立即建会话 |
| B7 | Path 空 + 等待期间文档被关闭（activeDocument 消失） | 中止等待，按 volatile 新建（不挂旧历史） |
| B8 | Path 空 + 等待期间 3s docCheck 抢先判稳定（Path 就位且迁移成功） | 判定收敛做**幂等处理**（G2）：currentDocId 已非 volatile → 直接恢复其历史 + session/load，不二次判定、不重复建会话 |
| B9 | 等待超时（3s）Path 仍空 | 按敲定路径降级（X：恢复反查历史 / Y：volatile 新建）；降级结果受 doSwitchIfChanged 守卫保护，不被同名 volatile 的 docCheck 周期抹掉（R1） |
| B10 | volatile docId 的 name 为空字符串 | 视为无有效 name，直接按新建处理（不反查） |
| B11 | localStorage 被禁用/抛异常 | 反查返回空，走现有 volatile 路径（不崩溃） |
| B12 | 同实例内多个未保存文档（不同 name） | 各自独立判定，不串台（P23 token 语义保持） |

---

## 7. 遗留（非本次 scope）

- **WPS `ApiEvent.NewDocument` 事件探针**：若验证 Linux 版支持，可做到"新建瞬间零等待 + 打开瞬间零轮询"的事件驱动，替代短轮询。独立实验，不阻塞本方案。
- **同名文件同目录**：同一目录下同名文件（不同扩展名或 WPS 内部重名）属既有边界，不扩大处理。

---

## 8. 交付物清单

| 交付物 | 说明 |
|---|---|
| `js/doc-state.js` | 新增：volatile docId 反查判定 + Path 等待（setTimeout 链）+ 幂等收敛 + 超时降级（核心） |
| `js/main.js` | `initTaskpane` 初始化时序接入判定（置位/清除 docIdPending，showEmptyHint 延迟） |
| `js/app-state.js` | 新增：localStorage 历史 key 反查工具（只读，防御性跳过）+ `docIdPending` 状态字段 |
| `js/session.js` | **必须**：`ensureSession` 入口加 `S.docIdPending` 门禁（一行，G1） |
| 测试 | 前端行为测试扩展（§5.1-13 场景）+ 真机 E2E 步骤（§5.14-17） |
