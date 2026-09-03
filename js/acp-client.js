/**
 * acp-client.js — 简化版 ACP 客户端（HTTP 轮询 transport）
 *
 * 模块边界（ARCHITECTURE §4.2）：只懂 ACP 协议，不知道 WPS、不知道 DOM。
 *
 * 传输（阶段 1 实测修正）：WPS Linux 沙箱只放行 HTTP、拦截 WebSocket，因此改用
 * HTTP 短轮询连接 acp-bridge（与 wps-office-mcp :58891 同机制，WPS 已验证支持）：
 *   - POST /acp/send?clientId=X   上行：body=NDJSON ACP 请求（一行一条 JSON-RPC）
 *   - GET  /acp/poll?clientId=X   下行：返回待发 ACP 消息（JSONL，每行一条）
 *
 * ACP wire 协议（阶段 0.5 实测，见 ARCHITECTURE §3.4）：
 *   - 请求：{jsonrpc, id, method, params}
 *   - 响应：{jsonrpc, id, result} 或 {error}
 *   - 流式下行：session/update 通知（无 id，带 sessionId），update.sessionUpdate=agent_message_chunk
 *
 * 对外接口（供 main.js 使用）：
 *   - connect(url) / disconnect()
 *   - send(method, params) -> requestId
 *   - respond(id, result)：回复服务端请求（如 session/request_permission）
 *   - onConnectionChange(cb)：连接状态变化回调（'connecting'|'connected'|'disconnected'）
 *   - onResponse(cb)：收到 id 对应的 JSON-RPC 响应回调（cb(id, result, error)）
 *   - onSessionUpdate(cb)：收到 session/update 通知回调（cb(sessionId, update)）
 *   - onRequest(cb)：收到服务端请求回调（cb(req)），如 session/request_permission（工具审批）
 */
