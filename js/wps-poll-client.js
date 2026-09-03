/**
 * wps-poll-client.js — 角色 B：连轮询桥拉取/回传命令
 *
 * 模块边界（ARCHITECTURE §4.2）：只懂 wps-office-mcp 的轮询协议，不知道 ACP、不知道 UI。
 *
 * 轮询协议（阶段 0 实测，见 ARCHITECTURE §3.3）：
 *   - GET /poll  每 500ms 拉取命令；有活回 {"command":{"action","params","requestId"}}，没活回 {}
 *   - POST /result  回报 {"requestId","result":{"success","data","error"}}；服务端回 {"ok":true}
 *   - 需要：requestId 去重（poll 可能重复返回同一命令）、结果 POST 失败重试 3 次（500ms 退避）、
 *     poll 网络错误指数退避（500ms→5s 封顶）
 *
 * serverUrl（路线 P）：默认 :58891；多实例场景由 main.js 传 bridge 分配的独立端口
 * （http://127.0.0.1:<WPS_POLL_PORT>），各窗口轮询自己的端口，不抢单例、不串台（ARCHITECTURE §13）。
 *
 * 对外接口（供 main.js 使用）：
 *   - init({ serverUrl, handler, onStatus })
 *   - start() / stop()
 */
var WpsPollClient = (function () {
  'use strict';

  var CONFIG = {
    SERVER_URL: 'http://127.0.0.1:58891', // 默认单实例端口；路线 P 下由 main.js 覆盖为分配端口
    POLL_INTERVAL: 500,
    POLL_TIMEOUT: 5000
  };

  var pollTimer = null;
  var isPolling = false;
  var failCount = 0;
  var lastError = '';
  var lastRequestId = '';
  var backoffBase = 500;
  var backoffMax = 5000;

  var cmdHandler = null;
  var statusCb = null;

  // 日志：优先走 main.js 的 QPLog，否则 console
  function log(tag, msg) {
    if (typeof window !== 'undefined' && window.QPLog) {
      window.QPLog(tag, msg);
    } else {
      try { console.log('[' + tag + '] ' + msg); } catch (e) {}
    }
  }

  function init(opts) {
    if (opts) {
      if (opts.serverUrl) CONFIG.SERVER_URL = opts.serverUrl;
      if (opts.pollInterval) CONFIG.POLL_INTERVAL = opts.pollInterval;
      if (opts.handler) cmdHandler = opts.handler;
      if (opts.onStatus) statusCb = opts.onStatus;
    }
  }

  function emitStatus() {
    if (statusCb) statusCb(failCount, lastError);
  }

  function start() {
    if (pollTimer) return;
    isPolling = true;
    log('poll', 'start: 开始轮询 ' + CONFIG.SERVER_URL + '/poll');
    poll();
  }

  function stop() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    isPolling = false;
    log('poll', 'stop: 停止轮询');
  }

  function poll() {
    if (!isPolling) return;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', CONFIG.SERVER_URL + '/poll', true);
    xhr.timeout = CONFIG.POLL_TIMEOUT;

    xhr.onload = function () {
      if (xhr.status === 200) {
        failCount = 0;
        lastError = '';
        emitStatus();
        try {
          var resp = JSON.parse(xhr.responseText);
          if (resp && resp.command) {
            // requestId 去重：同一命令不重复执行（轮询可能重复返回同一命令）
            if (resp.command.requestId && resp.command.requestId === lastRequestId) {
              log('poll', '忽略重复命令 requestId=' + resp.command.requestId);
              scheduleNext();
              return;
            }
            lastRequestId = resp.command.requestId || '';
            log('poll', '收到命令 action=' + resp.command.action + ' requestId=' + resp.command.requestId + ' params=' + JSON.stringify(resp.command.params || {}).slice(0, 300));
            // 先排下一轮再执行命令，避免耗时命令阻塞轮询节奏
            scheduleNext();
            dispatchCommand(resp.command);
          } else {
            scheduleNext();
          }
        } catch (e) {
          failCount++;
          lastError = '解析失败: ' + e.message;
          emitStatus();
          scheduleNext();
        }
      } else {
        failCount++;
        lastError = 'HTTP ' + xhr.status;
        emitStatus();
        scheduleNext();
      }
    };

    xhr.onerror = function () {
      failCount++;
      lastError = '网络错误';
      emitStatus();
      scheduleNext();
    };

    xhr.ontimeout = function () {
      failCount++;
      lastError = '超时';
      emitStatus();
      scheduleNext();
    };

    try {
      xhr.send();
    } catch (e) {
      failCount++;
      lastError = e.message || String(e);
      emitStatus();
      scheduleNext();
    }
  }

  // 指数退避：连续失败 500ms -> 1s -> 2s -> 4s -> 5s(封顶)
  function scheduleNext() {
    if (!isPolling) return;
    var delay = CONFIG.POLL_INTERVAL;
    if (failCount > 0) {
      var multiplier = Math.pow(2, Math.min(failCount - 1, 4));
      delay = Math.min(backoffBase * multiplier, backoffMax);
    }
    pollTimer = setTimeout(poll, delay);
  }

  function dispatchCommand(cmd) {
    var result;
    try {
      if (cmdHandler) {
        result = cmdHandler(cmd.action, cmd.params || {});
      } else {
        result = { success: false, error: '无命令处理器', data: null };
      }
    } catch (e) {
      result = { success: false, error: e.message || String(e), data: null };
    }
    // 支持异步 handler（返回 Promise 时等待）
    if (result && typeof result.then === 'function') {
      log('poll', '命令异步执行 action=' + cmd.action + ' requestId=' + cmd.requestId);
      result.then(function (r) {
        log('poll', '命令完成 action=' + cmd.action + ' requestId=' + cmd.requestId + ' success=' + !!(r && r.success));
        sendResult(cmd.requestId, r || { success: true, data: null });
      })['catch'](function (e) {
        log('poll', '命令异常 action=' + cmd.action + ' requestId=' + cmd.requestId + ' err=' + (e && e.message ? e.message : e));
        sendResult(cmd.requestId, { success: false, error: e.message || String(e), data: null });
      });
    } else {
      log('poll', '命令同步完成 action=' + cmd.action + ' requestId=' + cmd.requestId + ' success=' + !!(result && result.success));
      sendResult(cmd.requestId, result || { success: true, data: null });
    }
  }

  function sendResult(requestId, result, attempt) {
    attempt = attempt || 1;
    log('poll', '回报结果 requestId=' + requestId + ' attempt=' + attempt + ' success=' + !!(result && result.success) + (result && result.error ? ' error=' + result.error : ''));
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', CONFIG.SERVER_URL + '/result', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 3000;
      xhr.onload = function () {
        if (xhr.status !== 200 && attempt < 3) {
          setTimeout(function () { sendResult(requestId, result, attempt + 1); }, 500 * attempt);
        }
      };
      xhr.onerror = function () {
        if (attempt < 3) {
          setTimeout(function () { sendResult(requestId, result, attempt + 1); }, 500 * attempt);
        }
      };
      xhr.ontimeout = function () {
        if (attempt < 3) {
          setTimeout(function () { sendResult(requestId, result, attempt + 1); }, 500 * attempt);
        }
      };
      xhr.send(JSON.stringify({ requestId: requestId, result: result }));
    } catch (e) {
      // 结果发送失败：留痕即可（服务端会超时）
    }
  }

  return {
    init: init,
    start: start,
    stop: stop
  };
})();
