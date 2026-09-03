# Bridge 下行中断修复方案（stdout reader 行缓冲 bug）

> 状态：待 code agent 实施
> 日期：2026-09-03
> 对应：DEV-PLAN-Phase3.md P2（对话中断无输出）的 **bridge 侧根因已定位**，本方案只覆盖 bridge 修复；
> P2 的 FE 兜底（错误卡片/重试/重建）是独立任务，不在本方案内。
> 仓库：`/data/myrepo/wps-qwenpaw-addon/`，文件：`bridge/acp-bridge.py`

---

## 1. 背景与现象

用户实机测试：加载项与 QwenPaw 对话，**简单对话正常**；一旦开始调用工具
（如 `getActiveDocument`），前端 60s 后显示"长时间未收到响应"，此后该会话
下行永久中断（输入框不可用），只能重建会话。

现象定位：**不是** qwenpaw 侧 bug，**不是** wps-mcp 问题，**是 bridge 自身的
stdout 读取任务崩溃**导致下行推送永久断开。

## 2. 根因（诊断结论，证据链完整）

### 2.1 崩溃点

`bridge/acp-bridge.py` 中读取 qwenpaw acp 子进程 stdout 的任务，用
`readline()` 逐行读取。**asyncio StreamReader 默认行缓冲上限 64KB**。当
qwenpaw 输出的一行 JSON 超过 64KB 时，`readline()` 抛
`ValueError: Separator is found, but chunk is longer than limit`。

**该异常未被捕获** → reader 任务崩溃 → 不再读取 qwenpaw 输出 →
qwenpaw agent loop 继续跑但结果永远送不到 bridge → 下行推送永久断 →
前端 60s 看门狗触发"长时间未收到响应"。

### 2.2 证据链（acp-bridge-debug.log）

| 时间 | 事件 |
|---|---|
| 22:09:23,198 | `getActiveDocument 成功（35ms）` ← 大返回值的工具调用 |
| 22:09:23,234 | `downstream: method=session/update ... tool_call_update` ← 最后一条下行 |
| 22:09:23,270 | qwenpaw 仍在跑 `MemorySearch`（qwenpaw 侧未死） |
| 22:09:23,283 | `ERROR asyncio: Task exception was never retrieved` |
| 22:09:23,283 | `future: <Task ... coro=<AcpBridge._stdout_reader() ... exception=ValueError('Separator is found, but chunk is longer than limit')>` |
| 22:09:23,613 | 最后一条下行通知 → **之后永久静默**（无任何下行） |
| 22:10 后 | 前端 60s 看门狗触发"长时间未收到响应" |

**结论**：超长行 = 工具调用的大返回值（如 `getActiveDocument` 的文档全文
JSON）作为单行输出。崩溃发生在读取该行时。

### 2.3 历史复现

日志中该异常共 **9 次**，分布在 **3 个 bridge 版本**（行号随迭代移动：
166 → 313 → 378）——**说明 bridge 迭代过程中这个问题一直存在、从未被修复**。

## 3. 修复目标（WHAT）

- **目标 1**：qwenpaw 输出的**单行内容超过 64KB** 时，bridge 不得崩溃；
  下行推送不得因此永久中断。
- **目标 2**：超长行的内容**不应静默丢失**——该行要么被完整处理，要么被
  明确记录为"跳过超长行"（打日志），不能无声无息消失导致下游状态不一致。
- **目标 3**：stdout 和 stderr 两个 reader **同等对待**——stderr 也可能
  出现超长行（qwenpaw 的日志/堆栈），同样不能因单行异常杀掉 reader。
- **目标 4**：任何原因导致 reader 异常退出时，**要么自动恢复读取**，要么
  触发可见的错误信号（日志 + 可被上层感知），不能静默死亡后装作无事。

## 4. 硬约束（不许违反）

- **约束 1**：`create_subprocess_exec` spawn qwenpaw 的方式和参数（`--agent`、
  `PYTHONUNBUFFERED` 等）**不允许改变**——这是 ACP stdio 协议的既有契约。
- **约束 2**：下行推送的**消息边界语义**（按行 = 一条 JSON 消息）不能改变——
  修复的是"读行"的健壮性，不是消息分帧协议。
- **约束 3**：**不允许**在 bridge 里缓存 / 聚合 / 截断下行消息内容做"优化"——
  bridge 只做转发，不做加工（守仓库 §6.1 铁律）。
- **约束 4**：不引入新的第三方依赖（bridge 保持零依赖 Python 标准库）。
- **约束 5**：修复不得影响正常行（< 64KB）的读取性能与顺序（顺序保证是
  ACP 流式协议的生命线）。

