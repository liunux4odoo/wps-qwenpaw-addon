# WPS 命令端口（方案 A：端口上游 handler 进插件执行器，全量 90 缺口）

> 状态：📋 待委派（方案 v2 已定稿）
> 日期：2026-09-18（v1: Excel 88；v2: 范围升级为「上游 handler 有的」全量 90 缺口）
> 对应：2026-09-18 诊断「setCellFormat 不被执行器支持」根因 = 搜索索引（上游
> gateway/index.ts 255 个 action）≠ 插件执行器实现集（POLL_ACTION_MAP +
> wps-bridge.js 仅 116 个）。本方案按路线 A 补齐执行器实现。
> 仓库：`/data/myrepo/wps-qwenpaw-addon/`，交付物：`js/poll.js` +
> `js/wps-bridge.js` 的命令端口；**不修改** `bridge/acp-bridge.py`
> （纯传输层，从不过滤命令）。

---

## 1. 背景与现象

wps-qwenpaw-addon 插件侧执行器 = `js/poll.js` 的 `onPollCommand` 分发器 +
`js/wps-bridge.js` 的 WPS JS API 方法。`wps_office_execute` 把 action 名推到
插件，`onPollCommand` 查 `POLL_ACTION_MAP` → 命中则调 `WpsBridge[method]`，
否则回「未支持的命令」。

**范围定义（v2 用户拍板）**：「把上游 handler 有的」全同步——即 opencode-wps
`opencode-wps-linux/handlers/{word,excel,ppt,common}-handler.js` 里
`registerHandler` 注册的命令全集（206 个），全部同步到插件执行器。**不是**
gateway 注册表全量 255 个（handler 没有实现的 49 个保持现状）。

现状（2026-09-18 源码核实）：

| 侧 | 数量 | 内容 |
|---|---|---|
| 上游 handler 命令全集 | 206 | word 26 + excel 88 + ppt 82 + common 10 |
| 插件执行器已有 | 116 | word 23 + excel 3 + ppt 82 + common 8 |
| **待补缺口** | **90** | **excel 85 + word 3 + common 2**（ppt 已全量） |
| gateway 有 handler 无 | 49 | 不在范围，保持现状 |

→ agent 搜到 `setCellFormat`/`createChart`/`setFormula` 等 action，执行时落
「未支持的命令」→ 反复报「找不到工具」。**PPT 已用同一方法修复**（2026-09-08，
commit `1695737`：端口 80 个 action + 方法，node --check 过、POLL_ACTION_MAP↔
WpsBridge 交叉对齐 0 缺口）。

## 2. 任务（WHAT）

把上游参考实现 `third_party/opencode-wps/opencode-wps-linux/handlers/
{word,excel,ppt,common}-handler.js` 中**有参考实现且插件缺失**的命令端口进
插件执行器：

1. `js/poll.js`：`POLL_ACTION_MAP` 补齐 90 个 action 映射（现有 116 个保留，
   语义不得改变）；
2. `js/poll.js`：`FEEDBACK_ACTIONS` 补齐对应写操作（侧边栏 ✅/❌ 反馈展示）；
3. `js/wps-bridge.js`：为每个 action 实现对应方法（WPS JS API 调用），并注册进
   `WpsBridge` 返回对象——**没有方法实现，白名单条目照样落「未支持」**
   （`onPollCommand` 要求 `typeof WpsBridge[method] === 'function'`）；
4. 保留现有方法的**行为契约**（返回字段、错误文案），端口时以上游参考实现为准
   对齐，但不得破坏已跑通的调用方。

**待补 90 个清单**：

**Excel（85 个）**——excel-handler.js 88 个 - 已有 3 个：
addCellComment addConditionalFormat addDataValidation autoFilter autoFitAll
autoFitColumn autoFitRow autoSum calculateSheet cleanData clearFormats clearRange
closeWorkbook consolidate copyFormat copyRange copySheet createChart
createNamedRange createPivotTable createSheet createWorkbook deleteCellComment
deleteColumns deleteNamedRange deleteRows deleteSheet diagnoseFormula
evaluateFormula exportChartAsImage exportRangeAsImage fillSeries findInSheet
freezePanes getCellComments getContext getFormula getNamedRanges getOpenWorkbooks
getRangeData getSelection getSheetList groupColumns groupRows hideColumns hideRows
insertColumns insertExcelImage insertRows lockCells mergeCells moveSheet
openWorkbook pasteRange protectSheet protectWorkbook removeDuplicates renameSheet
replaceInSheet setArrayFormula setBorder setCellFormat setCellStyle setColumnWidth
setFormula setHyperlink setNumberFormat setPrintArea setRangeData setRowHeight
setZoom showColumns showRows sortRange subtotal switchSheet switchWorkbook
textToColumns transpose unfreezePanes unmergeCells unprotectSheet updateChart
updatePivotTable wrapText

