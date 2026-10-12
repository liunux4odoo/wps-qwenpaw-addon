#!/usr/bin/env python3
"""per-client 请求-响应路由单元验证（docs/plan-2026-10-12-bridge-per-client-queue.md §5.1-7）。

不依赖真实 qwenpaw：直接构造 AcpBridge 实例，用假 stdin 驱动 _write_stdin_now 登记
请求归属，再驱动 _route_down 把响应路由到各 client 的 http_clients 下行队列，断言
「响应只进归属 client、绝不跨 client 误伤/丢响应」（旧全局 FIFO 在乱序时会把其他
client 的在途请求弹出丢弃，导致其响应失去归属 -> 前端 25s 超时）。

用法：python bridge/test_per_client_route.py
"""
import asyncio
import importlib.util
import json
import os
import sys
import types
from collections import deque

BRIDGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "acp-bridge.py")
_spec = importlib.util.spec_from_file_location("acp_bridge", BRIDGE_FILE)
_acp_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_acp_bridge)
AcpBridge = _acp_bridge.AcpBridge


class FakeStdin:
    """最小假 proc.stdin：让 _write_stdin_now 的写路径可执行（不落真实子进程）。"""

    def __init__(self):
        self.data = b""

    def write(self, data: bytes):
        self.data += data

    async def drain(self):
        return None


def run(coro):
    return asyncio.run(coro)


def build_bridge():
    b = AcpBridge(http_port=0, port=0, acp_server="qwenpaw")
    b.proc = types.SimpleNamespace(stdin=FakeStdin())
    return b


def send(b, client_id, rid, method, sid=None, mcp_servers=None):
    """模拟前端上行：POST /acp/send -> _write_stdin_now（登记 per-client 归属 + session 映射）。

    mcpServers 默认 []：_inject_poll_port 无 server 可注入，不触发端口分配（纯路由测试）。"""
    params = {"cwd": "/tmp", "mcpServers": mcp_servers if mcp_servers is not None else []}
    if sid:
        params["sessionId"] = sid
    raw = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
    run(b._write_stdin_now(raw, client_id))


def route(b, rid, result=None, error=None, sid=None):
    """模拟 ACP server stdout 下行：_route_down 一条 id=rid 的响应/通知。

    返回收到该条消息的 client 列表（对比路由前后各 http_clients 下行队列长度增长，
    避免把先前留在队列里未 poll 的旧消息误判为新路由目标）。"""
    msg = {"jsonrpc": "2.0", "id": rid}
    if sid:
        msg["params"] = {"sessionId": sid}
    if result is not None:
        msg["result"] = result
    if error is not None:
        msg["error"] = error
    text = json.dumps(msg)
    before = {cid: len(q) for cid, q in b.http_clients.items()}
    run(b._route_down(text))
    return [cid for cid, q in b.http_clients.items() if len(q) > before.get(cid, 0)]


def ensure_poll(b, client_id):
    """保证该 client 有下行轮询队列（模拟 /acp/poll 首次 setdefault）。"""
    b.http_clients.setdefault(client_id, deque())
    return b.http_clients[client_id]


failures = 0


def check(name, cond, detail=""):
    global failures
    if cond:
        print("  ok " + name)
    else:
        failures += 1
        print("  FAIL " + name + (" — " + detail if detail else ""))


