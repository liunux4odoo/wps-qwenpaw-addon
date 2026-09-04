#!/usr/bin/env python3
"""切换竞态 + MCP 入口兜底 端到端验证。

对应 docs/plan-2026-09-04-agent-switch-mcp-race-fix.md §6.1/§6.3：
  1. 基线：agent A 下 session/new（wps mcp 绝对路径）-> 必拿 sessionId
  2. 切换竞态：/agent/set -> agent B（返回 ok 后**立即**）-> session/new
     -> 必拿 sessionId（不得被静默丢弃；重试 ≤1 次内成功）
  3. 相对路径兜底：session/new 传**相对路径** wps mcp args -> bridge 权威注入绝对路径
     -> 必拿 sessionId（不得"相对路径 spawn 失败 -> 无工具"）

用法：python bridge/test_switch_race.py [agent_a] [agent_b]
"""
import json
import subprocess
import sys
import time
import urllib.request

BRIDGE = __import__("os").path.join(__import__("os").path.dirname(__file__), "acp-bridge.py")
PORT = 8894
BRIDGE_LOG = "/tmp/bridge_switch_race.log"
NEW_TIMEOUT = 30.0


def req(method, path, body=None, timeout=20):
    url = f"http://127.0.0.1:{PORT}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except Exception as e:
        return getattr(e, "code", 0), str(e)


def poll(client, n=5):
    st, body = req("GET", f"/acp/poll?clientId={client}", timeout=15)
    if st != 200 or not body:
        return []
    return [l for l in body.splitlines() if l.strip()]


def new_session(client, args):
    """发送 session/new（wps mcp args 由调用方给定），等待并返回 sessionId；超时返回 None。"""
    msg = {"jsonrpc": "2.0", "id": 100, "method": "session/new", "params": {
        "cwd": "/tmp",
        "mcpServers": [{
            "name": "wps", "command": "node", "args": args,
            "env": [{"name": "WPS_POLL_PORT", "value": "58891"}],
        }],
    }}
    req("POST", f"/acp/send?clientId={client}", body=msg)
    t0 = time.time()
    while time.time() - t0 < NEW_TIMEOUT:
        for line in poll(client):
            try:
                m = json.loads(line)
            except Exception:
                continue
            if not isinstance(m, dict):
                continue
            if m.get("error"):
                print(f"   [{client}] session/new ERROR: {json.dumps(m['error'])[:200]}")
                return None
            if isinstance(m.get("result"), dict) and m["result"].get("sessionId"):
                return m["result"]["sessionId"]
        time.sleep(0.5)
    return None


def main():
    agent_a = sys.argv[1] if len(sys.argv) > 1 else "assistant"
    agent_b = sys.argv[2] if len(sys.argv) > 2 else "ai-developer"
    # wps-mcp 入口（真实绝对路径；相对路径场景由调用方传相对路径）
    wps_entry = "/data/myrepo/wps-qwenpaw-addon/third_party/opencode-wps/wps-office-mcp/dist/index.js"
    flog = open(BRIDGE_LOG, "w")
    bridge = subprocess.Popen(
        [sys.executable, BRIDGE, "--http-port", str(PORT), "--agent", agent_a,
         "--wps-mcp-entry", wps_entry, "--log-file", BRIDGE_LOG],
        stdout=flog, stderr=subprocess.STDOUT, text=True,
    )
    try:
        for _ in range(60):
            try:
                st, _ = req("GET", "/status", timeout=3)
                if st == 200:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            print("❌ bridge 未就绪")
            return 1
        print(f"bridge up (agent_a={agent_a})")

        # 1) 基线：agent A + 绝对路径 wps mcp
        print("[1] 基线 session/new（绝对路径）...")
        sid1 = new_session("c1", [wps_entry])
        print(f"    -> sid={sid1}")
        if not sid1:
            print("❌ [1] 基线 session/new 未拿到 sessionId")
            return 1
        print("    ✅ [1] 基线通过")

        # 2) 切换竞态：/agent/set 返回 ok 后立即 session/new
        print(f"[2] /agent/set -> {agent_b}（返回后立即 session/new）...")
        t0 = time.time()
        st, body = req("POST", f"/agent/set?agent={agent_b}", timeout=20)
        switch_took = time.time() - t0
        print(f"    /agent/set: {st} {body[:150]} (took {switch_took:.1f}s)")
        if st != 200 or '"ok": true' not in body and '"ok":true' not in body:
            print("❌ [2] /agent/set 失败")
            return 1
        sid2 = new_session("c1", [wps_entry])
        if not sid2:
            print("❌ [2] 切换后立即 session/new 被静默丢弃（未拿到 sessionId）")
            return 1
        print(f"    ✅ [2] 切换后立即 session/new 拿到 sessionId={sid2}")

        # 3) 相对路径兜底：传相对路径，bridge 权威注入绝对路径
        print("[3] 相对路径 wps mcp args -> bridge 应权威注入绝对路径...")
        sid3 = new_session("c2", ["../third_party/opencode-wps/wps-office-mcp/dist/index.js"])
        if not sid3:
            print("❌ [3] 相对路径 session/new 未拿到 sessionId（可能未注入绝对路径）")
            return 1
        print(f"    ✅ [3] 相对路径 session/new 拿到 sessionId={sid3}（bridge 已注入绝对路径）")

        print("\n✅ 切换竞态 + MCP 入口兜底全部通过")
        return 0
    finally:
        bridge.kill()
        bridge.wait(timeout=5)
        flog.close()
        print("=== bridge log（关键行） ===")
        try:
            with open(BRIDGE_LOG) as f:
                for ln in f.readlines():
                    if any(k in ln for k in ("inject authoritative wpsMcpEntry", "switching agent",
                                             "switched", "spawning qwenpaw acp", "switch_agent",
                                             "queued", "stdin unavailable", "upstream")):
                        print("  " + ln.rstrip()[:220])
        except Exception as e:
            print("log read err", e)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"\n❌ FAILED: {e}")
        sys.exit(1)
