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

  // wps-office-mcp MCP 服务器（§5.1 + §13 v0.17 路线 P）：
  // 走 stdio（QwenPaw 每 ACP session spawn 独立 wps-mcp 子进程），bridge 集中分配独立 poll 端口
  // （WPS_POLL_PORT env 注入，59000+ 段，多窗口并发不抢 :58891、不串台）。
  // env 是 [{name,value}] 列表（ACP schema: McpServerStdio.env = List[EnvVariable]），
  // 端口值由 bridge /poll-port/allocate 分配后覆盖（bridge 转发 session/new 时也会强制注入权威值）。
  var MCP_SERVERS = [{
    name: 'wps',
    command: 'node',
    args: ['/data/myrepo/opencode-wps/wps-office-mcp/dist/index.js'],
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

  // ══════════════════════════════════════════════
  // taskpane 上下文：聊天 + ACP + 轮询
  // ══════════════════════════════════════════════
  function initTaskpane() {
    QPLog('main', 'initTaskpane: 初始化聊天 UI + ACP + 轮询客户端');
    // 1. 聊天 UI
    ChatUi.init({ onSend: onUserSend });

    // 2. 路线 P：异步分配 poll 端口（与 ACP 连接并行）。bridge 是唯一分配者且幂等：
    //    即使 session/new 先于分配完成发出，bridge 也会按该 client 幂等分配同一端口，无竞态。
    allocatePollPort(function (alloc) {
      WpsPollClient.init({
        serverUrl: 'http://127.0.0.1:' + alloc.port,
        handler: onPollCommand,
        onStatus: onPollStatus
      });
      WpsPollClient.start();
      QPLog('main', 'initTaskpane: WpsPollClient.start() 已调用 (poll=' + alloc.port + ')');
      ChatUi.setStatus('WPS 桥: 轮询中');
    });

    // 3. ACP 客户端：连接 + 会话管理
    AcpClient.onConnectionChange(onAcpConnChange);
    AcpClient.onResponse(onAcpResponse);
    AcpClient.onSessionUpdate(onAcpSessionUpdate);
    AcpClient.onRequest(onAcpRequest);
    AcpClient.connect();
    QPLog('main', 'initTaskpane: AcpClient.connect() 已调用');
  }

  // ── ACP 连接状态 ──
  function onAcpConnChange(state) {
    QPLog('main', 'ACP 连接状态变化: ' + state);
    ChatUi.setConnState(state === 'connected');
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
        ChatUi.setStatus('ACP: 已连接（' + acpSessionId.slice(0, 8) + '…）');
      }
    } else if (req.method === 'session/prompt') {
      // 完整响应到达：流式结束，收尾 assistant 消息
      waitingResponse = false;
      ChatUi.finishAssistant();
      ChatUi.setInputEnabled(true);
      if (error) {
        // 会话可能已失效（如 bridge/qwenpaw 重启）：清除旧 sessionId 并重建
        QPLog('main', 'session/prompt 错误 -> 重建会话: ' + JSON.stringify(error).slice(0, 200));
        ChatUi.addMessage('error', '发送失败: ' + (error.message || JSON.stringify(error)) + '（正在重建会话）');
        acpSessionId = null;
        ensureSession();
        ChatUi.setStatus('ACP: 会话重建中…');
      } else {
        var stopReason = result && result.stopReason;
        QPLog('main', 'session/prompt 结束 stopReason=' + stopReason + ' 累计流式长度=' + streamBuffer.length);
        ChatUi.setStatus(stopReason === 'end_turn' ? 'ACP: 已完成' : 'ACP: 已停止');
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
        streamBuffer += text;
        ChatUi.appendAssistantChunk(text);
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
      var toolTitle = (params.toolCall && params.toolCall.title) || '';
      QPLog('main', 'request_permission: tool=' + toolTitle + ' options=' + JSON.stringify(options.map(function (o) { return o.optionId; })));
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
        ChatUi.addMessage('system', '🔓 已批准工具调用' + (toolTitle ? ': ' + toolTitle : ''));
      } else {
        AcpClient.respond(req.id, { outcome: { outcome: 'cancelled' } });
        QPLog('main', 'request_permission: 无可用选项，已拒绝');
        ChatUi.addMessage('system', '已拒绝工具调用');
      }
    }
  }

  // ── 用户发送 ──
  function onUserSend(text) {
    QPLog('main', '用户发送: ' + text.slice(0, 100));
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
    ChatUi.addMessage('user', text);
    waitingResponse = true;
    ChatUi.setInputEnabled(false);
    ChatUi.setStatus('ACP: 处理中…');
    streamBuffer = '';
    var id = AcpClient.send('session/prompt', {
      sessionId: acpSessionId,
      prompt: [{ type: 'text', text: text }]
    });
    if (id !== null) {
      pendingRequests[id] = { method: 'session/prompt' };
      QPLog('main', 'session/prompt 已发送 id=' + id + ' sessionId=' + acpSessionId);
    } else {
      waitingResponse = false;
      ChatUi.setInputEnabled(true);
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
      ChatUi.setStatus('WPS 桥: 重连中 (' + failCount + ' 次失败' + (lastError ? ': ' + lastError : '') + ')');
    } else {
      ChatUi.setStatus('WPS 桥: 已连接');
    }
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
