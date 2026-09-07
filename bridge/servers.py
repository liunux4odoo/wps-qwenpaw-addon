#!/usr/bin/env python3
"""
ACP server adapters — per-server 配置化描述（docs/plan-2026-09-05 §5）。

每个 adapter 回答五个问题（§5.1）：
  1. spawn：生成 ACP server 的启动命令（argv）
  2. agent 发现：如何枚举可用 agents（无 agent 概念的 server 返回空列表）
  3. agent 切换：切换语义（restart=kill+重启子进程 / config_option=记录选择，前端应用）
  4. 能力标志：V2/V4/V5/V6/V7/V8 实测结果（供 Phase 2 前端按标志适配）
  5. 握手策略：initialize 是否/如何发送（V10 实测 opencode 无需握手，D9）

bridge 保持纯传输（§6.1 铁律）：adapter 只提供"如何 spawn/发现/切换/声明"的
配置化描述，不实现 ACP 业务逻辑。进程生命周期（重启退避/就绪/上行排队）留在
bridge（任何 server 都需要），qwenpaw 专属发现逻辑原样搬入本文件（行为不变）。

能力标志约定（Phase 2 前端消费）：
  honorMcpEnv     bool    V2：是否 honor mcpServers[].env（路线 P 多窗口隔离前提）
  approval        str     C5：auto=自动批准(allow_once) / none=无审批环节 / manual=需手动确认
  thoughtHeartbeat bool   C6：是否下发 agent_thought_chunk（看门狗续命信号）
  loadSession     bool    C7：session/load 是否支持历史恢复
  cancel          bool    C8：是否支持 session/cancel（中止语义）
  agents          bool    是否有"agent/mode"概念（枚举与切换）
  switchSemantics str     agent/mode 切换语义：restart=kill+重启子进程（qwenpaw）/ config_option=会话级
                          set_config_option（opencode，V11：configOptions 只读，新建会话默认仍 build）
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import sys

log = logging.getLogger("acp-bridge")

AGENT_LIST_TIMEOUT = 30.0  # agent 发现 CLI 子进程超时（qwenpaw 冷启动约 8s，给足余量）


class AcpServerAdapter:
    """ACP server adapter 基类：配置化描述。子类覆盖 spawn/发现/切换/能力声明。"""

    name = "base"
    default_agent = "default"          # 切换到此 server 时 bridge agent 复位值（Phase 3 /server/set）
    switch_semantics = "restart"      # "restart" | "config_option"
    handshake_required = False        # initialize 是否必须（V10：opencode/qwenpaw 均无需）
    protocol_version: object = "2025-03-26"  # qwenpaw 用字符串；opencode 用整数 1
    capabilities: dict = {}

    def __init__(self, bridge):
        self.bridge = bridge

    def spawn_cmd(self) -> list[str]:
        raise NotImplementedError

    async def fetch_agents(self) -> list[dict]:
        """枚举可用 agents（[{id,name,description}]）。失败/无概念返回 []（不抛异常）。"""
        return []

    async def switch_agent(self, agent_id: str) -> tuple[bool, str, bool]:
        """校验并记录 agent 选择。

        返回 (ok, err, need_restart)。need_restart=True 时 bridge 按 restart 语义
        重启 ACP 子进程（新 agent 由 spawn_cmd 读取 bridge.agent）。"""
        if not agent_id:
            return False, "agent 为空", False
        if agent_id == self.bridge.agent:
            return True, "已是指定 agent", False
        known = await self.bridge.list_agents()
        if known and not any(a["id"] == agent_id for a in known):
            return False, f"未知 agent: {agent_id}", False
        self.bridge.agent = agent_id
        return True, "", False


class QwenpawAdapter(AcpServerAdapter):
    """qwenpaw：现状行为原样迁移（零回归）。switch = kill + 重启子进程。"""

    name = "qwenpaw"
    switch_semantics = "restart"
    protocol_version = "2025-03-26"
    capabilities = {
        "honorMcpEnv": True,       # V2 ✅ 实测透传 env
        "approval": "auto",        # C5 自动批准（allow_once）
        "thoughtHeartbeat": True,  # C6 密集下发 agent_thought_chunk 续命
        "loadSession": True,       # C7 ✅
        "cancel": True,            # C8 ✅ 支持 session/cancel
        "agents": True,            # 命名 agent 概念（agent list / switch_agent）
        "switchSemantics": "restart",  # C3 切换 = kill + 重启子进程
    }

    def _bin(self) -> str:
        """解析 qwenpaw 可执行文件路径（PATH 优先，回退当前 Python 解释器同目录）。

        未安装时抛 FileNotFoundError（含安装提示），不静默回退裸命令名。
        """
        found = shutil.which("qwenpaw")
        if found:
            return found
        here = os.path.join(os.path.dirname(sys.executable), "qwenpaw")
        if os.path.exists(here) and os.access(here, os.X_OK):
            return here
        raise FileNotFoundError(
            "未找到可执行的 qwenpaw（当前 ACP server=qwenpaw）。"
            "请先安装 qwenpaw 并确保其可执行文件在 PATH 中（或位于当前 Python 解释器同目录）。")

    def spawn_cmd(self) -> list[str]:
        return [self._bin(), "acp", "--agent", self.bridge.agent]

    async def fetch_agents(self) -> list[dict]:
        """实际查询 agent 列表：优先 qwenpaw daemon 的 HTTP API（快），失败回退 CLI 子进程。"""
        base = self._daemon_base_url()
        if base:
            try:
                agents = await asyncio.to_thread(self._http_get_json, base + "/api/agents")
                if agents:
                    return self._normalize_agents(agents.get("agents") or [])
            except Exception as e:
                log.info("agent 列表 daemon API 不可用（%s），回退 qwenpaw agent list", e)
        try:
            proc = await asyncio.create_subprocess_exec(
                self._bin(), "agent", "list",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=dict(os.environ, PYTHONUNBUFFERED="1"),
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=AGENT_LIST_TIMEOUT)
            obj = json.loads(stdout.decode("utf-8", "replace"))
            return self._normalize_agents(obj.get("agents") or [])
        except Exception as e:
            log.warning("qwenpaw list_agents 失败: %s", e)
            return []

    @staticmethod
    def _normalize_agents(agents: list) -> list[dict]:
        out = []
        for a in agents:
            if not isinstance(a, dict):
                continue
            if not a.get("id"):
                continue
            out.append({
                "id": str(a["id"]),
                "name": str(a.get("name") or a["id"]),
                "description": str(a.get("description") or ""),
            })
        return out

    @staticmethod
    def _http_get_json(url: str, timeout: float = 3.0) -> dict | None:
        """同步 GET 一个 JSON 端点（在 to_thread 中调用）。失败返回 None。"""
        try:
            import urllib.request
            req = urllib.request.Request(url, headers={"User-Agent": "acp-bridge"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception:
            return None

    def _daemon_base_url(self) -> str | None:
        """解析 qwenpaw daemon 地址（config.json last_api.host:port），解析失败返回 None。"""
        try:
            working = os.environ.get("QWENPAW_WORKING_DIR", "")
            if not working:
                return None
            cfg_path = os.path.join(working, "config.json")
            if not os.path.exists(cfg_path):
                return None
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            api = cfg.get("last_api") or {}
            host = api.get("host") or "127.0.0.1"
            port = api.get("port")
            if not port:
                return None
            return f"http://{host}:{port}"
        except Exception:
            return None

    async def switch_agent(self, agent_id: str) -> tuple[bool, str, bool]:
        """qwenpaw：校验 + 记录 + 需要重启（bridge 执行 kill+重启）。"""
        if not agent_id:
            return False, "agent 为空", False
        if agent_id == self.bridge.agent:
            return True, "已是指定 agent", False
        known = await self.bridge.list_agents()
        if known and not any(a["id"] == agent_id for a in known):
            return False, f"未知 agent: {agent_id}", False
        log.info("switching agent: %s -> %s", self.bridge.agent, agent_id)
        self.bridge.agent = agent_id
        return True, "", True


class OpencodeAdapter(AcpServerAdapter):
    """opencode（第一实施目标，D6）：spawn `opencode acp`；agent 语义 = mode/自定义 agent（V8）。

    V11 实测：configOptions 数组只读不生效；mode 切换只能 session/set_config_option（会话级）。
    → switch_semantics=config_option：bridge 仅记录选择，不重启进程；应用由 Phase 2/3 前端
      set_config_option 完成（新建会话默认仍 build，会话级不跨会话持久）。
    """

    name = "opencode"
    default_agent = "build"           # opencode 默认 mode（V8：build primary）；切换到此 server 时复位
    switch_semantics = "config_option"
    protocol_version = 1            # V1 实测整数 1（u16）
    capabilities = {
        "honorMcpEnv": True,        # V2 ✅ 实测透传 env
        "approval": "none",         # V4 默认无审批（build 权限 * allow）；改 ask 才发审批
        "thoughtHeartbeat": False,  # V5 不发 thought chunk → 看门狗需任意下行续命（Phase 2 C6）
        "loadSession": True,        # V6 ✅ 支持历史恢复
        "cancel": False,            # V7 不支持 session/cancel → 中止走 session/close（D8）
        "agents": True,             # V8 有 mode/自定义 agent 概念（agent list）
        "switchSemantics": "config_option",  # V11 会话级 set_config_option 应用（前端 Phase 2）
    }

    def _bin(self) -> str:
        """解析 opencode 可执行文件路径（OPENCODE_BIN 环境变量 > PATH）。

        假定运行环境已安装 opencode：不预设任何本机安装路径。
        未安装时抛 FileNotFoundError（含安装提示），让 bridge 启动时明确报错。
        """
        env = os.environ.get("OPENCODE_BIN")
        if env:
            return env
        found = shutil.which("opencode")
        if found:
            return found
        raise FileNotFoundError(
            "未找到可执行的 opencode（当前 ACP server=opencode）。"
            "请先安装 opencode 并确保其可执行文件在 PATH 中（或用 OPENCODE_BIN 环境变量指定路径）。")

    def spawn_cmd(self) -> list[str]:
        # V1：无 --agent 参数；--cwd 为进程默认工作目录（session/new 的 cwd 由前端按文档目录传入，V3 ✅）
        return [self._bin(), "acp", "--cwd", os.getcwd()]

    async def fetch_agents(self) -> list[dict]:
        """opencode agent list → 解析行首无缩进的 `<name> (primary|subagent)` 条目。

        语义 ≠ qwenpaw 命名 agent：这是 mode（build/plan）与自定义 agent（wps-word 等）的枚举。
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                self._bin(), "agent", "list",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=dict(os.environ, PYTHONUNBUFFERED="1"),
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=AGENT_LIST_TIMEOUT)
            out = []
            for line in stdout.decode("utf-8", "replace").splitlines():
                m = re.match(r"^(\S+)\s+\((primary|subagent)\)", line)
                if m:
                    agent_id = m.group(1)
                    kind = m.group(2)
                    out.append({
                        "id": agent_id,
                        "name": agent_id,
                        "description": f"opencode {kind} agent/mode",
                    })
            return out
        except Exception as e:
            log.warning("opencode agent list 失败: %s", e)
            return []

    async def switch_agent(self, agent_id: str) -> tuple[bool, str, bool]:
        """opencode：记录 mode/agent 选择，不重启进程（V11：mode 切换会话级，前端 set_config_option 应用）。"""
        if not agent_id:
            return False, "agent 为空", False
        if agent_id == self.bridge.agent:
            return True, "已是指定 agent", False
        known = await self.bridge.list_agents()
        if known and not any(a["id"] == agent_id for a in known):
            return False, f"未知 agent: {agent_id}", False
        log.info("opencode mode 记录选择: %s -> %s（会话级切换由前端 set_config_option 应用，Phase 2/3）",
                 self.bridge.agent, agent_id)
        self.bridge.agent = agent_id
        return True, "", False


