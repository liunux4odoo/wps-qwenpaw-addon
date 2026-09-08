#!/usr/bin/env python3
"""ensure-wps-skills.py — 确保指定 QwenPaw agent 工作区已安装并启用 5 个 wps skill。

背景（docs/plan-2026-09-07-wps-skill-auto-install.md，方案 C）：
opencode-wps 提供 5 个分裂 skill（wps-office / wps-word / wps-excel / wps-ppt /
wps-proofread），但只装在 ~/.opencode/skills/（opencode 专用）。QwenPaw 侧
需要把 SKILL.md 复制进 `{workspace}/skills/{name}/` 并走官方 CLI `qwenpaw skills
enable` 启用（**不手动改 skill.json**）。

设计要点：
- **只走 QwenPaw 官方 CLI**：workspace 目录由 `qwenpaw agents list` 解析，
  skill 存在/启用状态由 `qwenpaw skills info` 判定，启用只调 `qwenpaw skills
  enable`。不手动解析 QWENPAW_WORKING_DIR、不手动改 skill.json。
- **语义 = ensure**：不满足则补齐，满足则无操作；幂等。
- **缺失则复制**：SKILL.md 缺失才复制；按「源 + 降级块」基准对比，内容不一致 →
  报告差异但不覆盖（已知限制，升级覆盖语义需单独决策）。
- **安装期 transform（v2）**：复制 SKILL.md 时统一追加「环境检查与降级要求」块
  （标准文案见 docs/plan §12）。只写目标目录，源 submodule 保持原样。已安装但
  缺降级块 → 视为未装好，重新复制（升级，§5 #11）；源或目标已含降级块则跳过
  追加（transform 幂等，§5 #12）。
- **不擅自创建 agent**：目标 agent 不存在 → 失败。
- 单次 qwenpaw 调用超时 60s（QWENPAW_TIMEOUT），防挂死阻塞调用方。

用法：
  python scripts/ensure-wps-skills.py --agent-id <ID> [--source-dir <DIR>]
      [--qwenpaw <PATH>] [--json] [--dry-run]

退出码契约（冻结，bridge 依赖）：
  0  全部就位（本次无操作，或补齐成功；输出 summary 区分 repaired）
  1  用法/配置错误：缺 --agent-id、源目录缺失/为空、agent 不存在、
     找不到 qwenpaw CLI
  2  qwenpaw CLI 调用失败：agents list / 版本探测等环境问题
  3  部分失败：部分 skill 复制/启用失败（其余已就位）
  4  完全失败：需要处理的 skill 全部失败
"""
import argparse
import filecmp
import json
import os
import shutil
import subprocess
import sys

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DEFAULT_SOURCE_DIR = os.path.join(REPO_ROOT, "third_party", "opencode-wps", "skills")

SKILL_FILES = ("SKILL.md", "README.md")

EXIT_OK = 0            # 全部就位（无操作，或补齐成功）
EXIT_USAGE = 1         # 用法/配置错误
EXIT_CLI = 2           # qwenpaw CLI 调用失败
EXIT_PARTIAL = 3       # 部分失败
EXIT_FAIL = 4          # 完全失败

STATUS_OK = "ok"             # 已安装且启用，无操作
STATUS_REPAIRED = "repaired"  # 本次补齐（复制/启用）后已就位
STATUS_FAILED = "failed"     # 复制/启用失败，未就位
STATUS_SKIPPED = "skipped"   # dry-run，本次未执行

# v2 安装期 transform：降级块标准文案（docs/plan §12）。
DEGRADATION_MARKER = "## ⚠️ 环境检查与降级要求"
DEGRADATION_BLOCK = (
    "## ⚠️ 环境检查与降级要求\n"
    "\n"
    "本 skill 依赖 wps-mcp 提供的 `wps_*` 工具。这些工具只在「WPS 侧边栏插件入口」\n"
    "的会话中存在（该入口经 ACP 注入 wps-mcp）。\n"
    "\n"
    "**执行任何 WPS 操作前，先检查当前会话工具列表中是否有 `wps_` 前缀的工具。**\n"
    "\n"
    "- 有 → 正常执行本 skill 描述的操作。\n"
    "- 没有（例如在 QwenPaw 网页控制台等其它入口对话时）→\n"
    "  1. 不要尝试调用不存在的 wps 工具；\n"
    "  2. 不要编造或猜测操作结果；\n"
    "  3. 不要承诺「帮你打开 WPS」这类无法兑现的动作；\n"
    "  4. 明确告知用户：当前入口未挂载 WPS 能力，请在 WPS 侧边栏插件入口操作。\n"
)


