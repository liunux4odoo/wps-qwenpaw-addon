/**
 * main.js — 入口胶水层（唯一耦合点）
 *
 * 模块边界（ARCHITECTURE §4.2）：知道所有其他模块，其他模块互不依赖。
 *
 * 双上下文运行：
 *   - ribbon 上下文（manifest scripts 加载）：注册 OnAddinLoad / OnShowTaskPane / OnStatusClick，
 *     负责创建/切换侧边栏 taskpane
 *   - taskpane 页面上下文（taskpane.html 加载）：初始化聊天 UI + ACP 客户端 + 轮询客户端
 *
 * 对外接口（ARCHITECTURE §4.3）：init() / sendUserMessage(text) / closeSession()
 */
(function () {
  'use strict';

  var ACP_WS_URL = 'ws://127.0.0.1:8765';
  var SESSION_CWD = '/tmp/kilo'; // QwenPaw ACP session 工作目录（阶段 1 固定，后续按文档项目目录）

  // ── 统一调试日志：console.log + POST 到 bridge /debug/log（持久化，WPS CEF 崩溃时也能在 bridge 日志看到） ──
  function QPLog(tag, msg) {
    var line = '[' + tag + '] ' + msg;
    try { console.log(line); } catch (e) {}
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', 'http://127.0.0.1:8766/debug/log', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 2000;
      xhr.send(JSON.stringify({ tag: tag, msg: String(msg) }));
    } catch (e) {}
  }
  window.QPLog = QPLog;

  // bridge /config 下发的 wps-mcp 入口；未取到前的兜底值（仅当 bridge 不可达时使用，
  // 正常运行时由 /config 返回的绝对路径覆盖——bridge 依据仓库根解析 submodule 路径）
  var WPS_MCP_ENTRY_DEFAULT = '../third_party/opencode-wps/wps-office-mcp/dist/index.js';

  // wps-office-mcp MCP 服务器（§5.1 + §13 v0.17 路线 P）：
  // 走 stdio（QwenPaw 每 ACP session spawn 独立 wps-mcp 子进程），bridge 集中分配独立 poll 端口
  // （WPS_POLL_PORT env 注入，59000+ 段，多窗口并发不抢 :58891、不串台）。
  // env 是 [{name,value}] 列表（ACP schema: McpServerStdio.env = List[EnvVariable]），
  // 端口值由 bridge /poll-port/allocate 分配后覆盖（bridge 转发 session/new 时也会强制注入权威值）。
  // 入口路径不硬编码本机绝对路径：由 bridge /config 下发（bridge 依据仓库根解析，
  // opencode-wps 以 submodule 固定在 third_party/opencode-wps/，路径可确定）。
  var MCP_SERVERS = [{
    name: 'wps',
    command: 'node',
    args: [WPS_MCP_ENTRY_DEFAULT],
    env: [{ name: 'WPS_POLL_PORT', value: '58891' }]
  }];

  // 本窗口分配到的 poll 端口（路线 P；默认 58891 兜底，分配失败时回退旧行为）
  var pollPort = 58891;

  // ── taskpane 上下文状态 ──
  var isTaskpane = !!document.getElementById('messages');
  var acpSessionId = null;
  var streamBuffer = ''; // 当前流式消息的累积文本
  var waitingResponse = false; // 是否有 in-flight 请求（禁止并发发送）
  var pendingRequests = {}; // requestId -> { method, text }
  var ribbonUI = null;

  // ── 阶段 3 批 1：P1 状态合并 / P2 中断恢复 / P4 过程呈现 / P5 中止 ──
  var P2_NO_FIRST_CHUNK_MS = 60000;  // 发送后 60s 无任何 chunk → 判定中断（P2）
  var P2_ACTIVITY_MS = 120000;       // 连续 120s 无任何下行活动 → 判定卡死（P2）
  var acpState = 'connecting';       // 'connecting' | 'connected' | 'disconnected'
  var wpsState = 'pending';          // 'pending'（未激活，预期）| 'connected'
  var lastAcpShown = null;           // 已渲染的 ACP 状态（避免 500ms 轮询重复写 DOM）
  var lastWpsShown = null;           // 已渲染的 WPS 状态
  var gotFirstChunk = false;         // P2 诊断：prompt 发出后是否收到首个 chunk
  var lastUserText = '';             // P2 重试用：最近一次用户消息
  var lastPromptReqId = null;        // 当前 prompt 的请求 id
  var pendingToolCards = [];         // P4：当前进行中的工具卡片（新工具调用时旧的先标记完成）
  var noFirstChunkTimer = null;      // P2：无首 chunk 看门狗
  var activityTimer = null;          // P2：无下行活动看门狗

  // ── 路线 P：从 bridge 集中分配 poll 端口 ──
  // 异步 cb(result)：{port, ok}。失败/超时回退默认 58891（ok=false）。
  // 注意：sync XHR 会忽略 timeout 属性（规范行为），阻塞主线程且无法超时回退，故用异步。
  function allocatePollPort(cb) {
    cb = cb || function () {};
    var result = { port: pollPort, ok: false };
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
              pollPort = r.port;
              MCP_SERVERS[0].env = [{ name: 'WPS_POLL_PORT', value: String(pollPort) }];
              result = { port: pollPort, ok: true };
              QPLog('main', 'poll port 分配成功: ' + pollPort);
            }
          } catch (e) {}
        } else {
          QPLog('main', 'poll port 分配失败 HTTP ' + xhr.status + '，回退默认 ' + pollPort);
        }
        finish();
      };
      xhr.onerror = function () {
        QPLog('main', 'poll port 分配网络错误，回退默认 ' + pollPort);
        finish();
      };
      xhr.ontimeout = function () {
        QPLog('main', 'poll port 分配超时，回退默认 ' + pollPort);
        finish();
      };
      xhr.send();
    } catch (e) {
      QPLog('main', 'poll port 分配异常: ' + (e && e.message ? e.message : e) + '，回退默认 ' + pollPort);
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
            if (r && r.port && r.port !== pollPort) {
              pollPort = r.port;
              MCP_SERVERS[0].env = [{ name: 'WPS_POLL_PORT', value: String(pollPort) }];
              WpsPollClient.init({ serverUrl: 'http://127.0.0.1:' + pollPort });
              QPLog('main', 'poll port 重同步: ' + pollPort);
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
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://127.0.0.1:8766/config', true);
      xhr.timeout = 3000;
      xhr.onload = function () {
        if (xhr.status === 200) {
          try {
            var r = JSON.parse(xhr.responseText);
            if (r && r.wpsMcpEntry) {
              MCP_SERVERS[0].args = [r.wpsMcpEntry];
              QPLog('main', 'bridge /config 下发 wpsMcpEntry: ' + r.wpsMcpEntry);
            }
          } catch (e) {}
        } else {
          QPLog('main', 'bridge /config 拉取失败 HTTP ' + xhr.status);
        }
        cb();
      };
      xhr.onerror = function () { QPLog('main', 'bridge /config 网络错误'); cb(); };
      xhr.ontimeout = function () { QPLog('main', 'bridge /config 超时'); cb(); };
      xhr.send();
    } catch (e) {
      QPLog('main', 'bridge /config 异常: ' + (e && e.message ? e.message : e));
      cb();
    }
  }

  // ══════════════════════════════════════════════
  // taskpane 上下文：聊天 + ACP + 轮询
  // ══════════════════════════════════════════════
  function initTaskpane() {
    QPLog('main', 'initTaskpane: 初始化聊天 UI + ACP + 轮询客户端');
    // 1. 聊天 UI
    ChatUi.init({
      onSend: onUserSend,
      onStop: onStop,
      onRetry: onRetry,
      onRebuild: onRebuild
    });
    // P1：初始状态（启动握手：ACP 连接中 + WPS 未激活）
    updateStatus();

    // 2. 从 bridge 拉取确定性配置（wps-mcp 入口），完成后再分配 poll 端口 + 连接 ACP，
    //    保证 ensureSession 用到的 MCP_SERVERS 路径已就绪
    loadBridgeConfig(function () {
      // 3. 路线 P：异步分配 poll 端口（与 ACP 连接并行）。bridge 是唯一分配者且幂等：
      //    即使 session/new 先于分配完成发出，bridge 也会按该 client 幂等分配同一端口，无竞态。
      allocatePollPort(function (alloc) {
        WpsPollClient.init({
          serverUrl: 'http://127.0.0.1:' + alloc.port,
          handler: onPollCommand,
          onStatus: onPollStatus
        });
        WpsPollClient.start();
        QPLog('main', 'initTaskpane: WpsPollClient.start() 已调用 (poll=' + alloc.port + ')');
      });

      // 4. ACP 客户端：连接 + 会话管理
      AcpClient.onConnectionChange(onAcpConnChange);
      AcpClient.onResponse(onAcpResponse);
      AcpClient.onSessionUpdate(onAcpSessionUpdate);
      AcpClient.onRequest(onAcpRequest);
      AcpClient.connect();
      QPLog('main', 'initTaskpane: AcpClient.connect() 已调用');
    });
  }

  // ── P1：头部状态合并（一个状态区：ACP 连接 + WPS 桥，两级状态） ──
  // onPollStatus 每 500ms 回调一次，用 last*Shown 守卫避免重复写 DOM
  function updateStatus() {
    if (acpState !== lastAcpShown) {
      lastAcpShown = acpState;
      var label;
      if (acpState === 'connected') {
        label = '就绪';
      } else if (acpState === 'connecting') {
        label = '连接中';
      } else {
        label = '未连接';
      }
      ChatUi.setConnStateText(acpState, label);
    }
    var wps = (wpsState === 'connected') ? 'connected' : 'pending';
    if (wps !== lastWpsShown) {
      lastWpsShown = wps;
      if (wps === 'connected') {
        ChatUi.setWpsState('connected', 'WPS 已连接');
      } else {
        // P1：懒启动端口连不上 = 预期行为（首次工具调用后才监听），显示"未激活"，不显示红色"错误"
        ChatUi.setWpsState('pending', 'WPS 未激活');
      }
    }
  }

  // ── P2：中断恢复看门狗 ──
  function clearPromptTimers() {
    if (noFirstChunkTimer) { clearTimeout(noFirstChunkTimer); noFirstChunkTimer = null; }
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
  }

  function startPromptTimers() {
    clearPromptTimers();
    noFirstChunkTimer = setTimeout(onNoFirstChunkTimeout, P2_NO_FIRST_CHUNK_MS);
    activityTimer = setTimeout(onActivityTimeout, P2_ACTIVITY_MS);
  }

  function touchActivity() {
    if (activityTimer) {
      clearTimeout(activityTimer);
      activityTimer = setTimeout(onActivityTimeout, P2_ACTIVITY_MS);
    }
  }

  // P2：prompt 发出后 60s 无任何 chunk → 中断恢复
  function onNoFirstChunkTimeout() {
    QPLog('P2', 'prompt 发出 ' + (P2_NO_FIRST_CHUNK_MS / 1000) + 's 无任何 chunk，触发中断恢复');
    recoverFromInterruption('长时间未收到 AI 响应，连接可能已中断');
  }

  // P2：连续 120s 无任何下行活动（流式丢失/工具卡死）→ 中断恢复
  function onActivityTimeout() {
    QPLog('P2', '连续 ' + (P2_ACTIVITY_MS / 1000) + 's 无下行活动，触发中断恢复');
    recoverFromInterruption('AI 响应中断（长时间无数据）');
  }

  // P2：恢复 UI 状态 + 可操作错误卡片（重试/重建会话）
  function recoverFromInterruption(reason) {
    if (!waitingResponse) return;
    QPLog('P2', '中断恢复: ' + reason);
    var reqId = lastPromptReqId;
    if (reqId !== null && pendingRequests[reqId]) {
      delete pendingRequests[reqId];
    }
    lastPromptReqId = null;
    waitingResponse = false;
    gotFirstChunk = false;
    clearPromptTimers();
    var cards = pendingToolCards.slice();
    pendingToolCards = [];
    for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'error');
    ChatUi.hideTyping();
    ChatUi.setInputEnabled(true);
    ChatUi.setBusy(false);
    ChatUi.addErrorCard('连接中断', reason + '。可重试当前消息或重建会话。', { retry: true, rebuild: true });
    ChatUi.setStatus('对话中断');
    streamBuffer = '';
  }

  // ── P2：错误卡片按钮动作 ──
  function onRetry() {
    QPLog('P2', '用户点击"重试"');
    if (lastUserText) onUserSend(lastUserText);
  }

  function onRebuild() {
    QPLog('P2', '用户点击"重建会话"');
    if (acpSessionId) {
      var cid = AcpClient.send('session/close', { sessionId: acpSessionId });
      if (cid !== null) pendingRequests[cid] = { method: 'session/close' };
    }
    acpSessionId = null;
    ensureSession();
  }

  // ── P5：中止执行 ──
  function onStop() {
    QPLog('P5', '用户点击"停止"');
    if (!waitingResponse) return;
    var reqId = lastPromptReqId;
    if (reqId !== null && pendingRequests[reqId]) {
      delete pendingRequests[reqId];
    }
    lastPromptReqId = null;
    waitingResponse = false;
    gotFirstChunk = false;
    clearPromptTimers();
    var cards = pendingToolCards.slice();
    pendingToolCards = [];
    for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'cancelled');
    ChatUi.hideTyping();
    ChatUi.setInputEnabled(true);
    ChatUi.setBusy(false);
    ChatUi.addMessage('system', '已停止');
    ChatUi.setStatus('已停止');
    streamBuffer = '';
    if (acpSessionId) {
      // qwenpaw acp 支持 cancel 方法（ACP 协议 session/cancel）；若协议不支持也无妨：
      // 已置 waitingResponse=false，后续流式输出一律丢弃（P5 退化路径）。
      var cid = AcpClient.send('session/cancel', { sessionId: acpSessionId });
      QPLog('P5', '已发送 session/cancel id=' + cid);
    }
  }

  // ── ACP 连接状态 ──
  function onAcpConnChange(state) {
    QPLog('main', 'ACP 连接状态变化: ' + state);
    acpState = (state === 'connected') ? 'connected' : (state === 'connecting') ? 'connecting' : 'disconnected';
    updateStatus();
    if (state === 'connected') {
      syncPollPort();  // 重连时同步权威端口（覆盖初始分配失败/bridge 重启场景）
      ensureSession();
    } else if (state === 'disconnected') {
      acpSessionId = null;
      ChatUi.setStatus('ACP: 未连接');
    }
  }

  // 连接后创建会话（initialize 由 acp-bridge 无需显式，直接 session/new）
  function ensureSession() {
    if (acpSessionId) return;
    var id = AcpClient.send('session/new', {
      cwd: SESSION_CWD,
      mcpServers: MCP_SERVERS
    });
    if (id !== null) {
      pendingRequests[id] = { method: 'session/new' };
      QPLog('main', 'ensureSession: 发送 session/new id=' + id + ' (cwd=' + SESSION_CWD + ', mcpServers=' + MCP_SERVERS.length + ')');
      ChatUi.setStatus('ACP: 创建会话…');
    } else {
      QPLog('main', 'ensureSession: session/new 发送失败（未连接）');
    }
  }

  // ── ACP 响应处理 ──
  function onAcpResponse(id, result, error) {
    var req = pendingRequests[id];
    if (!req) return;
    QPLog('main', 'ACP 响应 id=' + id + ' method=' + req.method + (error ? ' error=' + JSON.stringify(error).slice(0, 200) : ''));

    if (req.method === 'session/new') {
      if (error) {
        ChatUi.setStatus('ACP: 会话创建失败');
        ChatUi.addMessage('error', '会话创建失败: ' + (error.message || JSON.stringify(error)));
      } else if (result && result.sessionId) {
        acpSessionId = result.sessionId;
        QPLog('main', 'session/new 成功 sessionId=' + acpSessionId);
        ChatUi.setStatus('就绪');
      }
    } else if (req.method === 'session/prompt') {
      // 完整响应到达：流式结束，收尾 assistant 消息
      waitingResponse = false;
      gotFirstChunk = false;
      clearPromptTimers();
      lastPromptReqId = null;
      ChatUi.finishAssistant();
      ChatUi.hideTyping();
      ChatUi.setInputEnabled(true);
      ChatUi.setBusy(false);
      var cards = pendingToolCards.slice();
      pendingToolCards = [];
      if (error) {
        // 会话可能已失效（如 bridge/qwenpaw 重启）：清除旧 sessionId 并重建
        QPLog('P2', 'session/prompt 错误 -> 重建会话: ' + JSON.stringify(error).slice(0, 200));
        for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'error');
        ChatUi.addErrorCard('对话中断', (error.message || JSON.stringify(error)) + '。可重试当前消息或重建会话。', { retry: true, rebuild: true });
        acpSessionId = null;
        ensureSession();
        ChatUi.setStatus('ACP: 会话重建中…');
      } else {
        var stopReason = result && result.stopReason;
        QPLog('P2', 'session/prompt 结束 stopReason=' + stopReason + ' 累计流式长度=' + streamBuffer.length);
        if (stopReason === 'cancelled') {
          for (var j = 0; j < cards.length; j++) ChatUi.markToolCard(cards[j], 'cancelled');
          ChatUi.addMessage('system', '已停止');
          ChatUi.setStatus('已停止');
        } else {
          for (var k = 0; k < cards.length; k++) ChatUi.markToolCard(cards[k], 'done');
          ChatUi.setStatus('已完成');
        }
      }
      streamBuffer = '';
    } else if (req.method === 'session/close') {
      acpSessionId = null;
      ChatUi.setStatus('ACP: 会话已关闭');
    }
    delete pendingRequests[id];
  }

  // ── ACP 流式通知（session/update） ──
  function onAcpSessionUpdate(sessionId, update) {
    if (!update) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content) {
      var text = update.content.text || '';
      if (text) {
        touchActivity();
        // P5：无进行中请求（已停止/已恢复）→ 丢弃残留流式，不污染 UI
        if (!waitingResponse) {
          QPLog('P2', '丢弃残留流式 chunk');
          return;
        }
        if (!gotFirstChunk) {
          gotFirstChunk = true;
          QPLog('P2', 'first-chunk 到达');
          // P4：首个文本到达 → 工具阶段结束，进入"生成回复"阶段
          ChatUi.showTyping('正在生成回复…');
          var cards = pendingToolCards.slice();
          pendingToolCards = [];
          for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'done');
        }
        streamBuffer += text;
        ChatUi.appendAssistantChunk(text);
      }
    } else if (update.sessionUpdate === 'status_update') {
      // P4：阶段/工具调用状态（qwenpaw 若下发 status_update）；仅进行中请求时处理
      if (!waitingResponse) return;
      touchActivity();
      var st = update.status || {};
      if (st.subtype === 'tool_call' && st.toolCall) {
        var tc = st.toolCall;
        var name = tc.title || tc.tool_call_id || '工具调用';
        // 新工具调用 → 之前的工具已完成（标记 done），避免卡片滞留"调用中"
        var prev = pendingToolCards.slice();
        pendingToolCards = [];
        for (var p = 0; p < prev.length; p++) ChatUi.markToolCard(prev[p], 'done');
        ChatUi.showTyping('正在调用工具…');
        var card = ChatUi.addToolCard(name);
        pendingToolCards.push(card);
      } else if (st.subtype === 'phase' || st.subtype === 'spinner') {
        var phaseLabel = st.label || st.text || '';
        if (phaseLabel) ChatUi.showTyping(phaseLabel);
      }
    }
  }

  // ── ACP 服务端请求（如 session/request_permission） ──
  // wps 工具 policy 为 default_effect: ask（§8.1）：每次工具调用需审批。
  // MVP 阶段自动批准（allow_once，仅本次会话本次调用），并回 UI 一条系统消息提示。
  function onAcpRequest(req) {
    if (!req || !req.method) return;
    QPLog('main', '收到 ACP 服务端请求 method=' + req.method + ' id=' + req.id);
    if (req.method === 'session/request_permission') {
      var params = req.params || {};
      var options = params.options || [];
      var toolCall = params.toolCall || {};
      var toolTitle = toolCall.title || toolCall.tool_call_id || '';
      var toolArgs = toolCall.arguments || null;
      QPLog('main', 'request_permission: tool=' + toolTitle + ' options=' + JSON.stringify(options.map(function (o) { return o.optionId; })));
      // 工具审批也是下行活动：重置卡死看门狗（长工具链不误报）
      touchActivity();
      // P4：工具卡片（结构化呈现，结果状态由后续流式/响应更新）
      if (waitingResponse) {
        // 新工具调用 → 之前的工具已结束（标记 done），避免多张卡片滞留"调用中"
        var prev = pendingToolCards.slice();
        pendingToolCards = [];
        for (var p = 0; p < prev.length; p++) ChatUi.markToolCard(prev[p], 'done');
        var card = ChatUi.addToolCard(toolTitle || '工具调用', toolArgs ? JSON.stringify(toolArgs).slice(0, 200) : '');
        pendingToolCards.push(card);
        ChatUi.showTyping('正在调用工具…');
      }
      var allow = null;
      for (var i = 0; i < options.length; i++) {
        if (options[i].optionId === 'allow_once') { allow = options[i]; break; }
      }
      if (!allow && options.length > 0) allow = options[0];
      if (allow) {
        AcpClient.respond(req.id, {
          outcome: { outcome: 'selected', optionId: allow.optionId }
        });
        QPLog('main', 'request_permission: 已自动批准 ' + allow.optionId + ' (tool=' + toolTitle + ')');
      } else {
        AcpClient.respond(req.id, { outcome: { outcome: 'cancelled' } });
        QPLog('main', 'request_permission: 无可用选项，已拒绝');
      }
    }
  }

  // ── 用户发送 ──
  function onUserSend(text) {
    QPLog('P2', '用户发送: ' + text.slice(0, 100));
    if (!acpSessionId) {
      // 会话未就绪/失效（可能是 bridge 重启导致旧 sessionId 失效）：
      // 主动重建会话并提示用户重发
      ChatUi.addMessage('error', 'AI 会话未就绪，正在重建会话，请稍候重发…');
      ensureSession();
      return;
    }
    if (waitingResponse) {
      ChatUi.addMessage('system', '上一条还在处理中，请稍候…');
      return;
    }
    lastUserText = text;
    ChatUi.addMessage('user', text);
    waitingResponse = true;
    gotFirstChunk = false;
    ChatUi.setInputEnabled(false);
    ChatUi.setBusy(true);
    ChatUi.setStatus('处理中…');
    ChatUi.showTyping('思考中…');
    pendingToolCards = [];
    streamBuffer = '';
    var id = AcpClient.send('session/prompt', {
      sessionId: acpSessionId,
      prompt: [{ type: 'text', text: text }]
    });
    if (id !== null) {
      lastPromptReqId = id;
      pendingRequests[id] = { method: 'session/prompt' };
      QPLog('P2', 'prompt 已发送 id=' + id + ' sessionId=' + acpSessionId);
      startPromptTimers();
    } else {
      waitingResponse = false;
      gotFirstChunk = false;
      ChatUi.setInputEnabled(true);
      ChatUi.setBusy(false);
      ChatUi.hideTyping();
      ChatUi.addMessage('error', '发送失败：未连接 ACP');
    }
  }

  // ── 轮询命令处理（角色 B：WPS 操作执行） ──
  // 阶段 2：action -> WpsBridge 方法分发（WPS 操作全部在 wps-bridge.js，此处不写业务逻辑）。
  // 覆盖 wps-office-mcp 轮询命令契约全集（word/common/excel/ppt + execute_method 白名单路径）。
  var POLL_ACTION_MAP = {
    ping: 'ping',
    wireCheck: 'wireCheck',
    getAppInfo: 'getAppInfo',
    getActiveDocument: 'getActiveDocument',
    getSelectedText: 'getSelectedText',
    setSelectedText: 'setSelectedText',
    insertText: 'insertText',
    getDocumentText: 'getDocumentText',
    getDocumentTextByRange: 'getDocumentTextByRange',
    getDocumentParagraphs: 'getDocumentParagraphs',
    findReplace: 'findReplace',
    findInDocument: 'findInDocument',
    smartFillField: 'smartFillField',
    replaceBookmarkContent: 'replaceBookmarkContent',
    setFont: 'setFont',
    setTextColor: 'setTextColor',
    setParagraph: 'setParagraph',
    setLineSpacing: 'setLineSpacing',
    applyStyle: 'applyStyle',
    insertTable: 'insertTable',
    insertPageBreak: 'insertPageBreak',
    insertImage: 'insertImage',
    addComment: 'addComment',
    insertBookmark: 'insertBookmark',
    insertHeader: 'insertHeader',
    insertFooter: 'insertFooter',
    generateTOC: 'generateTOC',
    insertSectionBreak: 'insertSectionBreak',
    setPageSetup: 'setPageSetup',
    getOpenDocuments: 'getOpenDocuments',
    switchDocument: 'switchDocument',
    openDocument: 'openDocument',
    createDocument: 'createDocument',
    save: 'save',
    saveAs: 'saveAs',
    openFile: 'openFile',
    getActiveWorkbook: 'getActiveWorkbook',
    getCellValue: 'getCellValue',
    setCellValue: 'setCellValue',
    getActivePresentation: 'getActivePresentation'
  };

  function onPollCommand(action, params) {
    QPLog('poll', '收到命令 action=' + action + ' params=' + JSON.stringify(params).slice(0, 300));
    var t0 = Date.now();
    var result;
    try {
      var bridgeMethod = POLL_ACTION_MAP[action];
      if (bridgeMethod && typeof WpsBridge[bridgeMethod] === 'function') {
        result = WpsBridge[bridgeMethod](params || {});
      } else if (action && action.indexOf('Application.') === 0) {
        // wps_execute_method 白名单路径（如 Application.ActiveDocument.Content.Text）
        result = WpsBridge.executeMethod(action, params || {});
      } else {
        result = { success: false, data: null, error: '未支持的命令: ' + action };
      }
    } catch (e) {
      result = { success: false, data: null, error: '执行异常: ' + (e && e.message ? e.message : e) };
      QPLog('poll', '命令执行抛异常 action=' + action + ' err=' + (e && e.message ? e.message : e));
    }
    QPLog('poll', '命令完成 action=' + action + ' 耗时=' + (Date.now() - t0) + 'ms success=' + result.success + ' error=' + (result.error || ''));
    return result;
  }

  function onPollStatus(failCount, lastError) {
    if (failCount > 0) {
      QPLog('poll', 'WPS 桥轮询失败 #' + failCount + ' lastError=' + lastError);
      // P1：懒启动端口连不上 = 预期（首次工具调用后才监听），不显示"错误"
      wpsState = 'pending';
    } else {
      QPLog('poll', 'WPS 桥已连接');
      wpsState = 'connected';
    }
    updateStatus();
  }

  // ══════════════════════════════════════════════
  // ribbon 上下文：taskpane 创建/切换
  // ══════════════════════════════════════════════
  var WPS_Enum = { msoCTPDockPositionRight: 2 };
  var TASKPANE_DOCK_POSITION = WPS_Enum.msoCTPDockPositionRight;
  var taskpaneIdCache = '';

  function GetUrlPath() {
    // 实测确认：WPS CreateTaskPane 用相对路径即可
    // 相对路径相对于插件目录（manifest.xml 所在目录）
    // 注意：不能加前导 '/'，否则会被解析为根目录
    return '';
  }

  function getTaskPaneUrl() {
    // v0.8 定论：WPS Linux CreateTaskPane 加载本地文件路径空白，必须 HTTP URL。
    // 由 acp-bridge :8766 静态文件服务托管（/ui/*），与 ACP 轮询同源，无 CORS 问题。
    return 'http://127.0.0.1:8766/ui/taskpane.html';
  }

  function errMsg(e) {
    return (e && e.message ? e.message : e);
  }

  function setTaskPaneDockPosition(tp) {
    if (!tp) return false;
    try {
      tp.DockPosition = TASKPANE_DOCK_POSITION;
      return true;
    } catch (e) {
      console.error('[main] 设置任务窗格停靠位置失败: ' + errMsg(e));
      return false;
    }
  }

  function createTaskPane() {
    QPLog('main', 'createTaskPane: 尝试创建任务窗格 url=' + getTaskPaneUrl());
    try {
      var tp = window.Application.CreateTaskPane(getTaskPaneUrl());
      if (!tp) {
        QPLog('main', 'createTaskPane: CreateTaskPane 返回空对象');
        console.error('[main] 创建任务窗格失败: CreateTaskPane 返回空对象');
        return null;
      }
      if (tp.ID) {
        taskpaneIdCache = tp.ID;
        QPLog('main', 'createTaskPane: 创建成功 ID=' + tp.ID);
        try {
          window.Application.PluginStorage.setItem('taskpane_id', tp.ID);
        } catch (e) {
          console.error('[main] 保存 taskpane_id 失败: ' + errMsg(e));
        }
      }
      if (!setTaskPaneDockPosition(tp)) {
        console.error('[main] 任务窗格停靠校正失败（窗格仍可用）');
      }
      try {
        tp.Visible = true;
      } catch (e) {
        console.error('[main] 设置任务窗格可见失败: ' + errMsg(e));
      }
      return tp;
    } catch (e) {
      QPLog('main', 'createTaskPane 异常: ' + errMsg(e));
      console.error('[main] 初始化任务窗格失败: ' + errMsg(e));
      return null;
    }
  }

  // ribbon onLoad 回调
  window.OnAddinLoad = function (ui) {
    ribbonUI = ui;
    QPLog('main', '加载项已加载 (ribbon)');
    console.log('[main] WPS QwenPaw AI 加载项已加载 (ribbon)');
    // 不自动打开侧边栏：启动时文档/CEF 引擎未就绪，自动 CreateTaskPane 会得到空白窗格，
    // 且其 ID 被缓存后，后续点按钮会复用空白窗格（表现为"按钮没反应"）。由用户点击 ribbon 按钮打开。
    return true;
  };

  // 按钮：打开/切换侧边栏
  // 总是新建正确的对话窗格（不复用可能为空白/失效的旧窗格）；先隐藏旧窗格避免堆积。
  window.OnShowTaskPane = function () {
    if (taskpaneIdCache) {
      try {
        var old = window.Application.GetTaskPane(taskpaneIdCache);
        if (old) { old.Visible = false; }
      } catch (e) {}
    }
    createTaskPane();
    if (ribbonUI) {
      try { ribbonUI.Invalidate(); } catch (e) {}
    }
    return true;
  };

  // 按钮：状态（只读诊断，不创建/切换窗格；打开侧边栏请用"AI 侧边栏"按钮）
  window.OnStatusClick = function () {
    var info = '=== QwenPaw AI 状态 ===\n\n';
    info += '侧边栏 URL: ' + getTaskPaneUrl() + '\n';
    info += '侧边栏 ID 缓存: ' + (taskpaneIdCache || '(无)') + '\n';
    info += '任务窗格上下文: ' + (isTaskpane ? '是' : '否') + '\n';
    try {
      var existing = null;
      if (taskpaneIdCache) {
        existing = window.Application.GetTaskPane(taskpaneIdCache);
      }
      info += 'GetTaskPane(缓存): ' + (existing ? '存在' : '不存在/无效') + '\n';
    } catch (e) {
      info += 'GetTaskPane 异常: ' + errMsg(e) + '\n';
    }
    info += 'ActiveDocument: ' + (window.Application && window.Application.ActiveDocument ? '存在' : '不存在') + '\n\n';
    info += '提示：点击 ribbon 的「AI 侧边栏」按钮打开对话侧边栏。';
    alert(info);
    return true;
  };

  // ══════════════════════════════════════════════
  // 对外接口（ARCHITECTURE §4.3）
  // ══════════════════════════════════════════════
  function init() {
    if (isTaskpane) {
      initTaskpane();
    }
  }

  function sendUserMessage(text) {
    onUserSend(text);
  }

  function closeSession() {
    if (acpSessionId) {
      AcpClient.send('session/close', { sessionId: acpSessionId });
    }
    WpsPollClient.stop();
    AcpClient.disconnect();
    releasePollPort();
  }

  // taskpane 页面 DOM 就绪后初始化；ribbon 环境则只注册回调
  if (isTaskpane) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // 暴露到全局供 WPS / 调试使用
  window.QwenPawAddon = {
    init: init,
    sendUserMessage: sendUserMessage,
    closeSession: closeSession
  };
})();