_ADAPTERS: dict[str, type[AcpServerAdapter]] = {
    "qwenpaw": QwenpawAdapter,
    "opencode": OpencodeAdapter,
}


def get_adapter(name: str, bridge) -> AcpServerAdapter:
    """按名称加载 adapter（未知名称回退 qwenpaw 并告警）。"""
    cls = _ADAPTERS.get(name)
    if cls is None:
        log.warning("未知 ACP server adapter: %s，回退 qwenpaw", name)
        cls = QwenpawAdapter
    return cls(bridge)


def list_adapters() -> list[dict]:
    """可用 server 列表（Phase 3 /servers 端点）：name + 能力标志 + defaultAgent + 说明。"""
    out = []
    for cls in _ADAPTERS.values():
        caps = dict(cls.capabilities)
        out.append({
            "name": cls.name,
            "defaultAgent": cls.default_agent,
            "switchSemantics": cls.switch_semantics,
            "capabilities": caps,
            "description": _ADAPTER_DESCRIPTION.get(cls.name, cls.name),
        })
    return out


_ADAPTER_DESCRIPTION: dict[str, str] = {
    "qwenpaw": "QwenPaw（默认）：自动批准工具、支持中止/历史恢复，agent 切换重启后端",
    "opencode": "opencode：无审批环节、中止=结束会话重建、模型/mode 会话级配置（set_config_option）",
}