**Word（3 个）**：getBookmarks getComments insertHyperlink

**Common（2 个）**：convertToPDF getDocumentStats

**不可端口（49 个，handler 无实现，明确不做）**：gateway 有 handler 无的
createDonutChart / createFlowChart / createGauge / createGrid / createKpiCards /
createMiniCharts / generateFormula / getCellInfo / getConditionalFormats /
getDataValidations / getExcelContext / refreshLinks / removeConditionalFormat /
removeDataValidation / create3DText / insertPptChart / proofread 系列 /
smartFillField / writeFile / trim / underline / placeholder 等——保持现状
（能搜到、执行报未支持），方案里明确记录，防 code agent 超范围补实现。

## 3. 硬约束（不许违反）

- **约束 1**：**零 fork**——不改 `third_party/opencode-wps`（submodule，上游
  原样）；端口是「复制实现到 js/」，不是改上游。
- **约束 2**：**bridge 不动**——`bridge/acp-bridge.py` 纯传输层，从不过滤
  命令；本方案不引入任何 bridge 改动。
- **约束 3**：**现有方法契约冻结**——已有 116 个方法的返回字段、错误文案、
  `ok/fail` 结构不得改变（调用方已跑通）。
- **约束 4**：**错误兜底**——每个方法用 try/catch 包裹，WPS JS API 抛错时
  返回 `fail(...)`，绝不 crash 插件（PPT 端口同款纪律）。
- **约束 5**：**参数校验**——每个方法按参考实现的上游契约做参数校验
  （range 格式、sheet 存在性、行列正整数等），非法参数返回明确错误文案。
- **约束 6**：**命名一致**——action 名（POLL_ACTION_MAP key）必须与上游
  handler `registerHandler('name', ...)` 的 name 完全一致（驼峰，无前缀后缀
  转换）。

## 4. 已核实的上下文（可直接用，不必重新探索）

- 参考源：`third_party/opencode-wps/opencode-wps-linux/handlers/`
  - `word-handler.js`（462 行，26 命令）
  - `excel-handler.js`（1545 行，88 命令）
  - `ppt-handler.js`（1720 行，82 命令——已全量端口，无需动作）
  - `common-handler.js`（177 行，10 命令）
- handler 机制：`registerHandler(action, fn)` 注册进 `HANDLERS{}`
  （registry.js），辅助函数（getExcelSheet/resolveRowCol/colToLetter 等）
  **在 handler 文件内部定义**，自包含；`ok/fail` 在 utils/response.js。
- 分发器：`js/poll.js` `onPollCommand`——`POLL_ACTION_MAP[action]` →
  `WpsBridge[method]`；`typeof === 'function'` 才分发，否则「未支持的命令」。
- 现有方法：`js/wps-bridge.js`（IIFE，116 个方法 + 辅助 getApplication/ok/fail/
  getExcelSheet/resolveRowCol）。
- PPT 端口蓝本：commit `1695737`（80 action + 80 方法 + 5 辅助，node --check
  过、交叉对齐 0 缺口）。
- 缺口清单已用脚本核对：handler 206 - 插件 116 = 90（本方案 §2 清单）。
- FEEDBACK_ACTIONS 结构：`js/poll.js` 里 action → 中文描述（P11 侧边栏反馈）。

## 5. 边界情况（期望行为，测试用例来源）

1. 已有 116 个方法 → 保留，语义不变（回归测试点）。
2. 端口后 90 个 action → POLL_ACTION_MAP 有映射 + WpsBridge 有方法（交叉对齐）。
3. gateway 有 handler 无（49 个）→ 不端口，执行报「未支持」是**预期行为**。
4. handler 有 gateway 无（如 getContext/setHyperlink/switchWorkbook）→ 端口
   （execute 可用），search 搜不到是已知限制（可选后续补索引，本方案不做）。
5. 参数非法 → `fail` + 明确错误文案，不 crash。
6. WPS JS API 不暴露某方法 → try/catch 兜底 `fail`，不 crash，可被日志捕获。
7. `setCellFormat` / `createChart` / `setFormula` → 端口后应可执行（核心验收点）。
8. 幂等：直接改文件，重复执行无副作用。
9. PPT 82 个已端口 → 不重复动作，保持现状。
10. 现有 FEEDBACK_ACTIONS 的写操作 → 补全，不破坏既有条目。

## 6. 同步刷新机制（opencode-wps submodule 更新后）

**v2 用户拍板：手动同步**（路线 B「handler 即真源运行时加载」已否决——复杂、
没必要；PPT 先例证明路线 A 可行）。

opencode-wps submodule 更新后，手动同步流程：

1. `git submodule update --remote third_party/opencode-wps`（或上游 merge 后
   `git submodule update`）；