class QwenpawError(Exception):
    """qwenpaw CLI 不可用 / 调用失败。"""


class UsageError(Exception):
    """用法/配置错误（agent 不存在、源目录缺失等）。"""


def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="ensure-wps-skills.py",
        description=(
            "确保 5 个 wps skill 在指定 QwenPaw agent 工作区已安装且启用。\n"
            "安装期会向每份 SKILL.md 末尾追加「环境检查与降级要求」块\n"
            "（源目录保持原样；已含该块则跳过，幂等）。"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "退出码契约（冻结，bridge 依赖）：\n"
            "  0  全部就位（本次无操作，或补齐成功）\n"
            "  1  用法/配置错误：缺 --agent-id、源目录缺失/为空、agent 不存在、找不到 qwenpaw CLI\n"
            "  2  qwenpaw CLI 调用失败（agents list / 版本探测等环境问题）\n"
            "  3  部分失败：部分 skill 复制/启用失败（其余已就位）\n"
            "  4  完全失败：需要处理的 skill 全部失败"
        ),
    )
    p.add_argument("--agent-id", required=True, help="目标 QwenPaw agent ID（必填）")
    p.add_argument(
        "--source-dir",
        default=DEFAULT_SOURCE_DIR,
        help=f"wps skill 源目录（默认 {DEFAULT_SOURCE_DIR}）",
    )
    p.add_argument(
        "--qwenpaw",
        default=None,
        help="qwenpaw CLI 路径（默认取当前 Python 环境 python -m qwenpaw，"
             "再退化到 PATH 中的 qwenpaw）",
    )
    p.add_argument("--json", action="store_true", help="输出机器可读 JSON 摘要（bridge 友好）")
    p.add_argument("--dry-run", action="store_true", help="只报告将要执行的动作，不实际改动")
    return p.parse_args(argv)


def build_qwenpaw_cmd(explicit=None):
    """构造 qwenpaw 命令前缀。返回 list[str]。

    优先级：--qwenpaw 显式路径 > 当前解释器 `python -m qwenpaw` > PATH 的 qwenpaw。
    找不到时抛 QwenpawError。
    """
    if explicit:
        return [explicit]
    py = sys.executable
    probe = subprocess.run([py, "-m", "qwenpaw", "--version"], capture_output=True, text=True)
    if probe.returncode == 0:
        return [py, "-m", "qwenpaw"]
    which = shutil.which("qwenpaw")
    if which:
        return [which]
    raise QwenpawError(
        "找不到 qwenpaw CLI：`python -m qwenpaw` 与 PATH 中均无。"
        "请用 conda 的 py312 环境运行本脚本，或通过 --qwenpaw 指定路径。"
    )


QWENPAW_TIMEOUT = 60  # 单次 qwenpaw 调用超时（秒），防挂死阻塞 bridge


