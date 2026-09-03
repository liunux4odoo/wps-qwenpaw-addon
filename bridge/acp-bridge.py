#!/usr/bin/env python3
"""
acp-bridge — WebSocket/HTTP ↔ stdio 双向转发桥，连接 WPS 加载项与 `qwenpaw acp`。

定位（ARCHITECTURE §3.4 / §8.2）：
  - 纯传输层转发：不解析 ACP 消息内容、不修改消息结构、不新增字段
  - 解决"WPS 加载项只能走 HTTP/WebSocket，但 qwenpaw acp 只有 stdio"的传输断层

传输前端（阶段 1 实测修正）：
  - WPS Linux 沙箱 **只放行 HTTP，拦截 WebSocket**（实测：:58891 HTTP fetch 通，:8765 ws 不通）。
    因此加载项侧走 **HTTP 短轮询**（与 wps-office-mcp :58891 同机制）；WebSocket 前端保留供
    非 WPS 场景/调试使用。两者共享同一 qwenpaw acp 子进程与下行路由表。

HTTP 端点（加载项侧 acp-client.js 使用）：
  - GET  /status                    -> {"status":"running","agent":...,"ports":{...}}
  - POST /acp/send?clientId=X       body=NDJSON ACP 请求（一行一条 JSON-RPC）-> 写 qwenpaw stdin
  - GET  /acp/poll?clientId=X       -> 该 clientId 的待下行 ACP 消息（JSONL，每行一条）
  - GET  /ui/*                      -> 加载项 UI 静态文件（CreateTaskPane 经此加载 taskpane.html，
                                       与 ACP 轮询同源，无 CORS 问题；根目录为插件仓库根，可 --ui-root 覆盖）
  - POST /debug/log                 -> 接收加载项侧调试日志（body={"tag","msg"}），统一落盘到 bridge 日志

poll 端口集中分配（路线 P，ARCHITECTURE §13）：
  - POST /poll-port/allocate?clientId=X   -> 分配唯一 WPS_POLL_PORT（59000+ 段），返回 {"port":N}
  - GET  /poll-port?clientId=X            -> 查询已分配端口，返回 {"port":N|null}
  - POST /poll-port/release?clientId=X    -> 释放该 client 的端口（session/close 时 bridge 也会自动回收）
  加载项在 session/new 前先 allocate 拿端口，把它填入 mcpServers 的 env.WPS_POLL_PORT；
  bridge 也会在 session/new 转发时强制注入该 client 的分配端口（权威值），保证唯一、防串台。

WebSocket 端点：ws://127.0.0.1:8765（上行原样转发；下行按 sessionId/请求 id 路由）

Wire 协议（阶段 0.5 实测，ACP v0.12.2）：
  - 帧格式：NDJSON（每行一条紧凑 JSON-RPC 2.0，json.dumps(separators=(",",":")) + "\\n"）
  - 流式下行：session/update 通知（无 id，带 sessionId），update.sessionUpdate=agent_message_chunk

用法：
  python acp-bridge.py [--port 8765] [--http-port 8766] [--agent default] [--host 127.0.0.1]
                       [--ui-root <插件仓库根>] [--wps-mcp-entry <dist/index.js 绝对路径>]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shutil
import sys
import time
from collections import deque
from urllib.parse import unquote

import websockets
from websockets.asyncio.server import ServerConnection, serve

log = logging.getLogger("acp-bridge")

MAX_POLL_BATCH = 200

# ── 路线 P：poll 端口集中分配段（避开 :8766/:8765/:58891） ──────────
POLL_PORT_START = 59000
POLL_PORT_END = 59999
# 端口释放后到可复用前的宽限期：残留 wps-mcp 进程可能仍占端口，立即复用会 EADDRINUSE。
# 正常 session/close 链路 qwenpaw 2s 内清进程；异常残留需时间自然释放，取 60s 防碰撞。
POLL_PORT_REUSE_GRACE = 60.0
# 并发分配上限：远超真实多窗口规模（几十个以内），防止任意 clientId 把整段端口耗尽。
POLL_PORT_POOL_CAP = 64
# 端口租期：client 超过该时长无任何 ACP 流量则视为失联，分配时回收其端口（防泄漏）。
POLL_PORT_LEASE = 3600.0

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


class AcpBridge:
    def __init__(self, port: int = 8765, http_port: int = 8766, agent: str = "default", host: str = "127.0.0.1",
                 ui_root: str | None = None, log_file: str | None = None, wps_mcp_entry: str | None = None):
        self.port = port
        self.http_port = http_port
        self.agent = agent
        self.host = host
        # 静态文件根目录（加载项 UI 文件，/ui/* 映射）：默认插件仓库根（bridge/ 的上一级）
        self.ui_root = ui_root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        # wps-office-mcp 入口（dist/index.js）：依赖 opencode-wps 作为 submodule 固定在
        # <仓库根>/third_party/opencode-wps/wps-office-mcp/，故默认路径可确定；可 --wps-mcp-entry 覆盖。
        self.wps_mcp_entry = (wps_mcp_entry
                              or os.path.join(self.ui_root, "third_party", "opencode-wps",
                                              "wps-office-mcp", "dist", "index.js"))
        # 调试日志文件（None = 只写 stdout）
        self.log_file = log_file
        # 连接集与路由表
        self.ws_conns: set[ServerConnection] = set()
        self.ws_session_conns: dict[str, ServerConnection] = {}
        self.ws_pending: dict[object, ServerConnection] = {}
        # HTTP 客户端（clientId -> 下行队列 deque[str]）
        self.http_clients: dict[str, deque] = {}
        self.http_session_client: dict[str, str] = {}
        # 请求 id 归属队列（多窗口同 id 靠转发顺序去重，见 _pop_request_owner）
        self._request_queue: deque[tuple[object, str]] = deque()
        # 路线 P：集中分配 poll 端口（59000+ 段，poll port ↔ session id 映射）
        self._port_allocated: dict[str, int] = {}     # client_id -> port
        self._port_used: set[int] = set()             # 当前占用端口（O(1) 判占用）
        self._port_last_seen: dict[str, float] = {}   # client_id -> 最近活动时间（租期）
        self._session_port: dict[str, int] = {}       # session_id -> port
        self._port_released_at: dict[int, float] = {} # port -> 释放时间戳（宽限期防碰撞）
        self._next_port = POLL_PORT_START
        # 子进程
        self.proc: asyncio.subprocess.Process | None = None
        self._restart_delay = 1.0

    # ── 调试日志 ────────────────────────────────────────────────────
    @staticmethod
    def _summarize_acp(raw: str) -> str:
        """提取 ACP 消息的关键信息用于日志（不展开长文本/大 payload）。"""
        try:
            msg = json.loads(raw)
            parts = []
            mid = msg.get("id")
            if mid is not None:
                parts.append(f"id={mid}")
            if msg.get("method"):
                parts.append(f"method={msg['method']}")
            params = msg.get("params") or {}
            sid = params.get("sessionId")
            if sid:
                parts.append(f"sid={sid}")
            if msg.get("method") == "session/prompt":
                prompt = params.get("prompt") or []
                text = ""
                if isinstance(prompt, list):
                    for item in prompt:
                        if isinstance(item, dict) and item.get("text"):
                            text += str(item["text"])
                elif isinstance(prompt, str):
                    text = prompt
                parts.append(f"prompt={text[:200]!r}")
            if msg.get("method") == "session/update":
                upd = params.get("update") or {}
                if upd.get("sessionUpdate") == "agent_message_chunk":
                    t = (upd.get("content") or {}).get("text") or ""
                    parts.append(f"chunk={t[:120]!r}")
                else:
                    parts.append(f"update={upd.get('sessionUpdate')}")
            if msg.get("method") == "session/request_permission":
                tc = params.get("toolCall") or {}
                parts.append(f"tool={tc.get('title') or tc.get('tool_call_id') or ''}")
                parts.append(f"options={[o.get('optionId') for o in (params.get('options') or [])]}")
            if "result" in msg:
                parts.append("result")
            if "error" in msg:
                err = msg.get("error") or {}
                parts.append(f"error={err.get('message', '')[:120]!r}")
            return " ".join(parts)
        except Exception:
            return raw[:200]

    async def _log_debug(self, body: bytes) -> None:
        """接收加载项 JS 侧上报的调试日志，写入 bridge 日志。"""
        try:
            obj = json.loads(body.decode("utf-8", "replace"))
            tag = str(obj.get("tag", "js"))
            msg = str(obj.get("msg", ""))
            log.info("[js:%s] %s", tag, msg)
        except Exception:
            log.info("[js:raw] %s", body.decode("utf-8", "replace")[:500])

    # ── 路线 P：集中分配 poll 端口 ──────────────────────────────────
    def _touch_client(self, client_id: str) -> None:
        """记录 client 最近活动时间（租期用）。"""
        if client_id:
            self._port_last_seen[client_id] = time.time()

    def _grant_port(self, client_id: str, port: int) -> int:
        self._port_allocated[client_id] = port
        self._port_used.add(port)
        self._port_released_at.pop(port, None)
        self._touch_client(client_id)
        log.info("poll port %d allocated -> client %s", port, client_id)
        return port

    def _reclaim_stale(self) -> None:
        """回收超过租期仍无活动的 client 端口（失联/异常退出防泄漏）。"""
        now = time.time()
        for cid, last in list(self._port_last_seen.items()):
            if now - last > POLL_PORT_LEASE:
                self._release_port(cid)

    def _allocate_port(self, client_id: str) -> int | None:
        """为 client 分配唯一 poll 端口（幂等：已分配则返回原端口）。"""
        if client_id in self._port_allocated:
            return self._port_allocated[client_id]
        # 池上限防护（先回收失联租期，再判满）
        if len(self._port_allocated) >= POLL_PORT_POOL_CAP:
            self._reclaim_stale()
            if len(self._port_allocated) >= POLL_PORT_POOL_CAP:
                log.error("poll port pool exhausted (cap %d)", POLL_PORT_POOL_CAP)
                return None
        now = time.time()
        # pass 1：从游标起找「未占用且不在宽限期」的端口
        for _ in range(POLL_PORT_END - POLL_PORT_START + 1):
            port = self._next_port
            self._next_port += 1
            if self._next_port > POLL_PORT_END:
                self._next_port = POLL_PORT_START
            if port in self._port_used:
                continue
            released = self._port_released_at.get(port)
            if released is not None and (now - released) < POLL_PORT_REUSE_GRACE:
                continue
            return self._grant_port(client_id, port)
        # pass 2：整段都被宽限期占住 -> 复用最旧的释放端口（残留风险最低的兜底）
        if self._port_released_at:
            port = min(self._port_released_at, key=self._port_released_at.get)
            if port not in self._port_used:
                return self._grant_port(client_id, port)
        log.error("no free poll port in %d-%d", POLL_PORT_START, POLL_PORT_END)
        return None

    def _release_port(self, client_id: str) -> None:
        """释放 client 的端口（session/close 或显式 release 时调用）。"""
        port = self._port_allocated.pop(client_id, None)
        if port is None:
            return
        self._port_used.discard(port)
        self._port_released_at[port] = time.time()
        self._port_last_seen.pop(client_id, None)
        for sid, p in list(self._session_port.items()):
            if p == port:
                del self._session_port[sid]
        log.info("poll port %d released (client %s)", port, client_id)

    def _inject_poll_port(self, raw: str, client_id: str | None) -> str:
        """路线 P：session/new / session/load 转发前，把 wps mcpServer 的 env.WPS_POLL_PORT
        设为该 client 的分配端口（权威值，覆盖加载项自带值，保证唯一防串台）。
        返回（可能被修改的）raw。ACP schema：env 是 [{name,value}] 列表。"""
        if not client_id:
            return raw
        try:
            msg = json.loads(raw)
        except Exception:
            return raw
        if not isinstance(msg, dict):
            return raw  # 非对象 JSON（列表/字符串/数字）：不注入，原样透传
        method = msg.get("method")
        if method not in ("session/new", "session/load"):
            return raw
        params = msg.get("params") or {}
        servers = params.get("mcpServers")
        if not isinstance(servers, list):
            return raw
        modified = False
        for server in servers:
            if not isinstance(server, dict):
                continue
            name = str(server.get("name", ""))
            if name != "wps" and "wps" not in name.lower():
                continue
            if server.get("command") is None:
                continue  # 非 stdio（http/sse）不注入，也不占用端口
            # 只有确认要注入 wps stdio server 时才分配端口（避免 http 型 session 白白占端口）
            port = self._port_allocated.get(client_id)
            if port is None:
                port = self._allocate_port(client_id)
            if port is None:
                return raw
            self._touch_client(client_id)
            env = server.get("env")
            if not isinstance(env, list):
                env = []
                server["env"] = env
            found = False
            for item in env:
                if isinstance(item, dict) and item.get("name") == "WPS_POLL_PORT":
                    item["value"] = str(port)
                    found = True
                    break
            if not found:
                env.append({"name": "WPS_POLL_PORT", "value": str(port)})
            modified = True
            sid = params.get("sessionId")
            if sid:
                self._session_port[str(sid)] = port
            break
        if modified:
            return json.dumps(msg, ensure_ascii=False, separators=(",", ":"))
        return raw

    # ── qwenpaw acp 子进程 ──────────────────────────────────────────
    def _qwenpaw_bin(self) -> str:
        found = shutil.which("qwenpaw")
        if found:
            return found
        here = os.path.join(os.path.dirname(sys.executable), "qwenpaw")
        if os.path.exists(here):
            return here
        return "qwenpaw"

    async def start_proc(self) -> None:
        cmd = [self._qwenpaw_bin(), "acp", "--agent", self.agent]
        log.info("spawning qwenpaw acp: %s", " ".join(cmd))
        self.proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(os.environ, PYTHONUNBUFFERED="1"),
        )
        asyncio.create_task(self._stdout_reader())
        asyncio.create_task(self._stderr_reader())
        asyncio.create_task(self._wait_proc())

    async def _stdout_reader(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                log.info("qwenpaw acp stdout EOF")
                break
            text = line.decode("utf-8", "replace").rstrip("\n")
            if text:
                await self._route_down(text)

    async def _stderr_reader(self) -> None:
        assert self.proc and self.proc.stderr
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                break
            log.debug("qwenpaw stderr: %s", line.decode("utf-8", "replace").rstrip("\n"))

    async def _wait_proc(self) -> None:
        assert self.proc
        rc = await self.proc.wait()
        log.error("qwenpaw acp exited rc=%s, restarting in %.1fs", rc, self._restart_delay)
        self.proc = None
        await asyncio.sleep(self._restart_delay)
        self._restart_delay = min(self._restart_delay * 2, 30.0)
        try:
            await self.start_proc()
        except Exception:
            log.exception("failed to restart qwenpaw acp")

    # ── 下行路由（stdio -> 前端） ──────────────────────────────────
    def _pop_request_owner(self, rid: object) -> str | None:
        """按转发顺序从请求队列弹出该 id 的归属 client。

        每个窗口的 ACP 请求 id 都从 1 递增（js/acp-client.js `var id = ++seq`），
        多窗口并发必然出现同 id 请求。qwenpaw 顺序处理 stdin、按请求顺序回响应，
        因此这里用全局 FIFO 队列按顺序去重：谁先发该 id，响应就归谁。"""
        while self._request_queue:
            q_rid, cid = self._request_queue.popleft()
            if q_rid == rid:
                return cid
            log.warning("request id %r response arrived but queue head was %r (order mismatch)",
                        rid, q_rid)
        return None

    async def _route_down(self, text: str) -> None:
        """把 qwenpaw stdout 的一条 ACP 消息路由到对应前端。
        优先 HTTP 客户端（WPS 实际使用的），其次 WebSocket。"""
        log.debug("downstream: %s", self._summarize_acp(text))
        target = None
        sid = None
        try:
            msg = json.loads(text)
            params = msg.get("params")
            if isinstance(params, dict) and params.get("sessionId"):
                sid = str(params["sessionId"])
            elif "id" in msg and ("result" in msg or "error" in msg):
                # 响应（无 params.sessionId）：按转发顺序取归属（多窗口同 id 去重）
                target = self._pop_request_owner(msg["id"])
            # 路线 P：session/new 响应带 result.sessionId -> 记录 session_id -> poll port
            if isinstance(msg.get("result"), dict):
                rid_sid = msg["result"].get("sessionId")
                if rid_sid and target:
                    if target in self._port_allocated:
                        self._session_port[str(rid_sid)] = self._port_allocated[target]
        except Exception:
            target = None

        if sid:
            cid = self.http_session_client.get(sid)
            if cid and cid in self.http_clients:
                self.http_clients[cid].append(text)
                return
            wconn = self.ws_session_conns.get(sid)
            if wconn:
                try:
                    await wconn.send(text)
                except Exception:
                    self.ws_conns.discard(wconn)
                return
            # 未知会话：广播到所有 HTTP 客户端
            for cid in list(self.http_clients):
                self.http_clients[cid].append(text)
            return

        if target is not None:
            if target in self.http_clients:
                self.http_clients[target].append(text)
                return
            wconn = self.ws_pending.pop(msg["id"], None) if False else None
            for c in list(self.ws_pending.values()):
                if c:
                    pass
            # WebSocket 路由：遍历找 id 匹配
            wconn = self.ws_pending.get(msg["id"])
            if wconn:
                try:
                    await wconn.send(text)
                except Exception:
                    self.ws_conns.discard(wconn)
                return

        # 其余（广播类）：发给所有 HTTP + WS 客户端
        for cid in list(self.http_clients):
            self.http_clients[cid].append(text)
        for c in list(self.ws_conns):
            try:
                await c.send(text)
            except Exception:
                self.ws_conns.discard(c)

    # ── 上行写入（前端 -> stdio） ──────────────────────────────────
    async def _write_stdin(self, raw: str, client_id: str | None = None) -> bool:
        if not self.proc or not self.proc.stdin or self.proc.stdin.is_closing():
            log.error("qwenpaw acp stdin unavailable, dropping message")
            return False
        # 路线 P：session/new 注入 WPS_POLL_PORT；session/close 回收端口
        raw = self._inject_poll_port(raw, client_id)
        log.info("upstream[%s]: %s", client_id or "ws", self._summarize_acp(raw))
        # 记录请求归属（多窗口同 id 靠转发顺序去重，见 _pop_request_owner）
        try:
            msg = json.loads(raw)
            rid = msg.get("id")
            if rid is not None and client_id and msg.get("method"):
                # 只登记「客户端发起的请求」（带 method）；respond（id+result，无 method）
                # 是对 qwenpaw 下行请求的应答，qwenpaw 不会回响应，不入队。
                self._request_queue.append((rid, client_id))
            params = msg.get("params")
            if isinstance(params, dict) and params.get("sessionId"):
                sid = str(params["sessionId"])
                if client_id:
                    self.http_session_client[sid] = client_id
                    self._touch_client(client_id)
                    if msg.get("method") == "session/close":
                        self._release_port(client_id)
        except Exception:
            pass
        payload = raw.rstrip("\n") + "\n"
        self.proc.stdin.write(payload.encode("utf-8"))
        await self.proc.stdin.drain()
        return True

    # ── WebSocket 前端 ─────────────────────────────────────────────
    async def _ws_handler(self, conn: ServerConnection) -> None:
        self.ws_conns.add(conn)
        log.info("ws client connected (%d active)", len(self.ws_conns))
        try:
            async for raw in conn:
                try:
                    msg = json.loads(raw)
                    rid = msg.get("id")
                    if rid is not None:
                        self.ws_pending[rid] = conn
                    params = msg.get("params")
                    if isinstance(params, dict) and params.get("sessionId"):
                        self.ws_session_conns[str(params["sessionId"])] = conn
                except Exception:
                    pass
                await self._write_stdin(raw)
        except websockets.ConnectionClosed:
            pass
        finally:
            self.ws_conns.discard(conn)
            for sid, c in list(self.ws_session_conns.items()):
                if c is conn:
                    del self.ws_session_conns[sid]
            for rid, c in list(self.ws_pending.items()):
                if c is conn:
                    del self.ws_pending[rid]
            log.info("ws client disconnected (%d active)", len(self.ws_conns))

    # ── HTTP 前端（WPS 加载项实际使用） ─────────────────────────────
    async def _http_handler(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), 10)
            if not request_line:
                writer.close()
                return
            parts = request_line.decode("utf-8", "replace").strip().split(" ")
            if len(parts) < 3:
                writer.close()
                return
            method, path_q = parts[0], parts[1]
            path, _, query = path_q.partition("?")
            # 读 headers 到空行
            content_length = 0
            while True:
                line = await asyncio.wait_for(reader.readline(), 10)
                if line in (b"\r\n", b"\n", b""):
                    break
                low = line.decode("utf-8", "replace").lower()
                if low.startswith("content-length:"):
                    try:
                        content_length = int(low.split(":", 1)[1].strip())
                    except ValueError:
                        pass
            body = b""
            if content_length > 0:
                body = await asyncio.wait_for(reader.readexactly(content_length), 10)

            query_params = {}
            if query:
                for kv in query.split("&"):
                    if "=" in kv:
                        k, v = kv.split("=", 1)
                        query_params[k] = v

            client_id = query_params.get("clientId", "default")
            log.info("http %s %s (client=%s)", method, path, client_id)

            if path == "/status":
                payload = {
                    "status": "running",
                    "agent": self.agent,
                    "proc": self.proc.pid if self.proc else None,
                }
                # 端口/session 映射只在 ?debug=1 时暴露（默认脱敏，防跨源读取内部路由状态）
                if query_params.get("debug") == "1":
                    payload["ports"] = dict(self._port_allocated)
                    payload["session_ports"] = dict(self._session_port)
                await self._http_json(writer, 200, payload)
            elif path == "/config":
                # 加载项侧确定性配置：wps-office-mcp 入口由 bridge 依据仓库根解析，
                # 不依赖客户端机器上的硬编码绝对路径（submodule 固定后可确定）。
                await self._http_json(writer, 200, {
                    "wpsMcpEntry": self.wps_mcp_entry,
                    "pollPortStart": POLL_PORT_START,
                    "pollPortEnd": POLL_PORT_END,
                })
            elif path == "/poll-port/allocate" and method == "POST":
                port = self._allocate_port(client_id)
                if port is not None:
                    self._touch_client(client_id)
                await self._http_json(writer, 200 if port else 503,
                                      {"port": port, "clientId": client_id} if port
                                      else {"error": "no free poll port"})
            elif path == "/poll-port" and method == "GET":
                self._touch_client(client_id)
                await self._http_json(writer, 200, {"port": self._port_allocated.get(client_id),
                                                    "clientId": client_id})
            elif path == "/poll-port/release" and method == "POST":
                self._release_port(client_id)
                await self._http_json(writer, 200, {"ok": True})
            elif method == "OPTIONS":
                # CORS 预检：WPS taskpane 是 file:// 页面，跨源 XHR 必须放行
                writer.write(b"HTTP/1.1 204 No Content\r\n")
                writer.write(b"Access-Control-Allow-Origin: *\r\n")
                writer.write(b"Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
                writer.write(b"Access-Control-Allow-Headers: Content-Type\r\n")
                writer.write(b"Content-Length: 0\r\n\r\n")
                await writer.drain()
            elif path == "/debug/log" and method == "POST":
                await self._log_debug(body)
                await self._http_json(writer, 200, {"ok": True})
            elif path == "/acp/send" and method == "POST":
                if client_id not in self.http_clients:
                    self.http_clients[client_id] = deque()
                text = body.decode("utf-8", "replace")
                for line in text.splitlines():
                    if line.strip():
                        await self._write_stdin(line, client_id)
                await self._http_json(writer, 200, {"ok": True, "sent": len(text.splitlines())})
            elif path == "/acp/poll" and method == "GET":
                q = self.http_clients.setdefault(client_id, deque())
                batch = []
                while q and len(batch) < MAX_POLL_BATCH:
                    batch.append(q.popleft())
                # 返回 JSONL（每行一条 ACP 消息）
                if batch:
                    log.info("http poll[%s] -> %d msg(s)", client_id, len(batch))
                resp_body = "\n".join(batch)
                writer.write(b"HTTP/1.1 200 OK\r\n")
                writer.write(b"Content-Type: application/json\r\n")
                writer.write(b"Access-Control-Allow-Origin: *\r\n")
                writer.write(b"Cache-Control: no-store, no-cache, must-revalidate\r\n")
                writer.write(b"Pragma: no-cache\r\n")
                writer.write(b"Expires: 0\r\n")
                writer.write(("Content-Length: %d\r\n\r\n" % len(resp_body.encode())).encode())
                writer.write(resp_body.encode())
                await writer.drain()
            elif path.startswith("/ui/") and method in ("GET", "HEAD"):
                # 静态文件服务：托管加载项 UI 文件（CreateTaskPane 通过 HTTP URL 加载，v0.8 定论）
                await self._http_static(writer, path, head_only=(method == "HEAD"))
            else:
                await self._http_json(writer, 404, {"error": "Not found"})
        except Exception as e:
            log.debug("http handler error: %s", e)
        finally:
            try:
                writer.close()
            except Exception:
                pass

    async def _http_json(self, writer, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        writer.write(("HTTP/1.1 %d %s\r\n" % (status, "OK" if status == 200 else "Error")).encode())
        writer.write(b"Content-Type: application/json\r\n")
        writer.write(b"Access-Control-Allow-Origin: *\r\n")
        writer.write(("Content-Length: %d\r\n\r\n" % len(body)).encode())
        writer.write(body)
        await writer.drain()

    async def _http_static(self, writer, path: str, head_only: bool = False) -> None:
        """服务 /ui/* 下的静态文件，根目录为 self.ui_root（防目录穿越）。"""
        rel = unquote(path[len("/ui/"):]).lstrip("/")
        if not rel or ".." in rel or rel.startswith("/"):
            await self._http_json(writer, 404, {"error": "Not found"})
            return
        full = os.path.realpath(os.path.join(self.ui_root, rel))
        ui_root_real = os.path.realpath(self.ui_root)
        if full != ui_root_real and not full.startswith(ui_root_real + os.sep):
            await self._http_json(writer, 404, {"error": "Not found"})
            return
        if not os.path.isfile(full):
            await self._http_json(writer, 404, {"error": "Not found"})
            return
        try:
            data = open(full, "rb").read()
        except OSError:
            await self._http_json(writer, 404, {"error": "Not found"})
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME_TYPES.get(ext, "application/octet-stream")
        writer.write(b"HTTP/1.1 200 OK\r\n")
        writer.write(("Content-Type: %s\r\n" % ctype).encode())
        writer.write(b"Access-Control-Allow-Origin: *\r\n")
        writer.write(b"Cache-Control: no-store, no-cache, must-revalidate\r\n")
        writer.write(b"Pragma: no-cache\r\n")
        writer.write(b"Expires: 0\r\n")
        writer.write(("Content-Length: %d\r\n\r\n" % len(data)).encode())
        if not head_only:
            writer.write(data)
        await writer.drain()

    # ── 主循环 ─────────────────────────────────────────────────────
    async def run(self) -> None:
        handlers = [logging.StreamHandler()]
        if self.log_file:
            try:
                handlers.append(logging.FileHandler(self.log_file, encoding="utf-8"))
                log.info("bridge 调试日志文件: %s", self.log_file)
            except OSError as e:
                log.error("无法打开日志文件 %s: %s", self.log_file, e)
        logging.basicConfig(
            level=logging.DEBUG,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
            handlers=handlers,
        )
        await self.start_proc()
        http_server = await asyncio.start_server(self._http_handler, self.host, self.http_port)
        log.info("acp-bridge HTTP listening on http://%s:%d (agent=%s)", self.host, self.http_port, self.agent)
        log.info("acp-bridge UI static root: %s (/ui/*)", self.ui_root)
        async with serve(self._ws_handler, self.host, self.port) as ws_server:
            log.info("acp-bridge WS listening on ws://%s:%d (agent=%s)", self.host, self.port, self.agent)
            try:
                await asyncio.Future()  # run forever
            finally:
                if self.proc:
                    self.proc.kill()


def main() -> None:
    ap = argparse.ArgumentParser(description="WPS-QwenPaw ACP 桥接服务")
    ap.add_argument("--port", type=int, default=8765, help="WebSocket 端口（调试/非 WPS 用）")
    ap.add_argument("--http-port", type=int, default=8766, help="HTTP 轮询端口（WPS 加载项用）")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--agent", default="default")
    ap.add_argument("--ui-root", default=None, help="加载项 UI 静态文件根目录（/ui/* 映射），默认插件仓库根")
    ap.add_argument("--log-file", default=None, help="调试日志文件路径（默认只写 stdout）")
    ap.add_argument("--wps-mcp-entry", default=None,
                    help="wps-office-mcp 入口 dist/index.js 绝对路径（默认 <ui-root>/third_party/opencode-wps/wps-office-mcp/dist/index.js）")
    args = ap.parse_args()
    asyncio.run(AcpBridge(port=args.port, http_port=args.http_port, agent=args.agent, host=args.host,
                          ui_root=args.ui_root, log_file=args.log_file, wps_mcp_entry=args.wps_mcp_entry).run())


if __name__ == "__main__":
    main()
