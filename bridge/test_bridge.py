#!/usr/bin/env python3
"""端到端验证 acp-bridge：ws://127.0.0.1:8765 -> bridge -> qwenpaw acp stdio。
测试：initialize -> session/new -> session/prompt(流式) -> 重连会话不丢 -> session/close。
"""
import asyncio
import json
import sys

import websockets

WS_URL = "ws://127.0.0.1:8765"


async def recv_until(ws, target_id, timeout=90):
    """持续收消息直到收到 id==target_id 的响应；中途的通知返回给调用方处理，直到命中目标 id。"""
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout)
        msg = json.loads(raw)
        if msg.get("id") == target_id:
            return msg
        # 非目标消息（通知/其它响应）打印后继续等
        print("  [skip]", json.dumps(msg, ensure_ascii=False)[:120])


async def main():
    rid = [0]

    def next_id():
        rid[0] += 1
        return rid[0]

    # 1) 连接 + initialize
    print("=== connect ===")
    ws = await websockets.connect(WS_URL)
    init_id = next_id()
    await ws.send(json.dumps({
        "jsonrpc": "2.0", "id": init_id, "method": "initialize",
        "params": {"protocolVersion": 0, "clientInfo": {"name": "test-client", "version": "0.1"}},
    }))
    init_resp = await recv_until(ws, init_id)
    print("initialize ->", json.dumps(init_resp, ensure_ascii=False)[:200])
    assert init_resp.get("id") == init_id, "initialize id 不匹配"

    # 2) session/new
    print("=== session/new ===")
    new_id = next_id()
    await ws.send(json.dumps({
        "jsonrpc": "2.0", "id": new_id, "method": "session/new",
        "params": {"cwd": "/tmp/kilo", "mcpServers": []},
    }))
    new_resp = await recv_until(ws, new_id)
    print("session/new ->", json.dumps(new_resp, ensure_ascii=False)[:200])
    session_id = new_resp["result"]["sessionId"]
    print("sessionId =", session_id)
    assert new_resp.get("id") == new_id

    # 3) session/prompt 流式
    print("=== session/prompt（流式） ===")
    prompt_id = next_id()
    await ws.send(json.dumps({
        "jsonrpc": "2.0", "id": prompt_id, "method": "session/prompt",
        "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "用一句话自我介绍。"}]},
    }))
    chunks = []
    while True:
        raw = await asyncio.wait_for(ws.recv(), 120)
        msg = json.loads(raw)
        if msg.get("method") == "session/update":
            upd = msg.get("params", {}).get("update", {})
            if upd.get("sessionUpdate") == "agent_message_chunk":
                t = upd.get("content", {}).get("text", "")
                if t:
                    chunks.append(t)
            elif upd.get("sessionUpdate") == "usage_update":
                print("  [usage]", json.dumps(upd.get("_meta", {}), ensure_ascii=False)[:200])
        elif msg.get("id") == prompt_id:
            print("  [prompt response] stopReason =", msg.get("result", {}).get("stopReason"))
            break
    full = "".join(chunks)
    print("  [streamed text]", full[:300])
    assert full.strip(), "流式文本为空！"

    # 4) 重连：关 WS，重连，用同一 session 再发消息（验证会话由 qwenpaw acp 持有）
    print("=== 断开重连，复用同一 session ===")
    await ws.close()
    ws2 = await websockets.connect(WS_URL)
    # 重新 initialize
    iid = next_id()
    await ws2.send(json.dumps({
        "jsonrpc": "2.0", "id": iid, "method": "initialize",
        "params": {"protocolVersion": 0, "clientInfo": {"name": "test-client", "version": "0.1"}},
    }))
    await recv_until(ws2, iid)
    # session/load 复用旧会话
    lid = next_id()
    await ws2.send(json.dumps({
        "jsonrpc": "2.0", "id": lid, "method": "session/load",
        "params": {"sessionId": session_id, "cwd": "/tmp/kilo", "mcpServers": []},
    }))
    load_resp = await recv_until(ws2, lid)
    print("  session/load ->", json.dumps(load_resp, ensure_ascii=False)[:200])
    assert load_resp.get("id") == lid

    pid = next_id()
    await ws2.send(json.dumps({
        "jsonrpc": "2.0", "id": pid, "method": "session/prompt",
        "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "我刚才让你做什么？一句话回答。"}]},
    }))
    chunks2 = []
    while True:
        raw = await asyncio.wait_for(ws2.recv(), 120)
        msg = json.loads(raw)
        if msg.get("method") == "session/update":
            upd = msg.get("params", {}).get("update", {})
            if upd.get("sessionUpdate") == "agent_message_chunk":
                t = upd.get("content", {}).get("text", "")
                if t:
                    chunks2.append(t)
        elif msg.get("id") == pid:
            break
    print("  [reconnect streamed]", "".join(chunks2)[:300])
    assert "".join(chunks2).strip(), "重连后流式文本为空！"

    # 5) session/close
    print("=== session/close ===")
    cid = next_id()
    await ws2.send(json.dumps({
        "jsonrpc": "2.0", "id": cid, "method": "session/close",
        "params": {"sessionId": session_id},
    }))
    close_resp = await recv_until(ws2, cid, timeout=15)
    print("  session/close ->", json.dumps(close_resp, ensure_ascii=False)[:200])
    await ws2.close()

    print("\n✅ 端到端全部通过")
    return 0


if __name__ == "__main__":
    try:
        rc = asyncio.run(main())
        sys.exit(rc)
    except Exception as e:
        print("\n❌ FAILED:", e)
        sys.exit(1)
