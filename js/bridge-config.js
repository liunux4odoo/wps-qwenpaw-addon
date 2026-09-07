/**
 * bridge-config.js — bridge 配置拉取 / poll 端口分配（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：与 acp-bridge :8766 的配置面交互——
 * /config（wpsMcpEntry + acpServer + capabilities）、/poll-port/*（路线 P 端口分配）。
 * 依赖：QP（app-state.js）、AcpClient、WpsPollClient、ChatUi、QPLog。
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见；导出跨文件函数（globalThis === window）。
 */
(function () {
  'use strict';
  var S = QP.state;

  // ── 路线 P：从 bridge 集中分配 poll 端口 ──
  // 异步 cb(result)：{port, ok}。失败/超时回退默认 58891（ok=false）。
  // 注意：sync XHR 会忽略 timeout 属性（规范行为），阻塞主线程且无法超时回退，故用异步。
  function allocatePollPort(cb) {
    cb = cb || function () {};
    var result = { port: S.pollPort, ok: false };
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      cb(result);
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', 'http://127.0.0.1:8766/poll-port/allocate?clientId=' + encodeURIComponent(AcpClient.getClientId()), true);
      xhr.timeout = 3000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var r = JSON.parse(xhr.responseText);
            if (r && r.port) {
              S.pollPort = r.port;
              QP.MCP_SERVERS[0].env = [{ name: 'WPS_POLL_PORT', value: String(S.pollPort) }];
              result = { port: S.pollPort, ok: true };
              QPLog('main', 'poll port 分配成功: ' + S.pollPort);
            }
          } catch (e) {}
        } else {
          QPLog('main', 'poll port 分配失败 HTTP ' + xhr.status + '，回退默认 ' + S.pollPort);
        }
        finish();
      };
      xhr.onerror = function () {
        QPLog('main', 'poll port 分配网络错误，回退默认 ' + S.pollPort);
        finish();
      };
      xhr.ontimeout = function () {
        QPLog('main', 'poll port 分配超时，回退默认 ' + S.pollPort);
        finish();
      };
      xhr.send();
    } catch (e) {
      QPLog('main', 'poll port 分配异常: ' + (e && e.message ? e.message : e) + '，回退默认 ' + S.pollPort);
      finish();
    }
  }

  // 重连/初始化后同步权威 poll 端口：覆盖「初始分配失败回退 58891」与「bridge 重启后端口被重新分配」
  // 导致 WpsPollClient 轮询端口与 bridge 注入端口不一致的场景。bridge 是唯一分配者且幂等，结果必一致。
  function syncPollPort() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://127.0.0.1:8766/poll-port?clientId=' + encodeURIComponent(AcpClient.getClientId()), true);
      xhr.timeout = 3000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var r = JSON.parse(xhr.responseText);
            if (r && r.port && r.port !== S.pollPort) {
              S.pollPort = r.port;
              QP.MCP_SERVERS[0].env = [{ name: 'WPS_POLL_PORT', value: String(S.pollPort) }];
              WpsPollClient.init({ serverUrl: 'http://127.0.0.1:' + S.pollPort });
              QPLog('main', 'poll port 重同步: ' + S.pollPort);
            }
          } catch (e) {}
        }
      };
      xhr.onerror = function () {};
      xhr.ontimeout = function () {};
      xhr.send();
    } catch (e) {}
  }

  function releasePollPort() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', 'http://127.0.0.1:8766/poll-port/release?clientId=' + encodeURIComponent(AcpClient.getClientId()), true);
      xhr.timeout = 2000;
      xhr.send();
    } catch (e) {}
  }

  // 从 bridge /config 拉取确定性配置（wps-mcp 入口等），异步回调；失败时保留兜底值
  function loadBridgeConfig(cb) {
    cb = cb || function () {};
    var attempts = 0;
    var delays = [1000, 3000, 5000]; // /config 重试间隔（bridge 冷启动/繁忙时可能慢）
    function attempt() {
      fetchBridgeConfig(function () {
        cb();
      }, function (reason) {
        QPLog('main', 'bridge /config 拉取失败: ' + reason + (attempts < delays.length ? '，重试' : ''));
        if (attempts < delays.length) {
          var d = delays[attempts];
          attempts++;
          setTimeout(attempt, d);
        } else {
          // 根因 2：多次拉取失败 → 可见错误（不静默保留相对路径去 spawn）
          if (!S.bridgeConfigErrorShown) {
            S.bridgeConfigErrorShown = true;
            ChatUi.addMessage('error', 'bridge 配置获取失败（WPS 工具不可用）：请确认 acp-bridge 已启动后重试。');
          }
          cb();
        }
      });
    }
    attempt();
  }

  // 单次拉取 /config 并把权威 wpsMcpEntry（绝对路径）写入 MCP_SERVERS。
  // onSuccess()：成功（已更新 MCP_SERVERS，wpsMcpEntryReady=true）；onFail(reason)：本次尝试失败。
  function fetchBridgeConfig(onSuccess, onFail) {
    onFail = onFail || function () {};
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://127.0.0.1:8766/config', true);
      xhr.timeout = 4000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var r = JSON.parse(xhr.responseText);
            if (r && r.wpsMcpEntry) {
              QP.MCP_SERVERS[0].args = [r.wpsMcpEntry];
              S.wpsMcpEntryReady = true;
              S.bridgeConfigErrorShown = false; // 配置恢复后允许后续失败再次提示
              if (r.acpServer) S.acpServerName = r.acpServer; // 版本倾斜检测（switchAgent）
              // Phase 2：能力标志（opencode 无审批/无 cancel/无 thought heartbeat 等），
              // 前端按标志适配协议偏好；缺失时保留 qwenpaw 兼容默认值
              if (r.capabilities && typeof r.capabilities === 'object') {
                for (var k in r.capabilities) {
                  if (Object.prototype.hasOwnProperty.call(r.capabilities, k)) {
                    S.capabilities[k] = r.capabilities[k];
                  }
                }
                QPLog('main', 'capabilities=' + JSON.stringify(S.capabilities));
              }
              // Phase 3：能力差异说明随 server 变化更新（设置面板 UI）
              updateCapabilityUI();
              QPLog('main', 'bridge /config 下发 wpsMcpEntry: ' + r.wpsMcpEntry);
              if (onSuccess) onSuccess();
              return;
            }
          } catch (e) {}
        }
        onFail('HTTP ' + xhr.status);
      };
      xhr.onerror = function () { onFail('网络错误'); };
      xhr.ontimeout = function () { onFail('超时'); };
      xhr.send();
    } catch (e) {
      onFail('异常: ' + (e && e.message ? e.message : e));
    }
  }

  // 根因 2：拉取 /config（有限重试），成功则继续建会话；确认失败给用户可见错误。
  function ensureBridgeConfigThenSession() {
    if (S.configFetching) return; // 已有在途 /config 拉取链
    S.configFetching = true;
    var attempts = 0;
    var delays = [1000, 3000];
    function finish() { S.configFetching = false; }
    function attempt() {
      fetchBridgeConfig(function () {
        finish();
        ensureSession();
      }, function (reason) {
        QPLog('main', 'ensureSession 拉取 /config 失败: ' + reason);
        if (attempts < delays.length) {
          var d = delays[attempts];
          attempts++;
          setTimeout(attempt, d);
        } else {
          finish();
          if (!S.bridgeConfigErrorShown) {
            S.bridgeConfigErrorShown = true;
            ChatUi.addMessage('error', 'bridge 配置获取失败（WPS 工具不可用）：请确认 acp-bridge 已启动后重试。');
          }
          ChatUi.setStatus('ACP: bridge 未就绪');
        }
      });
    }
    attempt();
  }

  // 导出跨文件函数（globalThis === window）
  globalThis.allocatePollPort = allocatePollPort;
  globalThis.syncPollPort = syncPollPort;
  globalThis.releasePollPort = releasePollPort;
  globalThis.loadBridgeConfig = loadBridgeConfig;
  globalThis.fetchBridgeConfig = fetchBridgeConfig;
  globalThis.ensureBridgeConfigThenSession = ensureBridgeConfigThenSession;
})();