def main():
    # ── 1. 单 client：session/new -> 响应路由回该 client（现状回归） ──
    print("单 client session/new 路由")
    b = build_bridge()
    ensure_poll(b, "A")
    send(b, "A", 1, "session/new")
    check("请求入 A 队列", b._request_queues.get("A") == deque([1]), str(b._request_queues))
    got = route(b, 1, result={"sessionId": "sA"})
    check("响应路由到 A", got == ["A"], str(got))
    check("A 队列已清空并从路由表移除", "A" not in b._request_queues, str(b._request_queues))

    # ── 2. 多 client 同 rid：A、B 各发 id=1，响应分别路由到 A、B（不串） ──
    print("多 client 同 rid 隔离")
    b2 = build_bridge()
    ensure_poll(b2, "A")
    ensure_poll(b2, "B")
    send(b2, "A", 1, "session/new")
    send(b2, "B", 1, "session/new")
    check("A/B 队列各含 rid=1", b2._request_queues.get("A") == deque([1])
          and b2._request_queues.get("B") == deque([1]), str(b2._request_queues))
    gotA = route(b2, 1, result={"sessionId": "sA"})
    check("A 的 session/new 响应 -> A", gotA == ["A"], str(gotA))
    gotB = route(b2, 1, result={"sessionId": "sB"})
    check("B 的 session/new 响应 -> B（不串到 A）", gotB == ["B"], str(gotB))

    # ── 3. 多 client 并发 + ACP 乱序：A:1/new、B:5/load、C:3/load，响应按 5,3,1 回 ──
    # 旧全局 FIFO：队列 [A:1, B:5, C:3]，回 id=5 时队头 A:1 不匹配被弹出丢弃，
    # 之后 id=1 找不到归属 -> A 的响应丢失。per-client：B/C/A 各自队列互不误伤。
    print("多 client 并发 + ACP 乱序响应")
    b3 = build_bridge()
    ensure_poll(b3, "A")
    ensure_poll(b3, "B")
    ensure_poll(b3, "C")
    send(b3, "A", 1, "session/new")
    send(b3, "B", 5, "session/load", sid="oldS_B")
    send(b3, "C", 3, "session/load", sid="oldS_C")
    check("三队列各含自己的 rid", b3._request_queues.get("A") == deque([1])
          and b3._request_queues.get("B") == deque([5])
          and b3._request_queues.get("C") == deque([3]), str(b3._request_queues))
    got5 = route(b3, 5, result={})          # 乱序先回 B 的 load 响应
    got3 = route(b3, 3, result={})          # 再回 C 的 load 响应
    got1 = route(b3, 1, result={"sessionId": "sA"})  # 最后才回 A 的 new 响应
    check("id=5 响应 -> B", got5 == ["B"], str(got5))
    check("id=3 响应 -> C", got3 == ["C"], str(got3))
    check("id=1 响应 -> A（不被乱序误丢/误发）", got1 == ["A"], str(got1))
    check("A 的 rid=1 未被其它响应弹出", b3._request_queues.get("A") is None
          or len(b3._request_queues["A"]) == 0, str(b3._request_queues))

    # ── 4. 空队列：响应到达但无任何 client 持有该 rid -> 安全丢弃，不抛异常 ──
    print("空队列响应安全丢弃")
    b4 = build_bridge()
    ensure_poll(b4, "X")
    send(b4, "X", 7, "session/new")
    got = route(b4, 999, result={})
    check("无归属 rid=999 -> 无人收到（安全丢弃）", got == [], str(got))
    check("X 的 in-flight 队列不受影响", b4._request_queues.get("X") == deque([7]), str(b4._request_queues))

    # ── 5. client 清理后残留响应：不路由到新 client ──
    print("client 清理后残留响应")
    b5 = build_bridge()
    ensure_poll(b5, "A")
    ensure_poll(b5, "B")
    send(b5, "A", 1, "session/new")
    route(b5, 1, result={"sessionId": "sA"})       # A 队列清空并移除
    send(b5, "B", 2, "session/new")
    check("A 已从路由表移除", "A" not in b5._request_queues, str(b5._request_queues))
    stale = route(b5, 1, result={"sessionId": "stale"})  # A 的旧 rid 残留响应
    check("残留 id=1 响应不误发给 B（B 只持 rid=2）", stale == [], str(stale))
    check("B 的 in-flight 队列不受影响", b5._request_queues.get("B") == deque([2]), str(b5._request_queues))

    # ── 5b. 单 client 内乱序（计划 §4.3 维度 4，可接受的自身降级） ──
    print("单 client 内乱序（FIFO 匹配，只影响自己）")
    b5b = build_bridge()
    ensure_poll(b5b, "A")
    send(b5b, "A", 1, "session/new")
    send(b5b, "A", 2, "session/prompt", sid="sA")
    got2 = route(b5b, 2, result={})                 # id=2 先回
    check("A 的 id=2 响应 -> A", got2 == ["A"], str(got2))
    check("同 client 头部不匹配的 id=1 被自身丢弃（不跨 client）",
          "A" not in b5b._request_queues, str(b5b._request_queues))

    # ── 6. session/load 带 cachedSid：请求登记 session 映射，响应正确路由 ──
    print("session/load（cachedSid）路由")
    b6 = build_bridge()
    ensure_poll(b6, "A")
    ensure_poll(b6, "B")
    send(b6, "A", 1, "session/load", sid="cachedS_A")
    send(b6, "B", 1, "session/load", sid="cachedS_B")
    check("load 请求登记 session->client 映射",
          b6.http_session_client.get("cachedS_A") == "A"
          and b6.http_session_client.get("cachedS_B") == "B", str(b6.http_session_client))
    gotA = route(b6, 1, result={})                  # A 的 load 响应（无 result.sessionId）
    gotB = route(b6, 1, result={})                  # B 的 load 响应
    check("A 的 load 响应 -> A", gotA == ["A"], str(gotA))
    check("B 的 load 响应 -> B（同 rid 不串）", gotB == ["B"], str(gotB))

    # ── 7. session/close：端口回收逻辑不回归 + close 响应路由回 client ──
    print("session/close 端口回收 + 路由")
    b7 = build_bridge()
    ensure_poll(b7, "A")
    b7._port_allocated["A"] = 59999
    b7._port_used.add(59999)
    send(b7, "A", 1, "session/close", sid="goneS")
    check("session/close 触发端口回收", "A" not in b7._port_allocated
          and 59999 not in b7._port_used, str(b7._port_allocated))
    got = route(b7, 1, result={})
    check("close 响应路由回 A", got == ["A"], str(got))

    # ── 8. 降级路径：未知/空 client_id 的请求不入队列；响应仍安全 ──
    print("降级路径（无 client_id 的请求）")
    b8 = build_bridge()
    ensure_poll(b8, "default")
    raw = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "session/new",
                      "params": {"cwd": "/tmp", "mcpServers": []}})
    run(b8._write_stdin_now(raw, None))             # client_id=None（WS 通道）
    check("无 client_id 请求不入 per-client 队列", b8._request_queues == {}, str(b8._request_queues))

    print()
    if failures == 0:
        print("per-client 路由验证全部通过")
        return 0
    print(f"{failures} 项失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
