# 开发方案：自定义提示词模板按钮（P22）

> **文档状态**：v1.0（2026-09-08）
> **归档**：`docs/DEV-PLAN-Phase3.md` P1-P21 打磨项之外，独立成文；归入 Phase 3"体验打磨"（纯前段，不改 bridge/manifest/ACP）。
> **关联文档**：架构总纲 `docs/ARCHITECTURE.md` §4.2（模块边界）；当前方案 `docs/DEV-PLAN-Phase3.md`（阶段 3 批次/优先级）

---

## 1. 目标

允许用户把常用提示词固化为**可编辑的模板按钮**：点一下→模板经参数替换后填充到输入框，用户二次修改后再发送。按钮本身只负责"填入输入框"，不自动执行。

**非目标**：让按钮一击即运行指令；把模板按钮做到 WPS ribbon。

## 2. 现状核实（已读源码）

- `taskpane.html`：现有 `#header / #messages / #typingIndicator / #toolbar / #settingsPanel / #inputArea`，但 `#toolbar` 与 `#inputArea` 之间**没有 prompt 容器**。
- `ribbon.xml`：ribbon 现有 2 按钮（AI 侧边栏 / 状态），均为命令回调；WPS Linux CEF 动态 ribbon 支持未实测。
- `app-state.js`：`QP.state` 持久化采用 `localStorage`，key 规格 `qp.<scope>.<docId>`（如 `qp.history.<docId>`），`doc-state.js` 提供 `getDocId()`。
- `wps-bridge.js`：已导出 `getActiveDocumentInfo()`（返回 `{name, path, appType}`） 与 `getSelectedTextCmd()`（返回 `{success, data:{text,length}}`）——模板参数可用。
- 脚本加载顺序 `taskpane.html` `<script>`：`acp-client → markdown → wps-bridge → chat-ui → wps-poll-client → app-state(QP) → doc-state → bridge-config → session → agents → acp-events → watchdog → actions → poll → ribbon → main`。

## 3. 可挑战假设

> 列假设摆桌面，便于否决。

- **A1**：prompt 按钮属于 taskpane，ribbon 不放模板按钮。 — 依据：按钮需填入输入框 + 读文档上下文，taskpane 本位可直接完成；ribbon 需跨上下文 `postMessage`，复杂度显著更高。
- **A2**：存储用 `localStorage`（全局 + 按文档），不用 bridge 落盘。 — 依据：prompt 属于用户个人偏好/片段；跨文档共享的常用模板是主要需求；localStorage 已是项目现存的状态持久化约定。
- **A3**：模板参数仅 `本地可得`（日期/文档名/选中文本），不引入远程上下文。 — 依据：参数来源于本地 Date + WPS JS API。
- **A4**：MVP 仅**全局**模板；按文档模板作为后续扩展。 — 依据：全局模板覆盖率高、实现简单；按文档可后加 key。

## 4. 方案

### 4.1 布局（FE）
在 `#inputArea` 上方，`#toolbar` 下方，插入一个横向滚动的 prompt strip（固定高度，-overflow-x auto，overflow-y hidden），放置在与输入框平行的水平线上。

```
#toolbar
#promptStrip   ← NEW
#inputArea
```

- 容器 `#promptStrip class="prompt-strip"`。
- 每个按钮 `class="prompt-btn"`，显示 `{{name}}`，点击填入输入框。
- 滚动条横向且不占内容区输入空间（`flex-shrink:0`）。

### 4.2 存储模型（FE）
- **全局模板**：`localStorage['qp.prompts']` —— 默认 7 条 (用户拍板)：`续写` / `润色` / `扩写` / `翻译` / `矫正语气` / `错误检查` / `总结`；用户增删改。
- **按文档模板**（Stretch）：`localStorage['qp.prompts.'+docId]`；无活动文档时回退全局。
- 结构：`[{id, name, text}]`，`id` 用 `Date.now()` 防冲突。

### 4.3 模板参数（FE）
`prompts.js` 暴露 `resolveTemplate(text)`，在点击前统一替换：

| 占位符 | 来源 | 失败回退 |
|---|---|---|
| `{{date}}` | `new Date().toLocaleString('zh-CN')` | — |
| `{{filename}}` | `WpsBridge.getActiveDocumentInfo().name` | `(无打开文档)` |
| `{{fullpath}}` | `doc.path + '/' + doc.name` | `(新文档)` |
| `{{selection}}` | `WpsBridge.getSelectedTextCmd().data.text` | `` (空字符串) |

