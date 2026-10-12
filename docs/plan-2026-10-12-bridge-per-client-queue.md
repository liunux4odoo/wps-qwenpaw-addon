# 开发方案：bridge ACP 请求-响应路由改为 per-client 隔离队列

> 状态：✅ 已实施（2026-10-12，code agent；单元测试 + 真实 qwenpaw E2E 全绿，真机 WPS 待验证）
> 日期：2026-10-12
> 背景：WPS 全新打开新文档（新进程 → 新 taskpane 实例）时建会话慢 25s+；
> 同窗口新标签（复用实例）快。日志实证 bridge 的全局 FIFO 响应路由在
> 多 client 并发时乱序丢响应，导致部分 session/new 响应永远等不到。

---

## 1. 目标（WHAT）

修复 bridge ACP **多 client 并发下的请求-响应路由错乱**，使每个 taskpane
实例的 session/new、session/load、session/close 等请求都能可靠收到自己的
响应，不再因乱序/丢响应触发前端 25s 看门狗超时。

非目标（NOT scope）：
- 不改前端协议（请求 id 仍从 1 递增、`clientId` 仍由前端生成）。
- 不改 qwenpaw ACP server 行为。
- 不处理"多个 taskpane 实例本身该不该存在"（窗格复用已在前端修复，属另一议题）。
- 不新增消息重传/ACK 机制（per-client 队列应消除丢响应根因，无需重传层）。

---

## 2. 现状与根因（已核实）

### 现状机制（`bridge/acp-bridge.py`）
- `_request_queue`: 全局 `deque[(rid, client_id)]`——所有 client 的请求混排。
- 入队：`_write_stdin_now`（908 行）按"写 stdin 顺序"追加。
- 出队匹配：`_pop_request_owner(rid)`（727 行）从队头 popleft，**直到找到
  匹配 rid**；中间不匹配的请求被弹出丢弃（不 return，无补偿）。
- 响应路由：`_route_down`（744 行起）拿到响应 id → `_pop_request_owner` →
  找到归属 client → 转发到该 client 的 poll 队列。

### 根因
**全局 FIFO + "乱序时弹出丢弃"**：
1. 多 client 并发时，请求按到达顺序入队；但 ACP server 的响应**可能乱序**
   （不同 method 处理耗时不同、`order mismatch` 警告实证）。
2. 响应乱序到达时，`_pop_request_owner` 把队头不匹配的请求 popleft 丢弃，
   它们的响应失去归属（target=None）→ 前端永远等不到 → 25s 超时重试。
3. 日志实证：15:27:14 新 taskpane 实例（`c-1791790034380-m3keg6`）的
   session/new（id=1）**无对应 `ACP new_session`**，6 次 `order mismatch`
   警告同一时刻出现，25s 后前端重试才成功。

### 场景对照（用户实证）
| 场景 | 并发 | 结果 |
|---|---|---|
| 全新打开新文档（新 WPS 进程 → 新 taskpane 实例） | 新旧实例并发 | 全局 FIFO 乱序 → 新实例响应被误丢 → 25s 超时 |
| 同窗口新标签（复用同一实例） | 单 client 顺序 | 无乱序 → 快 |

---

## 3. 契约冻结项（Frozen Contracts）

这些**不可破坏**，改动必须保持：

1. **前端协议不变**：请求 `id` 仍从 1 递增（`js/acp-client.js var id = ++seq`）；
   `clientId` 格式不变；HTTP `/acp/send?clientId=X` 与 `/acp/poll?clientId=X`
   语义不变。
2. **ACP server 交互不变**：请求按到达顺序写 stdin（`_write_stdin_now` 顺序
   保证）；响应从 stdout 读取（`_route_down`）。
3. **路线 P 注入不变**：session/new 注入 WPS_POLL_PORT、wpsMcpEntry 权威
   路径、session/close 回收端口——这些是既有契约，改造路由时不得破坏。
4. **session_id → client 映射**（`http_session_client`）：sid 归属关系继续
   维护（session/update 推送、session/close 清理依赖它）。
5. **前端看门狗 25s 超时**：不改（它是兜底防线，不是根因）。

---

## 4. 改动要求（WHAT）

### 4.1 请求队列：全局 FIFO → per-client 队列

- 每个 client 维护**独立 FIFO 队列**，元素为 `rid`。
- 入队：`_write_stdin_now` 写 stdin 时，按 `client_id` 追加到对应队列。
- 出队匹配：响应到达时，`_pop_request_owner(rid)` 从**对应 client 的队列**
  （或先定位 client 再匹配 rid）弹出。**只有该 client 自己的请求会出队**，
  不会弹出别的 client 的请求。