## 5. 边界情况（8 维，期望行为）

| # | 边界 | 期望行为 |
|---|---|---|
| 1 | **正常短行**（< 64KB） | 与现状完全一致：逐行转发，顺序不变 |
| 2 | **超长行**（> 64KB，含换行符） | 不崩溃；行内容被完整读取处理，或明确记录"跳过"后继续读下一行 |
| 3 | **超长行（无换行符，单行几百 MB）** | 不崩溃；不无限占用内存——应有上限策略（如超上限即跳过该行 + 日志），reader 继续存活 |
| 4 | **EOF**（qwenpaw 正常退出） | 与现状一致：`readline()` 返回空 → 记录 EOF → reader 正常退出 |
| 5 | **stderr 超长行** | 与 stdout 同等处理：不崩溃，reader 存活 |
| 6 | **reader 异常恢复** | reader 因任何原因异常退出后，bridge 能感知并恢复（重启 reader 或重启子进程），不静默死亡 |
| 7 | **连续多条超长行** | 每条都能处理（或跳过+日志），reader 持续存活，不因第一条失败而连锁崩溃 |
| 8 | **半行（无换行结尾）** | 按行协议语义：最后无换行的残留内容如何处理需明确（flush 为一条消息 / 丢弃+日志，二选一，需可验证） |

## 6. 验收标准（可执行）

> 以下命令在 bridge 运行环境下执行。**通过 = 全部满足**。

### 6.1 单元/脚本级验证（模拟超长行）

```bash
# 构造一个 > 64KB 的单行 JSON，作为 qwenpaw stdout 喂给 bridge 的 reader 路径，
# 验证：不抛 ValueError、reader 不崩、后续正常行仍能读出
python - <<'EOF'
# code agent 自行设计可复现的最小复现脚本（模拟 stdin 喂 >64KB 行 + 正常行）
# 验收点：>64KB 行不崩溃；后续正常行仍被读取；顺序正确
EOF
```

### 6.2 回归验证（正常对话）

```bash
# 启动 bridge + 加载项，发一句简单对话（无工具调用）
# 验收点：流式回复正常到达，无回归
```

### 6.3 大工具调用验证（复现原 bug 场景）

```bash
# 在 WPS 中打开一个内容较多的文档，让 AI 调用 getActiveDocument 类工具
# 验收点：不再出现 "长时间未收到响应"；工具结果正常送达；对话可继续
```

### 6.4 日志断言

```bash
# 复现超长行后检查 bridge 日志
grep "超长行\|SKIP_LONG_LINE\|跳过" /tmp/kilo/acp-bridge-debug.log | tail
# 验收点：有明确的超长行处理记录（不是静默）
```

## 7. 诊断候选（🟡 不预定结果）

以下方向**只是候选**，code agent 可独立选择/组合/另辟蹊径，只要满足
§3 目标 + §4 约束 + §6 验收：

- 提高 stdout/stderr reader 的行缓冲上限（`limit` 参数）
- reader 循环内捕获行超长异常，跳过超长行并继续
- 改用分段读取（readuntil/read 替代 readline），自行维护行边界
- 异常退出后自动重启 reader

**任何修复方案必须同时覆盖 stdout 与 stderr。**

## 8. 非目标（不做）

- ❌ 不修复 qwenpaw 侧（`async generator ignored GeneratorExit` 等）——
  那是 qwenpaw 的日志噪音，与本次"下行中断"无关（已甄别，勿混淆）
- ❌ 不改 FE 的错误卡片 / 重试 / 重建按钮（那是 DEV-PLAN P2 的 FE 部分）
- ❌ 不改 wps-mcp / wps-bridge.js / main.js
- ❌ 不引入依赖、不改 ACP 消息分帧协议
- ❌ 不做"大消息压缩/截断后转发"之类的加工

## 9. 契约冲突上抛

实施过程中若发现 §4 约束与 §3 目标存在**不可调和冲突**（例如"提高 limit
到覆盖所有大行"与"不无限占内存"矛盾），**不要自己找 workaround**——归档到
`QUESTIONS.md` 上抛，说明冲突点 + 你尝试过的方向 + 建议裁决。

---

## 附：给 code agent 的上下文起点（不是路线图）

- 崩溃点文件：`bridge/acp-bridge.py`（当前 773 行）
- 相关日志：`/tmp/kilo/acp-bridge-debug.log`（31MB，含 3 次历史崩溃的完整 trace）
- 相关文档：`docs/ARCHITECTURE.md` §6.1（bridge 铁律）、`docs/DEV-PLAN-Phase3.md` P2
