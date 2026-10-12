#!/usr/bin/env python3
"""wps skill 路由单元验证（docs/plan-2026-10-12 §6：bridge 侧 /skills + /skills/install）。

不依赖真实 qwenpaw：直接构造 AcpBridge 实例，把 _run_ensure_wps_skills 桩化为
固定返回值，驱动 _http_skills_check / _http_skills_install 并断言响应结构与
错误映射（契约 §3：退出码 0/1/2/3/4 语义、opencode server 隔离、缺 agent 参数）。

用法：python bridge/test_skills_route.py
"""
import asyncio
import importlib.util
import json
import os
import sys

BRIDGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "acp-bridge.py")
_spec = importlib.util.spec_from_file_location("acp_bridge", BRIDGE_FILE)
_acp_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_acp_bridge)
AcpBridge = _acp_bridge.AcpBridge


class FakeWriter:
    """收集 _http_json 写入的响应（status + payload）。"""

    def __init__(self):
        self.chunks = []
        self.status = None
        self.payload = None

    def write(self, data: bytes):
        self.chunks.append(data)
        return None

    async def drain(self):
        raw = b"".join(self.chunks)
        head, _, body = raw.partition(b"\r\n\r\n")
        for line in head.decode("utf-8", "replace").split("\r\n"):
            if line.startswith("HTTP/1.1 "):
                self.status = int(line.split(" ")[1])
        if body:
            try:
                self.payload = json.loads(body.decode("utf-8"))
            except Exception:
                self.payload = None

    def close(self):
        pass


def build_bridge(acp_server="qwenpaw"):
    return AcpBridge(http_port=0, port=0, acp_server=acp_server)


def run(coro):
    return asyncio.run(coro)


def make_stub(result):
    """把同步结果包装成协程桩：`_run_ensure_wps_skills` 在 route 内被 await。"""
    async def stub(agent, check_only):
        return result
    return stub


failures = 0


def check(name, cond, detail=""):
    global failures
    if cond:
        print("  ok " + name)
    else:
        failures += 1
        print("  FAIL " + name + (" — " + detail if detail else ""))


def sample_script_ok():
    """ensure-wps-skills.py --check-only 全就位的输出形状。"""
    names = ["wps-office", "wps-word", "wps-excel", "wps-ppt", "wps-proofread"]
    return {
        "ok": True, "exit_code": 0, "agent_id": "default", "check_only": True,
        "missing": [],
        "skills": {n: {"status": "ok", "installed": True, "enabled": True,
                       "path": f"/ws/{n}", "message": "已就位"} for n in names},
        "summary": {"total": 5, "ok": 5, "missing": 0},
    }


def sample_script_missing():
    names = ["wps-office", "wps-word", "wps-excel", "wps-ppt", "wps-proofread"]
    return {
        "ok": False, "exit_code": 4, "agent_id": "assistant", "check_only": True,
        "missing": names,
        "skills": {n: {"status": "missing", "installed": False, "enabled": False,
                       "path": None, "message": "未安装"} for n in names},
        "summary": {"total": 5, "ok": 0, "missing": 5},
    }


def sample_script_stale():
    """单个 skill 源已更新（内容不一致）：status=missing + installed=true + 源更新原因。
    升级覆盖语义（2026-10-12）：bridge 侧把 stale 透传进 missing 列表即可，按钮触发重装。"""
    base = sample_script_ok()
    base["ok"] = False
    base["exit_code"] = 3
    base["missing"] = ["wps-word"]
    base["summary"] = {"total": 5, "ok": 4, "missing": 1}
    base["skills"]["wps-word"] = {
        "status": "missing", "installed": True, "enabled": True,
        "path": "/ws/wps-word", "message": "源已更新（内容不一致），可重装",
    }
    return base


def sample_script_install():
    names = ["wps-office", "wps-word", "wps-excel", "wps-ppt", "wps-proofread"]
    return {
        "ok": True, "exit_code": 0, "agent_id": "assistant",
        "skills": {n: {"status": "repaired", "action": "copy+enable",
                       "message": "ok", "diffs": []} for n in names},
        "summary": {"total": 5, "ok": 0, "repaired": 5, "failed": 0, "skipped": 0},
    }


