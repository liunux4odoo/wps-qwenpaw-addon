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
  - GET  /status                    -> {"status":"running","agent":...}
  - POST /acp/send?clientId=X       body=NDJSON ACP 请求（一行一条 JSON-RPC）-> 写 qwenpaw stdin
  - GET  /acp/poll?clientId=X       -> 该 clientId 的待下行 ACP 消息（JSONL，每行一条）
  - GET  /ui/*                      -> 加载项 UI 静态文件（CreateTaskPane 经此加载 taskpane.html，
                                       与 ACP 轮询同源，无 CORS 问题；根目录为插件仓库根，可 --ui-root 覆盖）
  - POST /debug/log                 -> 接收加载项侧调试日志（body={"tag","msg"}），统一落盘到 bridge 日志

WebSocket 端点：ws://127.0.0.1:8765（上行原样转发；下行按 sessionId/请求 id 路由）

Wire 协议（阶段 0.5 实测，ACP v0.12.2）：
  - 帧格式：NDJSON（每行一条紧凑 JSON-RPC 2.0，json.dumps(separators=(",",":")) + "\\n"）
  - 流式下行：session/update 通知（无 id，带 sessionId），update.sessionUpdate=agent_message_chunk

用法：
  python acp-bridge.py [--port 8765] [--http-port 8766] [--agent default] [--host 127.0.0.1]
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
                 ui_root: str | None = None, log_file: str | None = None):
        self.port = port
        self.http_port = http_port
        self.agent = agent
        self.host = host
        # 静态文件根目录（加载项 UI 文件，/ui/* 映射）：默认插件仓库根（bridge/ 的上一级）
        self.ui_root = ui_root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        # 调试日志文件（None = 只写 stdout）
        self.log_file = log_file
        # 连接集与路由表
        self.ws_conns: set[ServerConnection] = set()
        self.ws_session_conns: dict[str, ServerConnection] = {}
        self.ws_pending: dict[object, ServerConnection] = {}
        # HTTP 客户端（clientId -> 下行队列 deque[str]）
        self.http_clients: dict[str, deque] = {}
        self.http_session_client: dict[str, str] = {}
        self.http_pending: dict[object, str] = {}
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
            elif "id" in msg:
                target = self.http_pending.get(msg["id"])
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
        log.info("upstream[%s]: %s", client_id or "ws", self._summarize_acp(raw))
        # 记录请求 id -> 来源 client（用于下行响应路由）
        try:
            msg = json.loads(raw)
            rid = msg.get("id")
            if rid is not None:
                if client_id:
                    self.http_pending[rid] = client_id
                else:
                    # WebSocket 场景在 _ws_handler 里单独记录
                    pass
            params = msg.get("params")
            if isinstance(params, dict) and params.get("sessionId"):
                sid = str(params["sessionId"])
                if client_id:
                    self.http_session_client[sid] = client_id
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
                await self._http_json(writer, 200, {
                    "status": "running",
                    "agent": self.agent,
                    "proc": self.proc.pid if self.proc else None,
                })
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
    args = ap.parse_args()
    asyncio.run(AcpBridge(port=args.port, http_port=args.http_port, agent=args.agent, host=args.host,
                          ui_root=args.ui_root, log_file=args.log_file).run())


if __name__ == "__main__":
    main()