- 替换为贪婪全匹配，一次性完成；替换后**不存回**（仅在 fill 时动态展开）。

### 4.4 点击行为（FE）
点击按钮 → `resolveTemplate(item.text)` → `document.getElementById('input').value = rendered` + `focus()` + 光标置末 → **不自动发送**。

- 如输入框已有内容，行为为**替换**：直接覆盖。（避免"追加 vs 覆盖"歧义，MVP 固定为覆盖；后续可加 Shift+点击 追加。）

### 4.5 管理 UI（FE）
复用已有的 `#settingsPanel`（由 `#settingsBtn` ⚙ 切换）。新增一节**提示词模板**：
- 上：`#promptList`（当前全局模板列表，inline 可编辑 name / 删除）。
- 下：一行 `name + text(textarea)` + `添加`。
- 保存 = 即时 `localStorage`落盘 + `QPLog('P22', …)`（复用调试上报）。

### 4.6 脚本与加载（FE）
- 新增 `js/prompts.js`，IIFE 包裹，导出 `QP.prompts = { init, renderStrip, resolveTemplate, renderManage, save }`。
- **`<script>` 顺序**：插在 `doc-state.js` 之后、`bridge-config.js` 之前（它依赖 `QP` + `getDocId` + `WpsBridge`，且 `main.js` 仅在其后调用 `QP.prompts.init`）。

| 序 | 文件 | 角色 |
|---|---|---|
| 8(NEW) | `js/prompts.js` | 模板存储/渲染/参数替换/管理 UI |
| — | `taskpane.html` | 加 `#promptStrip` div + `<script>prompts.js` |
| — | `css/taskpane.css` | `.prompt-strip / .prompt-btn` 样式 |
| 16 | `js/main.js` | `QP.prompts.init()` 一次调用 |

**改动面最小**：只改 `taskpane.html` + 新增 `prompts.js` + `css` + `main.js` 4 行 —— 零改动 `ribbon.js` / `manifest.xml` / `bridge` / `ACP`。

## 5. 跨层依赖

| 依赖 | 层 | 状态 |
|---|---|---|
| `WpsBridge.getActiveDocumentInfo` | MCP/JS API | 已实测可用 |
| `WpsBridge.getSelectedTextCmd` | MCP/JS API | 已导出 |
| `localStorage` | browser | 现存约定 |
| `QPLog` | app-state | 现存可用 |

→ **无跨层阻塞**。

## 6. 验收标准（FE）

- V1：侧边栏打开后，`#promptStrip` 显示 7 个默认模板按钮，水平滚动可见。
- V2：点任意按钮 → 对应模板经 `{{date}}/{{filename}}` 替换 → 填入 `#input`，光标置末获得焦点。
- V3：输入框原有内容被替换；**未**自动发送。
- V4：在 settings ⚙ 面板"提示词模板"节，用户可增/删/改名全局模板，刷新即生效（localStorage 落盘）。
- V5：关掉侧边栏/重启 WPS 后，自定义模板仍存在；默认模板在 localStorage 无值时回显。
- V6：选中文本后点击含 `{{selection}}` 的按钮 → 选中文本正确替换进输入框；无选中时替换为空不报错。
- V7：无活动文档时 `{{filename}}` 显示为 `(无打开文档)`，不崩溃。

- 编号以 P22 起计，避开 Phase 3 现有 P1-P21（P17=修订/回滚）。

### 7. 已确认 / 未回答

1. ✅ **默认模板**：7 条 — `续写 / 润色 / 扩写 / 翻译 / 矫正语气 / 错误检查 / 总结`（用户 2026-09-08 拍板）。
2. ✅ **按钮风格**：按钮展示在 `#promptStrip`；管理入口放 settings ⚙ 面板，toolbar 不额外加图标。
3. **Shift+点击追加**（填入而非替换）—— MVP 先不做，留给后续。如需，告诉一声。

⟦ prompt模板按钮｜状态：方案 v1.0 落定（taskpane prompt strip + localStorage + 4 参数 + 7 默认模板）；下一步：交 code agent 实现，实机端到端验收 V1-V7 ⟧
