#!/usr/bin/env python3
"""ensure-wps-skills.py 单元测试 — 覆盖 docs/plan-2026-09-07 §5 边界表 10 个场景。

用法：
  conda run -n py312 python scripts/test_ensure_wps_skills.py

做法：用临时目录 + 一个模拟 qwenpaw CLI 的脚本（fake-qwenpaw）做端到端断言，
不触碰真实 QwenPaw 数据（不污染任何真实 agent 工作区）。每个测试用例独立 tmp 目录，
互不泄漏。

fake-qwenpaw 行为与真实 qwenpaw 对齐（2026-09-07 实机核实）：
- `agents list`：读 data_root/agents.json，输出 JSON {"agents": [{id, workspace_dir, ...}]}
- `skills info <name> --agent-id X`：对 {ws}/skills/ 下含 SKILL.md 的目录做清单调和，
  写 skill.json（默认 disabled），然后输出 "Skill:/Enabled: yes|no/Path:"；未知 agent
  或未知 skill → exit 1 + stderr "Error: ... not found"
- `skills enable <name>... --agent-id X`：调和后置 enabled=true，输出 "✓ Enabled: <name>"；
  未知 skill → exit 1
- `skills list --agent-id X`：调和后打印表格（脚本未直接依赖，供诊断）
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(SCRIPTS_DIR, "ensure-wps-skills.py")
FAKE_QWENPAW = os.path.join(SCRIPTS_DIR, "_fake_qwenpaw.py")

EXPECTED_SKILLS = ["wps-excel", "wps-office", "wps-ppt", "wps-proofread", "wps-word"]
WITH_README = {"wps-office", "wps-word", "wps-excel", "wps-ppt"}  # wps-proofread 无 README

ROOT_TMP = tempfile.mkdtemp(prefix="ensure-wps-skills-test-")
print("测试临时目录: {}".format(ROOT_TMP))
FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print("  PASS  {}".format(name))
    else:
        FAILURES.append(name)
        print("  FAIL  {}  {}".format(name, detail))


def new_tmp():
    d = tempfile.mkdtemp(prefix="case-", dir=ROOT_TMP)
    return d


def make_skill_dir(skills_root, name, content=None, readme=None):
    d = os.path.join(skills_root, name)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "SKILL.md"), "w") as f:
        f.write(content if content is not None else "---\nname: {}\n---\n# {}\n".format(name, name))
    if readme is not None or (readme is None and name in WITH_README):
        with open(os.path.join(d, "README.md"), "w") as f:
            f.write(readme if readme is not None else "README {}".format(name))
    return d


def run_script(tmp, agent_id, extra=None):
    """运行被测脚本。extra 为附加参数列表。返回 (exit_code, stdout, stderr)。"""
    data_root = os.path.join(tmp, "qdata")
    os.environ["QP_FAKE_DATA"] = data_root
    cmd = [
        sys.executable, SCRIPT,
        "--agent-id", agent_id,
        "--source-dir", os.path.join(tmp, "src-skills"),
        "--qwenpaw", FAKE_QWENPAW,
    ]
    if extra:
        cmd += extra
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc.returncode, proc.stdout, proc.stderr


def read_skill_json(tmp, agent_id):
    p = os.path.join(tmp, "qdata", "workspaces", agent_id, "skill.json")
    if not os.path.isfile(p):
        return None
    with open(p) as f:
        return json.load(f)


def install_agent(tmp, agent_id="test-agent"):
    """在 fake 数据根注册一个 agent（workspace 为空）。"""
    data_root = os.path.join(tmp, "qdata")
    ws = os.path.join(data_root, "workspaces", agent_id)
    os.makedirs(ws, exist_ok=True)
    agents_file = os.path.join(data_root, "agents.json")
    agents = []
    if os.path.isfile(agents_file):
        with open(agents_file) as f:
            agents = json.load(f).get("agents", [])
    agents.append({"id": agent_id, "workspace_dir": ws})
    os.makedirs(data_root, exist_ok=True)
    with open(agents_file, "w") as f:
        json.dump({"agents": agents}, f)
    return ws


def setup(tmp):
    """构造：源目录 5 个 skill + 已注册 agent。返回 (src_root, ws_root)。"""
    src_root = os.path.join(tmp, "src-skills")
    os.makedirs(src_root, exist_ok=True)
    for name in EXPECTED_SKILLS:
        make_skill_dir(src_root, name)
    ws = install_agent(tmp)
    return src_root, ws


# ── 边界场景 ─────────────────────────────────────────────

def test_empty_source_dir():
    print("## 边界1：空源目录（源缺失）")
    tmp = new_tmp()
    os.makedirs(os.path.join(tmp, "src-skills"), exist_ok=True)
    install_agent(tmp)
    rc, out, err = run_script(tmp, "test-agent")
    check("非 0 退出码", rc != 0, "rc={}".format(rc))
    check("明确错误", "源目录" in err and "SKILL.md" in err, err.strip())


def test_unknown_agent():
    print("## 边界2：目标 agent 不存在")
    tmp = new_tmp()
    setup(tmp)
    rc, out, err = run_script(tmp, "no-such-agent")
    check("非 0 退出码", rc != 0, "rc={}".format(rc))
    check("明确错误", "不存在" in err and "不擅自创建" in err, err.strip())
    check("未创建 agent 工作区", not os.path.exists(
        os.path.join(tmp, "qdata", "workspaces", "no-such-agent")))


def test_first_run():
    print("## 边界3：首次运行（全缺）")
    tmp = new_tmp()
    setup(tmp)
    rc, out, err = run_script(tmp, "test-agent")
    check("退出码 0", rc == 0, "rc={} err={}".format(rc, err.strip()))
    ws = os.path.join(tmp, "qdata", "workspaces", "test-agent")
    for name in EXPECTED_SKILLS:
        check("{} SKILL.md 已复制".format(name),
              os.path.isfile(os.path.join(ws, "skills", name, "SKILL.md")))
    for name in WITH_README:
        check("{} README.md 已复制".format(name),
              os.path.isfile(os.path.join(ws, "skills", name, "README.md")))
    sj = read_skill_json(tmp, "test-agent")
    check("skill.json 存在", sj is not None)
    if sj:
        for name in EXPECTED_SKILLS:
            check("{} enabled=true".format(name),
                  sj.get("skills", {}).get(name, {}).get("enabled") is True)


def test_all_installed_enabled():
    print("## 边界4：已全装且启用 → 无操作")
    tmp = new_tmp()
    setup(tmp)
    rc, _, _ = run_script(tmp, "test-agent")
    check("首次运行退出码 0", rc == 0, "rc={}".format(rc))
    ws = os.path.join(tmp, "qdata", "workspaces", "test-agent")
    before = sorted(os.listdir(os.path.join(ws, "skills")))
    rc2, out2, _ = run_script(tmp, "test-agent")
    after = sorted(os.listdir(os.path.join(ws, "skills")))
    check("再次运行退出码 0", rc2 == 0, "rc={}".format(rc2))
    check("无重复复制", before == after, "{} vs {}".format(before, after))
    sj = read_skill_json(tmp, "test-agent")
    check("全部仍 enabled", all(
        sj["skills"][n]["enabled"] is True for n in EXPECTED_SKILLS))
    check("输出含 already enabled", "already enabled" in out2, out2.strip())


def test_installed_disabled():
    print("## 边界5：已存在但 disabled → 只补 enable 不重新复制")
    tmp = new_tmp()
    src_root, ws = setup(tmp)
    make_skill_dir(os.path.join(ws, "skills"), "wps-office")
    rc, out, err = run_script(tmp, "test-agent")
    check("退出码 0", rc == 0, "rc={} err={}".format(rc, err.strip()))
    sj = read_skill_json(tmp, "test-agent")
    check("wps-office enabled=true", sj["skills"]["wps-office"]["enabled"] is True)
    check("输出 repaired", "repaired" in out, out.strip())


def test_partial_missing():
    print("## 边界6：部分缺失（缺 1 个）")
    tmp = new_tmp()
    src_root, ws = setup(tmp)
    run_script(tmp, "test-agent")
    os.remove(os.path.join(ws, "skills", "wps-excel", "SKILL.md"))
    os.remove(os.path.join(ws, "skills", "wps-excel", "README.md"))
    rc, out, _ = run_script(tmp, "test-agent")
    check("退出码 0", rc == 0, "rc={}".format(rc))
    check("wps-excel 已补回", os.path.isfile(os.path.join(ws, "skills", "wps-excel", "SKILL.md")))
    sj = read_skill_json(tmp, "test-agent")
    check("wps-excel enabled=true", sj["skills"]["wps-excel"]["enabled"] is True)
    for name in ["wps-office", "wps-word", "wps-ppt", "wps-proofread"]:
        check("{} 仍 enabled".format(name), sj["skills"][name]["enabled"] is True)


def test_working_dir_unresolvable():
    print("## 边界7：workspace 解析失败 → 非 0")
    tmp = new_tmp()
    os.makedirs(os.path.join(tmp, "src-skills"), exist_ok=True)
    os.makedirs(os.path.join(tmp, "qdata"), exist_ok=True)
    cmd = [
        sys.executable, SCRIPT,
        "--agent-id", "x",
        "--source-dir", os.path.join(tmp, "src-skills"),
        "--qwenpaw", os.path.join(tmp, "no-such-qwenpaw"),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    check("CLI 不存在 → 非 0", proc.returncode != 0, "rc={}".format(proc.returncode))
    fake_bad = os.path.join(tmp, "fake_bad.py")
    with open(fake_bad, "w") as f:
        f.write("#!/usr/bin/env python3\nimport sys\nprint('garbage output')\nsys.exit(0)\n")
    os.chmod(fake_bad, 0o755)
    cmd = [
        sys.executable, SCRIPT,
        "--agent-id", "x",
        "--source-dir", os.path.join(tmp, "src-skills"),
        "--qwenpaw", fake_bad,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    check("agents list 非 JSON → 非 0", proc.returncode != 0, "rc={}".format(proc.returncode))


def test_enable_failure():
    print("## 边界8：enable 失败不得静默吞掉")
    tmp = new_tmp()
    setup(tmp)
    rc, out, err = run_script(tmp, "test-agent")
    check("基线：首次运行 0", rc == 0, "rc={}".format(rc))
    os.environ["QP_FAKE_FAIL_ENABLE"] = "1"
    install_agent(tmp, "fail-agent")
    rc2, out2, err2 = run_script(tmp, "fail-agent")
    check("非 0 退出码", rc2 != 0, "rc={}".format(rc2))
    check("错误可见", "enable 失败" in out2 or "enable 失败" in err2, out2[-400:] + err2)
    check("完全失败退出码 4", rc2 == 4, "rc={}".format(rc2))
    os.environ.pop("QP_FAKE_FAIL_ENABLE", None)


def test_idempotent():
    print("## 边界9：幂等（连续两次一致，无重复复制）")
    tmp = new_tmp()
    src_root, ws = setup(tmp)
    rc1, out1, _ = run_script(tmp, "test-agent")
    rc2, out2, _ = run_script(tmp, "test-agent")
    check("两次退出码一致", rc1 == rc2 == 0, "{} vs {}".format(rc1, rc2))
    skills_dir = os.path.join(ws, "skills")
    n1 = sum(len(os.listdir(os.path.join(skills_dir, n))) for n in os.listdir(skills_dir))
    rc3, out3, _ = run_script(tmp, "test-agent")
    n2 = sum(len(os.listdir(os.path.join(skills_dir, n))) for n in os.listdir(skills_dir))
    check("文件数不变", n1 == n2, "{} vs {}".format(n1, n2))
    check("第三次仍 0", rc3 == 0, "rc={}".format(rc3))


def test_content_diff_no_overwrite():
    print("## 边界10：同名但内容不同 → 报告差异但不覆盖")
    tmp = new_tmp()
    src_root, ws = setup(tmp)
    run_script(tmp, "test-agent")
    target = os.path.join(ws, "skills", "wps-word", "SKILL.md")
    with open(target, "w") as f:
        f.write("# tampered\n")
    rc, out, _ = run_script(tmp, "test-agent")
    check("退出码 0", rc == 0, "rc={}".format(rc))
    check("报告差异", "内容不一致" in out, out.strip())
    with open(target) as f:
        check("未覆盖", f.read() == "# tampered\n")
    check("skill 仍 enabled",
          read_skill_json(tmp, "test-agent")["skills"]["wps-word"]["enabled"] is True)


def test_dry_run():
    print("## 附加：dry-run 不产生改动")
    tmp = new_tmp()
    src_root, ws = setup(tmp)
    rc, out, _ = run_script(tmp, "test-agent", ["--dry-run"])
    check("退出码 0", rc == 0, "rc={}".format(rc))
    check("无 skill 目录生成", not os.path.exists(os.path.join(ws, "skills")))
    check("输出含 would", "would" in out, out.strip())


def test_unexpected_info_failure():
    print("## 附加：skills info 意外失败（非 not found）→ 不崩溃，映射为失败退出码")
    tmp = new_tmp()
    setup(tmp)
    os.environ["QP_FAKE_FAIL_INFO"] = "1"
    rc, out, err = run_script(tmp, "test-agent")
    check("非 0 退出码", rc != 0, "rc={}".format(rc))
    check("完全失败退出码 4", rc == 4, "rc={}".format(rc))
    check("无 traceback", "Traceback" not in out and "Traceback" not in err,
          out[-200:] + err[-200:])
    os.environ.pop("QP_FAKE_FAIL_INFO", None)


def test_json_output():
    print("## 附加：--json 输出机器可读摘要")
    tmp = new_tmp()
    setup(tmp)
    rc, out, _ = run_script(tmp, "test-agent", ["--json"])
    check("退出码 0", rc == 0, "rc={}".format(rc))
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        check("JSON 可解析", False, str(e))
        return
    check("ok=true", data.get("ok") is True)
    check("summary.total=5", data.get("summary", {}).get("total") == 5)
    check("repaired=5", data.get("summary", {}).get("repaired") == 5)
    check("exit_code=0", data.get("exit_code") == 0)


def main():
    if not os.path.isfile(FAKE_QWENPAW):
        print("缺少 fake qwenpaw 脚本：{}".format(FAKE_QWENPAW), file=sys.stderr)
        sys.exit(2)
    tests = [
        test_empty_source_dir,
        test_unknown_agent,
        test_first_run,
        test_all_installed_enabled,
        test_installed_disabled,
        test_partial_missing,
        test_working_dir_unresolvable,
        test_enable_failure,
        test_idempotent,
        test_content_diff_no_overwrite,
        test_dry_run,
        test_unexpected_info_failure,
        test_json_output,
    ]
    for t in tests:
        try:
            t()
        except Exception as e:
            FAILURES.append(t.__name__)
            print("  ERROR {}: {}".format(t.__name__, e))
    shutil.rmtree(ROOT_TMP, ignore_errors=True)
    print()
    if FAILURES:
        print("FAILED: {}".format(", ".join(FAILURES)))
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
