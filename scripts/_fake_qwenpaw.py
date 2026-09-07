#!/usr/bin/env python3
"""_fake_qwenpaw.py — 测试用 qwenpaw CLI 模拟器（行为对齐真实 qwenpaw 2.2.0，2026-09-07 核实）。

环境变量：
  QP_FAKE_DATA           fake 数据根（含 agents.json 与 workspaces/）
  QP_FAKE_FAIL_ENABLE    置 1 时 `skills enable` 全部失败（exit 1）
  QP_FAKE_FAIL_INFO      置 1 时 `skills info` 以非「not found」错误失败（exit 2）

命令：
  agents list                          -> {"agents": [{id, workspace_dir, ...}]}
  skills info <name> --agent-id X      -> 调和后输出 Skill:/Enabled:/Path:；未知 -> exit 1
  skills enable <name>... --agent-id X -> 调和后置 enabled=true；未知 -> exit 1
  skills list --agent-id X             -> 调和后打印表格（供诊断）
"""
import json
import os
import sys

DATA_ROOT = os.environ.get("QP_FAKE_DATA")
FAIL_ENABLE = os.environ.get("QP_FAKE_FAIL_ENABLE") == "1"
FAIL_INFO = os.environ.get("QP_FAKE_FAIL_INFO") == "1"


def agents_file():
    return os.path.join(DATA_ROOT, "agents.json")


def load_agents():
    with open(agents_file()) as f:
        return json.load(f).get("agents", [])


def workspace_dir(agent_id):
    for a in load_agents():
        if a.get("id") == agent_id:
            return a.get("workspace_dir")
    return None


def skill_json_path(ws):
    return os.path.join(ws, "skill.json")


def load_skill_json(ws):
    p = skill_json_path(ws)
    if not os.path.isfile(p):
        return {"schema_version": "workspace-skill-manifest.v1", "version": 1, "skills": {}}
    with open(p) as f:
        return json.load(f)


def save_skill_json(ws, data):
    data["version"] = data.get("version", 1) + 1
    with open(skill_json_path(ws), "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def reconcile(ws):
    """清单调和：{ws}/skills/ 下含 SKILL.md 的目录若无条目则写入 disabled。"""
    data = load_skill_json(ws)
    skills_dir = os.path.join(ws, "skills")
    if os.path.isdir(skills_dir):
        for name in os.listdir(skills_dir):
            d = os.path.join(skills_dir, name)
            if os.path.isdir(d) and os.path.isfile(os.path.join(d, "SKILL.md")):
                if name not in data["skills"]:
                    data["skills"][name] = {"enabled": False}
    save_skill_json(ws, data)
    return data


def list_skills(ws):
    d = reconcile(ws)
    return d["skills"]


def cmd_agents_list():
    print(json.dumps({"agents": load_agents()}, indent=2))


def cmd_skills_info(args):
    if FAIL_INFO:
        print("Error: simulated unexpected info failure", file=sys.stderr)
        sys.exit(2)
    name = args[2]
    agent_id = args[args.index("--agent-id") + 1] if "--agent-id" in args else "default"
    ws = workspace_dir(agent_id)
    if ws is None:
        print("Error: Agent '{}' not found.".format(agent_id), file=sys.stderr)
        sys.exit(1)
    skills = list_skills(ws)
    if name not in skills:
        print("Error: Skill '{}' was not found for agent '{}'.".format(
            name, agent_id), file=sys.stderr)
        sys.exit(1)
    enabled = skills[name].get("enabled", False)
    print("Skill: {}".format(name))
    print("Enabled: {}".format("yes" if enabled else "no"))
    print("Channels: all")
    print("Source: customized")
    print("Path: {}".format(os.path.join(ws, "skills", name)))


def cmd_skills_enable(args):
    names = []
    agent_id = "default"
    i = 2
    while i < len(args):
        if args[i] == "--agent-id":
            agent_id = args[i + 1]
            i += 2
        else:
            names.append(args[i])
            i += 1
    ws = workspace_dir(agent_id)
    if ws is None:
        print("Error: Agent '{}' not found.".format(agent_id), file=sys.stderr)
        sys.exit(1)
    skills = list_skills(ws)
    if FAIL_ENABLE:
        for n in names:
            print("  ✗ Failed to enable: {} (simulated failure)".format(n))
        sys.exit(1)
    failed = [n for n in names if n not in skills]
    if failed:
        print("Error: Failed to enable {} skill(s): {}".format(
            len(failed), failed[0]), file=sys.stderr)
        sys.exit(1)
    data = load_skill_json(ws)
    for n in names:
        data["skills"][n]["enabled"] = True
    save_skill_json(ws, data)
    for n in names:
        print("  ✓ Enabled: {}".format(n))


def cmd_skills_list(args):
    agent_id = args[args.index("--agent-id") + 1] if "--agent-id" in args else "default"
    ws = workspace_dir(agent_id)
    if ws is None:
        print("Error: Agent '{}' not found.".format(agent_id), file=sys.stderr)
        sys.exit(1)
    skills = list_skills(ws)
    print("Skills for agent: {}".format(agent_id))
    if not skills:
        print("\nNo skills found.")
        return
    print()
    print("  Skill Name                     Source       Status")
    print("  " + "-" * 66)
    for name, meta in skills.items():
        st = "✓ enabled" if meta.get("enabled") else "✗ disabled"
        print("  {:<32} customized   {}".format(name, st))


def main():
    if not DATA_ROOT or not os.path.isdir(DATA_ROOT):
        print("Error: QP_FAKE_DATA not set", file=sys.stderr)
        sys.exit(1)
    args = sys.argv[1:]
    if not args:
        print("Usage: fake-qwenpaw <command> ...")
        sys.exit(1)
    cmd = args[0]
    if cmd == "agents" and len(args) > 1 and args[1] == "list":
        cmd_agents_list()
    elif cmd == "skills" and len(args) > 1 and args[1] == "info":
        cmd_skills_info(args)
    elif cmd == "skills" and len(args) > 1 and args[1] == "enable":
        cmd_skills_enable(args)
    elif cmd == "skills" and len(args) > 1 and args[1] == "list":
        cmd_skills_list(args)
    else:
        print("Error: unsupported fake command: {}".format(" ".join(args)), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