2. 跑 diff 脚本对比 handler 注册表 vs 插件 POLL_ACTION_MAP，找出新增命令：
   ```
   cat third_party/opencode-wps/opencode-wps-linux/handlers/{word,excel,ppt,common}-handler.js \
     | grep -o "registerHandler('[a-zA-Z0-9]*'" | sed "s/registerHandler('//;s/'//" | sort -u \
     > /tmp/handler_cmds.txt
   sed -n '/var POLL_ACTION_MAP/,/^  };/p' js/poll.js \
     | grep -oE "^\s+[a-zA-Z][a-zA-Z0-9]*:" | tr -d ' :' | sort -u > /tmp/plugin_cmds.txt
   comm -23 /tmp/handler_cmds.txt /tmp/plugin_cmds.txt   # ← 新增缺口清单
   ```
3. 按本方案同款方法（路线 A：POLL_ACTION_MAP + WpsBridge 方法端口）逐个移植
   新增命令；
4. 跑 §7 验收（node --check + 交叉对齐）。

**可选增强（不阻塞本次）**：把 diff 脚本固化为 `scripts/check-handler-sync.sh`，
输出缺口清单，submodule 更新后跑一下即可。**不做**自动复制/自动移植。

## 7. 验收标准（可执行）

1. `node --check js/poll.js` 与 `node --check js/wps-bridge.js` 均通过。
2. **交叉对齐 0 缺口**：POLL_ACTION_MAP 每个 action 都有对应的 WpsBridge 方法
   定义 + 导出（脚本检查）。
3. 已有 116 个方法回归：返回字段/错误文案与改前一致（diff 可读）。
4. FEEDBACK_ACTIONS 补全的写操作全部对应 POLL_ACTION_MAP 已有 action。
5. 端口后 90 个 action 的数量断言（脚本输出：90 个全部 defined + exported）。
6. **实机 E2E（阻塞门）**：沙箱验证不了 WPS Linux JSAPI 暴露。部署步骤：
   ```
   cp js/poll.js js/wps-bridge.js ~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/js/
   # 重启 WPS → 打开 xlsx → 让 agent 执行：
   # "把 A1 加粗、红字、黄底"（setCellFormat）
   # "A1:B2 画个柱状图"（createChart）
   # "C1 写 =SUM(A1:A2)"（setFormula）
   # 打开 docx → "在开头插入书签"（insertBookmark / getBookmarks）
   ```
   核心三条都成功 → 验收通过。
7. 代码评审：端口忠实于参考实现（不发明新行为），错误兜底齐全。

## 8. 非目标（不做）

- **不做** 49 个 gateway 有 handler 无的 action 的补实现（超范围）。
- **不做** search 索引改造（让索引只返回已实现命令）——那是路线 B。
- **不做** handler 即真源运行时加载（路线 B 架构）——v2 已否决。
- **不做** 自动同步/自动复制机制（opencode-wps 更新后手动同步，§6）。
- **不做** wps-office-mcp 服务端 execute_method 白名单放开（安全边界）。
- **不做** bridge/acp-bridge.py 的任何改动。
- **不做** `third_party/opencode-wps`（submodule）的任何改动。

## 9. 契约冲突上抛

- 若端口时发现参考实现依赖的 WPS JS API 对象/属性在 Linux 端不可达（如
  `Chart` 对象、`Validation` 对象），**不自行发明替代 API**，记录并上抛，
  由人工决定：降级为 `fail('未支持: ...')` 还是找替代方案。
- 若现有方法的契约与上游参考实现冲突（如返回字段差异），**以现有契约为准**
  （调用方已跑通），差异记录在实施记录，不擅自改。

## 10. 诊断候选（🟡 不预定结果）

- `setCellFormat` 端口后实机验证：WPS Linux 的 `Range.Font.Bold / Color /
  Interior.Color` 是否暴露？（PPT 修复时 `Slides.Add` 是待验证点，同款风险）
- `createChart` 端口后实机验证：`Shapes.AddChart` 或 `Charts.Add` 是否可用？
  若不可用，是否走 `Worksheet.ChartObjects`？
- 部分命令（如 `protectSheet`/`addDataValidation`）实机是否触发 WPS 对话框/
  权限提示，是否需要额外参数（如密码）——以参考实现契约为准，实机确认。
- word 的 getBookmarks/getComments、common 的 convertToPDF/getDocumentStats
  实机 JSAPI 暴露情况。

## 11. 决策记录

- **2026-09-18 v1**：路线 A（端口执行器）而非路线 B（改搜索索引）——用户拍板
  「按路线 A 做方案」；Excel 88 个一次端口。
