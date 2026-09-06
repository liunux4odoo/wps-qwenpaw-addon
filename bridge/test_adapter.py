#!/usr/bin/env python3
"""server adapter E2E 验证（docs/plan-2026-09-05 §5.4 验收 + A1/A2）。

用法：
  python bridge/test_adapter.py qwenpaw [port]      # qwenpaw adapter 零回归
  python bridge/test_adapter.py opencode [port]     # opencode adapter 可建会话/对话/切换

流程（自 spawn bridge，独立端口避开常驻 :8765/:8766）：
  1. /config      -> 校验 acpServer + capabilities 字段
  2. /poll-port/allocate -> 拿 WPS_POLL_PORT
  3. /agents      -> 枚举 agent/mode
  4. session/new  -> 建会话（qwenpaw 带 wps mcp 验证权威注入；opencode 用 mcpServers:[] 兜底）
  5. session/prompt -> 流式 agent_message_chunk
  6. /agent/set   -> 切换语义（restart / config_option）

注：qwenpaw 的 /agents 依赖本机 qwenpaw daemon 或 CLI（agent list 需 daemon/config.json，
环境无 daemon 时返回空列表属预期，不影响 session 链路）。
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

BRIDGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "acp-bridge.py")


def req(port, method, path, body=None, timeout=30):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except Exception as e:
        return getattr(e, "code", 0), {"error": str(e)}


def poll(port, client):
    url = f"http://127.0.0.1:{port}/acp/poll?clientId={client}"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except Exception:
        return []
    return [ln for ln in raw.splitlines() if ln.strip()]


def wait_for(port, client, want_id, timeout=60):
    """轮询 /acp/poll 直到收到 id==want_id 的响应。返回 (msg, 流式文本)。"""
    t0 = time.time()
    text = ""
    while time.time() - t0 < timeout:
        for line in poll(port, client):
            try:
                m = json.loads(line)
            except Exception:
                continue
            if m.get("method") == "session/update":
                upd = (m.get("params") or {}).get("update") or {}
                if upd.get("sessionUpdate") == "agent_message_chunk":
                    text += (upd.get("content") or {}).get("text", "")
                continue
            if m.get("id") == want_id:
                return m, text
        time.sleep(0.3)
    return None, text


def main():
    server = sys.argv[1] if len(sys.argv) > 1 else "qwenpaw"
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8910
    ws_port = port + 1  # 避开默认 8765（常驻 bridge）
    print(f"=== E2E adapter: {server} (http={port}, ws={ws_port}) ===", flush=True)

    log_path = f"/tmp/test_adapter_{server}.log"
    flog = open(log_path, "w")
    bridge = subprocess.Popen(
        [sys.executable, BRIDGE, "--http-port", str(port), "--port", str(ws_port),
         "--acp-server", server, "--log-file", log_path],
        stdout=flog, stderr=subprocess.STDOUT, text=True,
    )
    try:
        ready = False
        for _ in range(60):
            try:
                st, _ = req(port, "GET", "/status", timeout=3)
                if st == 200:
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if not ready:
            print("❌ bridge 未就绪", flush=True)
            return 1

        # 1) /config
        st, cfg = req(port, "GET", "/config", timeout=5)
        print(f"1) /config acpServer={cfg.get('acpServer')} capabilities={json.dumps(cfg.get('capabilities', {}), ensure_ascii=False)}", flush=True)
        assert cfg.get("acpServer") == server, f"acpServer 应为 {server}: {cfg}"
        assert isinstance(cfg.get("capabilities"), dict) and cfg["capabilities"], "capabilities 为空"

        # 2) allocate poll port
        client = "e2e-c1"
        st, r = req(port, "POST", f"/poll-port/allocate?clientId={client}", timeout=5)
        port_alloc = r.get("port")
        print(f"2) /poll-port/allocate -> {port_alloc}", flush=True)
        assert port_alloc, f"端口分配失败: {r}"

        # 3) /agents
        st, r = req(port, "GET", "/agents", timeout=60)
        agents = r.get("agents") or []
        print(f"3) /agents -> {len(agents)} agents, current={r.get('current')}", flush=True)
        assert isinstance(agents, list), f"/agents 异常: {r}"

        # 4) session/new（qwenpaw 带 wps mcp 验证权威注入；opencode 用 mcpServers:[] 兜底，V3）
        mcp_servers = [{
            "name": "wps", "command": "node",
            "args": [cfg.get("wpsMcpEntry")],
            "env": [{"name": "WPS_POLL_PORT", "value": "58891"}],
        }] if server == "qwenpaw" else []
        new_id = 100
        req(port, "POST", f"/acp/send?clientId={client}", body={
            "jsonrpc": "2.0", "id": new_id, "method": "session/new",
            "params": {"cwd": "/tmp", "mcpServers": mcp_servers},
        }, timeout=5)
        resp, _ = wait_for(port, client, new_id, timeout=90)
        sid = (resp or {}).get("result", {}).get("sessionId")
        print(f"4) session/new -> {'OK sid=' + str(sid) if sid else 'FAIL: ' + json.dumps(resp, ensure_ascii=False)[:300]}", flush=True)
        if not sid:
            print("❌ session/new 失败", flush=True)
            return 1

        # 5) session/prompt 流式
        pid = 200
        req(port, "POST", f"/acp/send?clientId={client}", body={
            "jsonrpc": "2.0", "id": pid, "method": "session/prompt",
            "params": {"sessionId": sid, "prompt": [{"type": "text", "text": "只回复 OK 两个字母。"}]},
        }, timeout=5)
        resp, text = wait_for(port, client, pid, timeout=90)
        stop = (resp or {}).get("result", {}).get("stopReason") if (resp or {}).get("result") else "ERR"
        print(f"5) session/prompt -> stopReason={stop}, streamed={text!r}", flush=True)
        assert (resp or {}).get("result") is not None, f"prompt 失败: {json.dumps(resp, ensure_ascii=False)[:300]}"

        # 6) /agent/set（有 agent 切换；无 agent 时测空 target 拒绝路径 → HTTP 400）
        target = agents[0]["id"] if agents else ""
        st, r = req(port, "POST", f"/agent/set?agent={target}", timeout=20)
        print(f"6) /agent/set -> ok={r.get('ok')} agent={r.get('agent')} error={r.get('error')} (http={st})", flush=True)
        if target:
            assert r.get("ok"), f"/agent/set 失败: {r}"
        else:
            assert st == 400, f"/agent/set 空 target 应 HTTP 400: {st} {r}"

        print(f"\n✅ {server} adapter E2E PASS", flush=True)
        return 0
    finally:
        bridge.kill()
        try:
            bridge.wait(timeout=5)
        except Exception:
            pass
        flog.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"\n❌ FAILED: {e}")
        sys.exit(1)