- **乱序语义变化**：单 client 内若响应乱序（同 client 的请求 ACP 也乱序回），
  队列头不匹配时同样 popleft 丢弃——但只影响该 client 自己，**不跨 client
  误伤**。这是可接受的（同 client 顺序请求，ACP 顺序处理，理论上不乱序；
  若出现，是该 client 自己的问题，不影响他人）。

> 注意：`_pop_request_owner` 当前签名只收 `rid`，无法知道响应属于哪个
> client。方案要求**响应路由时先确定 client 归属**（见 4.2），再在该
> client 的队列内匹配 rid。若实现上需要签名变化，属 HOW，code agent 自定。

### 4.2 响应归属定位：保持现有优先级

`_route_down` 现有逻辑：优先 `params.sessionId` → `http_session_client` 找
client；无 sessionId 的响应（纯 result/error）才走 `_pop_request_owner`。
**保持这个优先级不变**，只把 `_pop_request_owner` 的全局队列换成 per-client。

### 4.3 边界情况（8 维清单，验收需覆盖）

| 维度 | 期望行为 |
|---|---|
| **空队列** | 响应到达但对应 client 队列为空（如 client 已 poll 超时被清理）→ 安全丢弃，不抛异常、不影响其他 client |
| **单 client 单请求** | 无并发场景行为与现状一致（回归不破坏） |
| **多 client 同 rid** | 每个 client 的 id=1 互不干扰，各自路由到自己 |
| **单 client 乱序** | 同 client 内响应乱序时，按 FIFO 匹配 rid；头部不匹配的丢弃（只影响自己） |
| **client 生命周期** | client 释放/超时清理时，其队列一并清理；残留响应到达时不误路由到其他 client |
| **session/close** | close 响应/端口回收逻辑不回归 |
| **session/load** | 带 cachedSid 的 load 响应正常路由 |
| **降级路径** | 队列结构异常（如 client_id 为空/未知）时，回退到安全丢弃，不崩溃 |

### 4.4 并发/性能约束

- 不引入全局锁以外的额外串行点；per-client 队列操作必须是 O(1) 摊还。
- 内存上限：per-client 队列长度应有上限（对应现有 UPSTREAM_QUEUE_MAX 的
  精神），超限策略与现状一致（丢弃最旧）。

---

## 5. 验收（可执行）

### 单元测试（bridge/test_*.py）
1. 单 client：session/new → 响应正确路由回该 client（现状行为保持）。
2. 多 client 同 rid：A、B 各发 id=1，响应分别路由到 A、B（不串）。
3. 多 client 并发 + ACP 乱序响应：模拟响应顺序与请求顺序不同，A 的响应
   不丢失、不误发给 B。
4. 空队列响应到达：不抛异常，安全丢弃。
5. client 清理后残留响应：不路由到新 client。
6. session/load 带 cachedSid：路由正确。
7. session/close：端口回收逻辑不回归。

### 集成/回归
8. `python3 bridge/test_adapter.py` 全绿（现有 qwenpaw adapter 测试）。
9. `python3 bridge/test_skills_route.py` 全绿（skill 路由不回归）。
10. `python3 -m py_compile bridge/acp-bridge.py` 通过。

### 端到端（真机 WPS）
11. 全新打开新文档（新 WPS 进程）→ 侧边栏建会话 **<5s**（不再 25s+ 超时）。
12. 连续开 3 个新文档窗口 → 各自建会话都快，互不阻塞。
13. 同窗口新标签切换 → 建会话仍快（回归）。
14. bridge 日志无新 `order mismatch` 警告（或仅限单 client 内的合法情况）。

---

## 6. 遗留（非本次 scope）

- **窗格复用**（前端 `getOrCreateTaskPane`）已解决"实例堆积"；但多 WPS
  窗口天然多实例，per-client 队列是正确架构，不是权宜。
- **前端看门狗 25s 超时**保持作为兜底。
- 若真机验证仍有偶发慢，需进一步查 qwenpaw ACP server 侧是否对 session/new
  有全局串行瓶颈（本次不改，单独排期）。

---

## 7. 交付物清单

| 交付物 | 说明 |
|---|---|
| `bridge/acp-bridge.py` | 请求队列 per-client 化 + 响应路由适配 |
| `bridge/test_*.py` | 新增 per-client 路由单元测试（覆盖 §5.1-7） |
| 文档 | ARCHITECTURE.md 路由机制段落同步（若已记录现状） |