def run_qwenpaw(cmd, args):
    """执行 qwenpaw 子命令，返回 (exit_code, stdout, stderr)。

    超时抛 QwenpawError（调用方按配置/CLI 错误处理）。
    """
    try:
        proc = subprocess.run(
            cmd + args, capture_output=True, text=True, timeout=QWENPAW_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        raise QwenpawError(
            "qwenpaw 调用超时（>{}s）：`{}`".format(QWENPAW_TIMEOUT, " ".join(cmd + args))
        )
    return proc.returncode, proc.stdout, proc.stderr


def list_agents(cmd):
    """`qwenpaw agents list` -> {agent_id: workspace_dir}。

    调用失败（不可用 / 输出非 JSON）抛 QwenpawError。
    """
    rc, out, err = run_qwenpaw(cmd, ["agents", "list"])
    if rc != 0:
        raise QwenpawError(
            "`qwenpaw agents list` 失败（exit={}）：{}".format(rc, err.strip() or out.strip())
        )
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        raise QwenpawError("`qwenpaw agents list` 输出无法解析为 JSON：{}".format(e))
    agents = {}
    for a in data.get("agents", []):
        wid = a.get("id")
        wdir = a.get("workspace_dir")
        if wid and wdir:
            agents[wid] = wdir
    return agents


def skill_info(cmd, agent_id, skill):
    """`qwenpaw skills info` 判定 skill 状态。

    返回 {"exists": bool, "enabled": bool, "path": str|None}。
    exists=False 表示 qwenpaw 未识别该 skill（exit 1 not found）。
    其它非 0 退出（qwenpaw 侧异常）抛 QwenpawError。
    """
    rc, out, err = run_qwenpaw(cmd, ["skills", "info", skill, "--agent-id", agent_id])
    if rc != 0:
        combined = err + out
        if "not found" in combined or "was not found" in combined:
            return {"exists": False, "enabled": False, "path": None}
        raise QwenpawError(
            "`qwenpaw skills info {}` 失败（exit={}）：{}".format(skill, rc, err.strip() or out.strip())
        )
    enabled = False
    path = None
    for line in out.splitlines():
        if line.startswith("Enabled:"):
            enabled = line.split(":", 1)[1].strip().lower() == "yes"
        elif line.startswith("Path:"):
            path = line.split(":", 1)[1].strip()
    return {"exists": True, "enabled": enabled, "path": path}


def discover_source_skills(source_dir):
    """扫描源目录，返回 {skill_name: skill_dir}。

    只收集含 SKILL.md 的子目录；源目录缺失或为空抛 UsageError。
    """
    if not os.path.isdir(source_dir):
        raise UsageError("源目录不存在：{}".format(source_dir))
    skills = {}
    for name in sorted(os.listdir(source_dir)):
        d = os.path.join(source_dir, name)
        if os.path.isdir(d) and os.path.isfile(os.path.join(d, "SKILL.md")):
            skills[name] = d
    if not skills:
        raise UsageError("源目录中没有含 SKILL.md 的 skill：{}".format(source_dir))
    return skills


def diff_files(src, dst):
    """目标存在且与源内容不一致时返回 True（用于报告，不覆盖）。"""
    if not os.path.exists(dst):
        return False
    return not filecmp.cmp(src, dst, shallow=False)


def content_has_degradation_block(content):
    """内容是否已含完整降级块（transform 产物形态：整块位于内容末尾）。

    只查标题子串会把「标题孤行 / 残缺块」误判为已装好（§5 #11 永不触发、
    §5 #12 跳过追加导致正文缺失）；这里要求内容以完整降级块结尾。
    """
    return content.rstrip("\n").endswith(DEGRADATION_BLOCK.rstrip("\n"))


def transform_skill_content(content):
    """安装期 transform（v2）：SKILL.md 末尾统一追加降级块。

    幂等：内容已以完整降级块结尾则原样返回（源或目标重复处理都安全，§5 #12）。
    """
    if content_has_degradation_block(content):
        return content
    return content.rstrip("\n") + "\n\n" + DEGRADATION_BLOCK


def has_degradation_block(md_path):
    """判断 SKILL.md 是否已含完整降级块（读取文件后走 content_has_degradation_block）。"""
    try:
        with open(md_path, encoding="utf-8") as f:
            return content_has_degradation_block(f.read())
    except OSError:
        return False


def skill_needs_install(dst_skill_md):
    """SKILL.md 缺失，或已安装但缺降级块 → 需要（重新）复制（§5 #11）。

    已含完整降级块视为「按 transform 基准已安装」；其余内容不一致不触发重装
    （已知限制，只报告不覆盖，§5 #10）。
    """
    if not os.path.isfile(dst_skill_md):
        return True
    return not has_degradation_block(dst_skill_md)


def copy_skill_files(skill_dir, dst_dir):
    """复制 SKILL.md（带 transform 追加降级块）与 README.md（原样）。

    只写目标目录，不改源目录（§3 约束 6）。
    """
    os.makedirs(dst_dir, exist_ok=True)
    for fn in SKILL_FILES:
        src_file = os.path.join(skill_dir, fn)
        if not os.path.isfile(src_file):
            continue
        dst_file = os.path.join(dst_dir, fn)
        if fn == "SKILL.md":
            with open(src_file, encoding="utf-8") as f:
                content = f.read()
            with open(dst_file, "w", encoding="utf-8") as f:
                f.write(transform_skill_content(content))
        else:
            shutil.copy2(src_file, dst_file)


def collect_diffs(skill_dir, workspace_dir, skill):
    """对比目标与「源 + transform」基准，返回不一致的文件名（不覆盖，§5 #10）。

    SKILL.md 的基准 = 源内容 + 降级块（transform 后预期内容）。
    """
    diffs = []
    for fn in SKILL_FILES:
        src_file = os.path.join(skill_dir, fn)
        dst_file = os.path.join(workspace_dir, "skills", skill, fn)
        if not os.path.isfile(src_file):
            continue
        if fn == "SKILL.md":
            with open(src_file, encoding="utf-8") as f:
                expected = transform_skill_content(f.read())
            if not os.path.isfile(dst_file):
                diffs.append(fn)
            else:
                with open(dst_file, encoding="utf-8") as f:
                    if f.read() != expected:
                        diffs.append(fn)
        elif diff_files(src_file, dst_file):
            diffs.append(fn)
    return diffs


def ensure_one_skill(cmd, agent_id, workspace_dir, skill, skill_dir, dry_run):
    """处理单个 skill，返回 {"status", "action", "message", "diffs"}。

    流程：SKILL.md 缺失或缺降级块先（重新）复制（带 transform）→ skills info
    判定 → 未启用则 skills enable。dry-run：不落盘，仅报告将执行的动作。
    """
    dst_dir = os.path.join(workspace_dir, "skills", skill)
    dst_skill_md = os.path.join(dst_dir, "SKILL.md")
    need_install = skill_needs_install(dst_skill_md)

    if dry_run:
        if need_install:
            if not os.path.isfile(dst_skill_md):
                kind = "copy+enable"
            else:
                # 升级场景（缺降级块）：查询启用态，输出与实际运行一致的动作
                try:
                    info = skill_info(cmd, agent_id, skill)
                    kind = "re-copy" if info["enabled"] else "re-copy+enable"
                except QwenpawError:
                    kind = "re-copy+enable"
            return {
                "status": STATUS_SKIPPED,
                "action": kind,
                "message": "would {} (dry-run)".format(kind),
                "diffs": [],
            }
        info = skill_info(cmd, agent_id, skill)
        if not info["exists"]:
            return {
                "status": STATUS_SKIPPED,
                "action": "none",
                "message": "磁盘存在但 qwenpaw 未识别（dry-run 不深究）",
                "diffs": collect_diffs(skill_dir, workspace_dir, skill),
            }
        diffs = collect_diffs(skill_dir, workspace_dir, skill)
        if info["enabled"]:
            return {
                "status": STATUS_OK,
                "action": "none",
                "message": "already enabled",
                "diffs": diffs,
            }
        return {
            "status": STATUS_SKIPPED,
            "action": "enable",
            "message": "would enable (dry-run)",
            "diffs": diffs,
        }

    actions = []
    if need_install:
        was_installed = os.path.isfile(dst_skill_md)
        copy_skill_files(skill_dir, dst_dir)
        actions.append("copy" if not was_installed else "re-copy")

    info = skill_info(cmd, agent_id, skill)
    if not info["exists"]:
        return {
            "status": STATUS_FAILED,
            "action": "+".join(actions),
            "message": "qwenpaw skills info 未识别该 skill（复制后仍未调和？）",
            "diffs": collect_diffs(skill_dir, workspace_dir, skill),
        }

    diffs = collect_diffs(skill_dir, workspace_dir, skill)

    if info["enabled"]:
        return {
            "status": STATUS_REPAIRED if actions else STATUS_OK,
            "action": "+".join(actions) or "none",
            "message": "already enabled",
            "diffs": diffs,
        }

    actions.append("enable")
    rc, out, err = run_qwenpaw(cmd, ["skills", "enable", skill, "--agent-id", agent_id])
    if rc != 0:
        return {
            "status": STATUS_FAILED,
            "action": "+".join(actions),
            "message": "enable 失败（exit={}）：{}".format(rc, err.strip() or out.strip()),
            "diffs": diffs,
        }
    return {
        "status": STATUS_REPAIRED,
        "action": "+".join(actions),
        "message": out.strip(),
        "diffs": diffs,
    }


def main(argv=None):
    args = parse_args(argv)

    try:
        cmd = build_qwenpaw_cmd(args.qwenpaw)
    except QwenpawError as e:
        print("ensure-wps-skills: 错误: {}".format(e), file=sys.stderr)
        return EXIT_USAGE

    try:
        agents = list_agents(cmd)
    except QwenpawError as e:
        print("ensure-wps-skills: 错误: {}".format(e), file=sys.stderr)
        return EXIT_CLI

    agent_id = args.agent_id
    if agent_id not in agents:
        print(
            "ensure-wps-skills: 错误: agent '{}' 不存在（不擅自创建 agent）。"
            "可用 agent: {}".format(agent_id, ", ".join(sorted(agents))),
            file=sys.stderr,
        )
        return EXIT_USAGE
    workspace_dir = agents[agent_id]

    try:
        skills = discover_source_skills(args.source_dir)
    except UsageError as e:
        print("ensure-wps-skills: 错误: {}".format(e), file=sys.stderr)
        return EXIT_USAGE

    results = {}
    for skill, skill_dir in skills.items():
        try:
            results[skill] = ensure_one_skill(
                cmd, agent_id, workspace_dir, skill, skill_dir, args.dry_run
            )
        except (QwenpawError, OSError) as e:
            results[skill] = {
                "status": STATUS_FAILED,
                "action": "",
                "message": str(e),
                "diffs": [],
            }

    summary = {
        "total": len(results),
        "ok": sum(1 for r in results.values() if r["status"] == STATUS_OK),
        "repaired": sum(1 for r in results.values() if r["status"] == STATUS_REPAIRED),
        "failed": sum(1 for r in results.values() if r["status"] == STATUS_FAILED),
        "skipped": sum(1 for r in results.values() if r["status"] == STATUS_SKIPPED),
    }
    all_ok = summary["failed"] == 0

    if args.json:
        print(json.dumps({
            "ok": all_ok,
            "exit_code": EXIT_OK if all_ok else (
                EXIT_FAIL if summary["ok"] == 0 and summary["repaired"] == 0 else EXIT_PARTIAL
            ),
            "agent_id": agent_id,
            "workspace_dir": workspace_dir,
            "source_dir": args.source_dir,
            "dry_run": args.dry_run,
            "skills": results,
            "summary": summary,
        }, ensure_ascii=False, indent=2))
    else:
        print("agent_id={} workspace={}".format(agent_id, workspace_dir))
        for skill, r in results.items():
            tag = r["status"]
            if r.get("diffs"):
                tag += " [内容不一致，未覆盖]"
            print("  {:<16} {:<9} {}".format(skill, tag, r.get("message", "")))
        print(
            "summary: total={total} ok={ok} repaired={repaired} "
            "failed={failed} skipped={skipped}".format(**summary)
        )
        if not args.dry_run:
            print("result: {}".format("ALL-OK" if all_ok else "FAILED"))

    if all_ok:
        return EXIT_OK
    if summary["ok"] == 0 and summary["repaired"] == 0:
        return EXIT_FAIL
    return EXIT_PARTIAL


if __name__ == "__main__":
    sys.exit(main())
