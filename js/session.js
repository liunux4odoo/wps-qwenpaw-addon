/**
 * session.js — ACP 会话生命周期（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：ACP 会话建立/复用/恢复 + 会话建立看门狗。
 * 依赖：QP（app-state.js）、AcpClient、ChatUi、QPLog，以及 bridge-config.js 的
 * fetchBridgeConfig/ensureBridgeConfigThenSession/syncPollPort、doc-state.js 的
 * getSessionCwd、actions.js 的 updateStatus/updateSendAvailability。
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见；导出跨文件函数（globalThis === window）。
 */
(function () {
  'use strict';
  var S = QP.state;

  // ── ACP 连接状态 ──
  function onAcpConnChange(state) {
    QPLog('main', 'ACP 连接状态变化: ' + state);
    S.acpState = (state === 'connected') ? 'connected' : (state === 'connecting') ? 'connecting' : 'disconnected';
    updateStatus();
    if (state === 'connected') {
      // 建会话前先即时复查活动文档（P8）：确保 currentDocId/sessionId 缓存落在正确文档上，
      // 覆盖"先打开插件、再新建/打开文档"时周期检测未跑完的空档。
      try { if (typeof checkDocNow === 'function') checkDocNow(); } catch (e) {}
      syncPollPort();  // 重连时同步权威端口（覆盖初始分配失败/bridge 重启场景）
      ensureSession();
    } else if (state === 'disconnected') {
      S.acpSessionId = null;
      ChatUi.setStatus('ACP: 未连接');
    }
    updateSendAvailability(); // P21：连接状态变化 → 刷新发送可用性
  }

  // 连接后创建/复用会话（initialize 由 acp-bridge 无需显式）。
  // P15：同一文档重开时优先 session/load 复用缓存的 sessionId（恢复 AI 上下文记忆），
  // 无缓存才 session/new。sessionId 按 docId 持久化在 localStorage（qp.session.<docId>）。
  // 根因 2：wps-mcp 入口必须是权威绝对路径（/config 下发）才发 session/new，未就绪先拉 /config。
  // 根因 1：发送后启动看门狗（超时清 pending + 重试 ≤1 + 可见错误），防请求被丢弃后永久锁死。
  function ensureSession() {
    if (S.acpSessionId) return;
    // 已有在途的 session/new 或 session/load：不重复发送（防 onAcpConnChange 重入/onUserSend 竞态）
    for (var k in S.pendingRequests) {
      if (S.pendingRequests[k] && (S.pendingRequests[k].method === 'session/new' || S.pendingRequests[k].method === 'session/load')) {
        return;
      }
    }
    if (!S.wpsMcpEntryReady) {
      // 根因 2：不得带相对/空路径去 spawn（静默失败）——先拉 /config，成功后再继续建会话
      QPLog('main', 'ensureSession: wpsMcpEntry 未就绪，先拉取 /config');
      ChatUi.setStatus('ACP: 等待 bridge 配置…');
      ensureBridgeConfigThenSession();
      return;
    }
    S.sessionRetries = 0; // 新的逻辑会话建立尝试
    ensureSessionSend();
  }

  function ensureSessionSend() {
    // Phase 2 C7：session/load 按能力标志门禁——server 不支持历史恢复时直接 session/new
    //（不携带缓存 id；qwenpaw/opencode 均 loadSession=true，当前无行为变化，纯能力适配）。
    var cachedSid = S.capabilities.loadSession ? QP.loadCachedSessionId(S.currentDocId) : null;
    var method = cachedSid ? 'session/load' : 'session/new';
    var cwd = getSessionCwd(); // P16：cwd = 当前活动文档目录；无路径回退默认
    var params = {
      cwd: cwd,
      mcpServers: QP.MCP_SERVERS
    };
    if (cachedSid) params.sessionId = cachedSid;
    var id = AcpClient.send(method, params);
    if (id !== null) {
      S.pendingRequests[id] = { method: method };
      S.sessionFailed = false; // P21：新一次会话建立尝试 → 清除失败标记（可重试）
      startSessionWatchdog();
      QPLog('main', 'ensureSession: 发送 ' + method + ' id=' + id + ' (cwd=' + cwd + ', mcpServers=' + QP.MCP_SERVERS.length + (cachedSid ? ', cachedSid=' + cachedSid : '') + ')');
      ChatUi.setStatus(cachedSid ? 'ACP: 恢复会话…' : 'ACP: 创建会话…');
    } else {
      QPLog('main', 'ensureSession: ' + method + ' 发送失败（未连接）');
    }
  }

  // Phase 2 C3 + Phase 3（plan-2026-09-05 §5.2/§7，V9/V11）：opencode 会话级配置应用。
  // session/set_config_option（configOptions 数组只读不生效；且为会话级，新建会话默认仍 build/low）。
  // 会话建立成功后：mode（agentCached）+ 记住的 model/effort（localStorage）都重新应用到新会话。
  function maybeApplyConfigOption(sessionId) {
    if (!sessionId) return;
    if (S.capabilities.switchSemantics !== 'config_option') return;
    // mode（V11：agent/mode 切换走 set_config_option，会话级）
    if (S.agentCached && S.agentCached.length) {
      applyConfigOptionOnSession('mode', S.agentCached, sessionId);
    }
    // Phase 3：记住的 model/effort（会话级不跨会话，新会话重新应用）
    var saved = QP.loadSavedConfigOptions();
    if (saved.model) applyConfigOptionOnSession('model', saved.model, sessionId);
    if (saved.effort) applyConfigOptionOnSession('effort', saved.effort, sessionId);
  }

  function applyConfigOptionOnSession(configId, value, sessionId) {
    var id = AcpClient.send('session/set_config_option', {
      sessionId: sessionId,
      configId: configId,
      value: value
    });
    if (id !== null) {
      S.pendingRequests[id] = { method: 'session/set_config_option' };
      QPLog('main', 'set_config_option(' + configId + '=' + value + ') 已应用到会话 ' + sessionId + ' id=' + id);
    }
  }

  // ── 会话建立看门狗（根因 1 路线 B）──
  function clearSessionWatchdog() {
    if (S.sessionTimer) { clearTimeout(S.sessionTimer); S.sessionTimer = null; }
  }

  function startSessionWatchdog() {
    clearSessionWatchdog();
    S.sessionTimer = setTimeout(onSessionTimeout, QP.SESSION_TIMEOUT_MS);
  }

  function onSessionTimeout() {
    S.sessionTimer = null;
    // 找出在途的 session/new 或 session/load 请求；若响应已到（pending 已被 onAcpResponse 删除）则不处理
    var method = null;
    for (var k in S.pendingRequests) {
      var req = S.pendingRequests[k];
      if (req && (req.method === 'session/new' || req.method === 'session/load')) {
        method = req.method;
        delete S.pendingRequests[k]; // 清理防锁死：后续 ensureSession 不再被防重入卡住
        break;
      }
    }
    if (!method || S.acpSessionId) return;
    if (S.sessionRetries < 1) {
      S.sessionRetries++;
      QPLog('main', '会话建立超时（' + method + '），自动重试 1/2');
      ChatUi.setStatus('ACP: 创建会话…（重试）');
      ensureSessionSend();
      return;
    }
    if (method === 'session/load') {
      // 沿用 session/load 失败降级：清缓存回退 session/new（守 plan 边界 #8）
      QPLog('P15', 'session/load 超时，清缓存回退 session/new');
      QP.saveCachedSessionId(S.currentDocId, null);
      ChatUi.addMessage('system', '上次会话恢复超时，正在创建新会话…');
      S.sessionRetries = 0;
      ensureSessionSend();
      return;
    }
    QPLog('main', '会话建立超时，重试次数用尽');
    S.sessionFailed = true; // P21：建立失败 → 发送按钮保持禁用 + 占位提示（错误卡片可重试/重建）
    ChatUi.addErrorCard('会话建立失败', 'bridge 或 AI 后端未就绪（创建会话响应超时）。请稍后重试或重建会话。', { retry: true, rebuild: true });
    ChatUi.setStatus('ACP: 会话建立失败');
    updateSendAvailability(); // P21：失败态刷新占位（禁用态保持）
  }

  // 导出跨文件函数（globalThis === window）
  globalThis.onAcpConnChange = onAcpConnChange;
  globalThis.ensureSession = ensureSession;
  globalThis.maybeApplyConfigOption = maybeApplyConfigOption;
  globalThis.clearSessionWatchdog = clearSessionWatchdog;
})();