def main():
    # ── 1. GET /skills：全就位（exit 0） ──
    print("skills GET: 全就位")
    b = build_bridge()
    b._run_ensure_wps_skills = make_stub((0, json.dumps(sample_script_ok()), ""))
    w = FakeWriter()
    run(b._http_skills_check(w, "default"))
    check("状态 200", w.status == 200, f"status={w.status}")
    check("ok=true", w.payload.get("ok") is True)
    check("missing 为空", w.payload.get("missing") == [], str(w.payload.get("missing")))
    check("installed 含 5 项", len(w.payload.get("installed", [])) == 5,
          str(w.payload.get("installed")))
    check("detail 含 installed/enabled/path", w.payload.get("detail", {}).get("wps-word")
          == {"installed": True, "enabled": True, "path": "/ws/wps-word"})

    # ── 2. GET /skills：部分/全部缺失（exit 4） → 200 + missing 列表 ──
    print("skills GET: 全部缺失")
    b2 = build_bridge()
    b2._run_ensure_wps_skills = make_stub((4, json.dumps(sample_script_missing()), ""))
    w2 = FakeWriter()
    run(b2._http_skills_check(w2, "assistant"))
    check("状态 200", w2.status == 200, f"status={w2.status}")
    check("missing 含 5 项", len(w2.payload.get("missing", [])) == 5, str(w2.payload.get("missing")))
    check("installed 为空", w2.payload.get("installed") == [])
    check("exit_code=4 透传", w2.payload.get("exit_code") == 4)

    # ── 2b. GET /skills：源已更新（stale，exit 3） → 200 + 该 skill 进 missing 列表 ──
    print("skills GET: 源已更新（升级覆盖语义）")
    b2b = build_bridge()
    b2b._run_ensure_wps_skills = make_stub((3, json.dumps(sample_script_stale()), ""))
    w2b = FakeWriter()
    run(b2b._http_skills_check(w2b, "default"))
    check("状态 200", w2b.status == 200, f"status={w2b.status}")
    check("missing 含 wps-word", w2b.payload.get("missing") == ["wps-word"],
          str(w2b.payload.get("missing")))
    check("installed 含 4 项", len(w2b.payload.get("installed", [])) == 4,
          str(w2b.payload.get("installed")))
    check("stale 的 detail 保留 installed/enabled/path", w2b.payload.get("detail", {}).get("wps-word")
          == {"installed": True, "enabled": True, "path": "/ws/wps-word"})
    check("exit_code=3 透传", w2b.payload.get("exit_code") == 3)

    # ── 3. GET /skills：脚本调用失败（rc=2 qwenpaw CLI 失败） → 502 ──
    print("skills GET: qwenpaw CLI 失败")
    b3 = build_bridge()
    b3._run_ensure_wps_skills = make_stub((2, "", "qwenpaw: boom"))
    w3 = FakeWriter()
    run(b3._http_skills_check(w3, "default"))
    check("状态 502", w3.status == 502, f"status={w3.status}")
    check("ok=false", w3.payload.get("ok") is False)
    check("error 透传 stderr", "boom" in w3.payload.get("error", ""))

    # ── 4. GET /skills：脚本超时（rc=None） → 502 ──
    print("skills GET: 脚本超时")
    b4 = build_bridge()
    b4._run_ensure_wps_skills = make_stub((None, "", "超时"))
    w4 = FakeWriter()
    run(b4._http_skills_check(w4, "default"))
    check("状态 502", w4.status == 502, f"status={w4.status}")
    check("error 含超时", "超时" in w4.payload.get("error", ""))

    # ── 5. GET /skills：缺 agent 参数 → 400 ──
    print("skills GET: 缺 agent 参数")
    w5 = FakeWriter()
    run(build_bridge()._http_skills_check(w5, ""))
    check("状态 400", w5.status == 400, f"status={w5.status}")
    check("error 提示缺参数", "agent" in w5.payload.get("error", ""))

    # ── 6. POST /skills/install：成功（repaired=5） → 200 透传 summary ──
    print("skills POST: 安装成功")
    b6 = build_bridge()
    b6._run_ensure_wps_skills = make_stub((0, json.dumps(sample_script_install()), ""))
    w6 = FakeWriter()
    run(b6._http_skills_install(w6, "assistant"))
    check("状态 200", w6.status == 200, f"status={w6.status}")
    check("ok=true", w6.payload.get("ok") is True)
    check("summary.repaired=5", w6.payload.get("summary", {}).get("repaired") == 5,
          str(w6.payload.get("summary")))
    check("skills 透传", len(w6.payload.get("skills", {})) == 5)

    # ── 7. opencode server 隔离：/skills 与 /skills/install 均 400 ──
    print("opencode server 隔离")
    b7 = build_bridge(acp_server="opencode")
    w7a = FakeWriter()
    run(b7._http_skills_check(w7a, "default"))
    w7b = FakeWriter()
    run(b7._http_skills_install(w7b, "default"))
    check("check 400", w7a.status == 400, f"status={w7a.status}")
    check("install 400", w7b.status == 400, f"status={w7b.status}")
    check("错误提示仅支持 qwenpaw", "qwenpaw" in w7a.payload.get("error", ""))

    print()
    if failures == 0:
        print("wps skill 路由验证全部通过")
        return 0
    print(f"{failures} 项失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