- **2026-09-18 v2（本版）**：
  1. 范围升级为「上游 handler 有的」全量——用户拍板「把上游 handler 有的」；
     缺口 90（excel 85 + word 3 + common 2），ppt 已全量。
  2. 同步机制：opencode-wps 更新后**手动同步**（§6 diff 脚本 + 路线 A 移植）；
     路线 B（handler 即真源运行时加载）**否决**——「复杂，没有必要」。
  3. 49 个 handler 无实现的命令明确排除。
  4. 实机 E2E 是阻塞门（同 PPT 修复遗留项），沙箱全绿不等于可发布。
  5. 不碰 execute_method 白名单（2026-09-18 已否决：改服务端违反零 fork +
     逃逸 Application 对象图是真实安全风险）。

## 12. 实施记录（待 code agent 填写）

（留给 code agent：端口了哪些、每个命令的参数契约、验证输出、与现有方法的
契约差异、实机验证结果）

### 2026-09-18 实施完成（code agent）

**端口范围**：90 个缺口全量端口（excel 85 + word 3 + common 2），ppt 已全量不动。

**改动文件**：
- `js/poll.js`：POLL_ACTION_MAP 新增 90 个 action 映射（总 211 个，无重复 key）；
  FEEDBACK_ACTIONS 新增对应写操作 77 条（Excel 75 写操作 + insertHyperlink +
  convertToPDF；getDocumentStats/getComments/getBookmarks 及 Excel 只读查询如
  getFormula/getContext/getSelection/getRangeData/getSheetList/getOpenWorkbooks/
  getNamedRanges/getCellComments/diagnoseFormula/evaluateFormula/findInSheet/
  autoSum 按 P11 纪律「只读查询不刷屏」不入 FEEDBACK），全部对应
  POLL_ACTION_MAP 已有 action。
- `js/wps-bridge.js`：新增 90 个方法 + 5 个 Excel 辅助（colToLetter/
  resolveColumnLetter/colToNumber/resolveAlignment/toExcelColor，端口自
  excel-handler.js 顶部），并注册进 WpsBridge 返回对象（总 218 项）。

**参数契约**（与上游 handler 一致，无自创行为）：
- 单元格级命令（setFormula/getFormula/addCellComment/deleteCellComment/
  setHyperlink）：row/col 走 resolveRowCol 校验，非法返回「无效的行/列参数」。
- 行列级命令（insertRows/deleteRows/hideRows/showRows/groupRows）：row 必须为正
  整数、count 默认 1；列侧（insertColumns/deleteColumns/hideColumns/showColumns/
  groupColumns）支持数字/字母列号，走 resolveColumnLetter/colToNumber/colToLetter。
- 颜色参数（setBorder/setCellFormat/setCellStyle/addConditionalFormat）：统一
  toExcelColor（#RRGGBB/RRGGBB/3 位简写/数字），非法返回明确错误文案。
- 对齐参数（setCellFormat/setCellStyle）：resolveAlignment + H_ALIGN_MAP/
  V_ALIGN_MAP（left/center/right/top/bottom 字符串或数字常量）。
- 结构要求：setCellFormat 的 format 对象与顶层参数兼容（旧调用不破坏）；
  createChart 的 chartTypes 映射（column 51/bar 57/line 4/pie 5/area 1/
  scatter -4169）；evaluateFormula 求值后 finally 恢复原公式不污染文档；
  cleanData 三模式（trim/collapse/all）用非全局正则判断避免 lastIndex 漏判。

**验证输出**：
1. `node --check js/poll.js` 与 `node --check js/wps-bridge.js` 均通过。
2. 交叉对齐 0 缺口：POLL_ACTION_MAP 211 个 action 在运行时全部
   `typeof WpsBridge[method] === 'function'`（vm 沙箱加载验证，0 gap）。
3. 已有 147 个方法全部保留（function 名集合 diff：removed=[]）。
4. FEEDBACK_ACTIONS 168 条全部对应 POLL_ACTION_MAP 已有 action（差集为空；
   只读查询按 P11 纪律不入 FEEDBACK）。
5. handler 206 个命令全部在 POLL_ACTION_MAP 有映射 + WpsBridge 有方法
   （handler - plugin 差集为空）。
6. 49 个 handler 无实现命令未端口（createDonutChart/createFlowChart/
   generateFormula/proofread 等保持「未支持的命令」，与方案一致）。
7. `node bridge/test_frontend_race.js`：A-F 场景全绿（K1-K6 通过）。
8. `bridge/acp-bridge.py`、`third_party/opencode-wps` 均未改动。

**与现有方法的契约差异**：无——新方法全部独立命名，未触碰已有 116 个方法
（含 getSelectedText 内部函数名 getSelectedTextCmd 等既有别名映射）。

**实机验证结果**：待人工实机（阻塞门 §7.6）——setCellFormat/createChart/
setFormula 三条核心路径 + word 书签，沙箱无法验证 WPS Linux JSAPI 暴露。