var AcpClient = (function () {
  'use strict';

  var SERVER_URL = 'http://127.0.0.1:8766';
  var POLL_INTERVAL = 300;
  var POLL_TIMEOUT = 5000;

  var clientId = 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  var seq = 0;
  var status = 'disconnected';
  var running = false;   // 轮询循环是否在跑（与 status 解耦：网络错误不杀循环）
  var pollTimer = null;
  var failCount = 0;
  var backoffBase = 300;
  var backoffMax = 5000;

  var cbConnChange = null;
  var cbResponse = null;
  var cbSessionUpdate = null;
  var cbRequest = null;

  // 日志：优先走 main.js 的 QPLog（POST 到 bridge /debug/log），否则 console
  function log(tag, msg) {
    if (typeof window !== 'undefined' && window.QPLog) {
      window.QPLog(tag, msg);
    } else {
      try { console.log('[' + tag + '] ' + msg); } catch (e) {}
    }
  }

  function setStatus(s) {
    if (status === s) return;
    log('acp', '连接状态: ' + status + ' -> ' + s);
    status = s;
    if (cbConnChange) cbConnChange(s);
  }

  function start() {
    if (running) return;
    running = true;
    log('acp', 'start: 开始轮询 (clientId=' + clientId + ')');
    setStatus('connecting');
    poll();
  }

  function stop() {
    running = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    log('acp', 'stop: 停止轮询');
    setStatus('disconnected');
  }

  // 下行轮询：GET /acp/poll
  function poll() {
    if (!running) return;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', SERVER_URL + '/acp/poll?clientId=' + encodeURIComponent(clientId), true);
    xhr.timeout = POLL_TIMEOUT;

    xhr.onload = function () {
      if (!running) return;
      if (xhr.status === 200) {
        failCount = 0;
        setStatus('connected');
        var lines = xhr.responseText.split('\n');
        var n = 0;
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          n++;
          handleMessage(line);
        }
        if (n > 0) log('acp', 'poll 收到 ' + n + ' 条下行消息');
        scheduleNext();
      } else {
        log('acp', 'poll HTTP ' + xhr.status);
        failCount++;
        scheduleNext();
      }
    };

    xhr.onerror = function () {
      if (!running) return;
      log('acp', 'poll 网络错误');
      failCount++;
      // 注意：网络错误时不能 setStatus('disconnected')+scheduleNext，
      // 否则 scheduleNext 的 status 守卫会让轮询永久死亡。
      // status 留给 scheduleNext 在退避上限时再标，UI 短暂显示 connecting 即可。
      scheduleNext();
    };

    xhr.ontimeout = function () {
      if (!running) return;
      log('acp', 'poll 超时');
      failCount++;
      scheduleNext();
    };

    try {
      xhr.send();
    } catch (e) {
      if (!running) return;
      log('acp', 'poll send 异常: ' + e.message);
      failCount++;
      scheduleNext();
    }
  }

  function scheduleNext() {
    if (!running) return;
    var delay = POLL_INTERVAL;
    if (failCount > 0) {
      var multiplier = Math.pow(2, Math.min(failCount - 1, 4));
      delay = Math.min(backoffBase * multiplier, backoffMax);
      // 连续失败超过退避上限仍未恢复，标记 disconnected（仅 UI，不杀循环）
      if (failCount > 10 && status === 'connected') {
        setStatus('disconnected');
      }
    }
    pollTimer = setTimeout(poll, delay);
  }

  function handleMessage(raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (msg.method === 'session/update') {
      var upd = (msg.params && msg.params.update) || {};
      log('acp', '下行通知 session/update (' + (upd.sessionUpdate || '?') + ')');
      if (cbSessionUpdate) cbSessionUpdate(msg.params.sessionId, msg.params.update);
    } else if (msg.id !== undefined && msg.id !== null && msg.method) {
      // 服务端发来的请求（无 result/error，带 method）：如 session/request_permission
      log('acp', '下行请求 ' + msg.method + ' id=' + msg.id);
      if (cbRequest) cbRequest(msg);
    } else if (msg.id !== undefined && msg.id !== null) {
      log('acp', '下行响应 id=' + msg.id + (msg.error ? ' error' : ' result'));
      if (cbResponse) cbResponse(msg.id, msg.result, msg.error);
    } else {
      log('acp', '下行未知消息: ' + raw.slice(0, 200));
    }
  }

  /**
   * 回复服务端发来的请求（如 session/request_permission）。
   * 使用请求的同一 id，result 为响应内容。
   */
  function respond(id, result) {
    var payload = JSON.stringify({ jsonrpc: '2.0', id: id, result: result || {} });
    log('acp', 'respond id=' + id + ' result=' + JSON.stringify(result || {}).slice(0, 200));
    var xhr = new XMLHttpRequest();
    xhr.open('POST', SERVER_URL + '/acp/send?clientId=' + encodeURIComponent(clientId), true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 5000;
    xhr.send(payload);
  }

  /**
   * 发送 ACP 请求（HTTP POST 上行）。返回本地 requestId。
   */
  function send(method, params) {
    if (status !== 'connected') {
      log('acp', 'send 被拒（未连接）method=' + method);
      return null;
    }
    var id = ++seq;
    var payload = JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    log('acp', 'send ' + method + ' id=' + id + ' params=' + JSON.stringify(params || {}).slice(0, 300));
    var xhr = new XMLHttpRequest();
    xhr.open('POST', SERVER_URL + '/acp/send?clientId=' + encodeURIComponent(clientId), true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 5000;
    xhr.send(payload);
    return id;
  }

  function connect() {
    start();
  }

  function disconnect() {
    stop();
  }

  function isConnected() {
    return status === 'connected';
  }

  // clientId 用于：/acp/* 轮询 + /poll-port/allocate 端口分配（同一 client 保持一致）
  function getClientId() {
    return clientId;
  }

  return {
    connect: connect,
    disconnect: disconnect,
    send: send,
    respond: respond,
    isConnected: isConnected,
    getClientId: getClientId,
    onConnectionChange: function (cb) { cbConnChange = cb; },
    onResponse: function (cb) { cbResponse = cb; },
    onSessionUpdate: function (cb) { cbSessionUpdate = cb; },
    onRequest: function (cb) { cbRequest = cb; }
  };
})();
