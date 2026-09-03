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

  // ── 阶段 3 批 2：P8 文档隔离 / P15 历史缓存 / P3 agent 选择 ──
  var currentDocId = null;           // 当前活动文档 id（会话隔离 key）
  var docStates = {};                // docId -> {acpSessionId, messages}
  var persistTimer = null;           // P15：历史落盘防抖
  var agentList = [];                // P3：可用 agent 列表
  var agentCached = null;            // P3：localStorage 记住的上次 agent
  var docCheckTimer = null;          // P8：活动文档检测间隔
  var DOC_CHECK_MS = 3000;           // P8：活动文档检测周期
  var pendingAttachments = [];       // P6：待发送附件 [{name, text}]（文本提取；图片为 {name, image:true} 占位）
  var MAX_ATTACH_TEXT = 60000;       // P6：单个附件文本上限（超出截断）

  // P8 文档隔离 key：优先用轻量 getDocIdentity（只读 Name/Path，不触发 Paragraphs 计数，
  // 因为 startDocCheck 每 3s 调用一次，重计数会卡 WPS）；回退默认 'default'。
  function getDocId() {
    try {
      if (typeof WpsBridge !== 'undefined' && WpsBridge.getDocIdentity) {
        var info = WpsBridge.getDocIdentity();
        if (info && info.name) {
          return ((info.appType || 'doc') + ':' + (info.path || '') + ':' + info.name);
        }
      } else if (typeof WpsBridge !== 'undefined' && WpsBridge.getActiveDocumentInfo) {
        var info2 = WpsBridge.getActiveDocumentInfo();
        if (info2 && info2.name) {
          return ((info2.appType || 'doc') + ':' + (info2.path || '') + ':' + info2.name);
        }
      }
    } catch (e) {}
    return 'default';
  }

  function historyKey(docId) { return 'qp.history.' + (docId || 'default'); }
  function sessionKey(docId) { return 'qp.session.' + (docId || 'default'); }
  function agentKey() { return 'qp.agent'; }

  function loadHistory(docId) {
    try {
      var raw = localStorage.getItem(historyKey(docId));
      return (raw && JSON.parse(raw)) || [];
    } catch (e) { return []; }
  }

  function saveHistory(docId, msgs) {
    try {
      localStorage.setItem(historyKey(docId), JSON.stringify((msgs || []).slice(-200)));
    } catch (e) {}
  }

  function loadCachedSessionId(docId) {
    try { return localStorage.getItem(sessionKey(docId)) || null; } catch (e) { return null; }
  }

  function saveCachedSessionId(docId, sid) {
    try {
      if (sid) localStorage.setItem(sessionKey(docId), sid);
      else localStorage.removeItem(sessionKey(docId));
    } catch (e) {}
  }

  // P15：消息变更后防抖落盘（localStorage，按 docId）
  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      persistTimer = null;
      if (!currentDocId) return;
      saveHistory(currentDocId, ChatUi.snapshot());
    }, 600);
  }

  // P8：保存当前文档状态到内存
  function saveDocState() {
    if (!currentDocId) return;
    docStates[currentDocId] = {
      acpSessionId: acpSessionId,
      messages: ChatUi.snapshot()
    };
    saveHistory(currentDocId, ChatUi.snapshot());
  }

  // P8：切换到目标文档（保存当前状态 → 恢复目标状态 → 重建/复用会话）
  function switchToDoc(docId) {
    if (docId === currentDocId) return;
    QPLog('P8', '文档切换: ' + currentDocId + ' -> ' + docId);
    saveDocState();
    // 清理当前进行中的请求（与 P5 停止逻辑一致）
    if (waitingResponse) {
      var reqId = lastPromptReqId;
      if (reqId !== null && pendingRequests[reqId]) delete pendingRequests[reqId];
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
      streamBuffer = '';
    }
    currentDocId = docId;
    pendingAttachments = []; // P8：切换文档时清空未发送的待选附件（不串台）
    var st = docStates[docId];
    if (st && st.messages && st.messages.length) {
      ChatUi.restore(st.messages);
      acpSessionId = st.acpSessionId || null;
    } else {
      var hist = loadHistory(docId);
      ChatUi.restore(hist);
      if (!hist.length) ChatUi.showEmptyHint();
      acpSessionId = null;
    }
    QPLog('P8', '切换到文档 ' + docId + '，恢复会话=' + acpSessionId + ' 历史条数=' + (ChatUi.snapshot().length));
    ChatUi.setStatus(acpSessionId ? '就绪' : '加载会话…');
    if (acpState === 'connected') {
      if (!acpSessionId) ensureSession();
    }
  }

  // P8：周期检测活动文档变化（同一 taskpane 实例内多文档隔离；每文档独立 taskpane 时是 no-op）
  function startDocCheck() {
    if (docCheckTimer) return;
    docCheckTimer = setInterval(function () {
      var id;
      try { id = getDocId(); } catch (e) { return; }
      if (id && id !== currentDocId) switchToDoc(id);
    }, DOC_CHECK_MS);
  }

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

  // ── P3：agent 列表加载与切换 ──
  // bridge /agents 返回可用 agent 列表（qwenpaw agent list）；/agent/set 切换（重启 qwenpaw acp 子进程）。
  // 前端 localStorage 记住上次选择，刷新/重启自动回填。agent 切换后旧 sessionId 失效 → 重建会话。
  function loadAgentList() {
    var el = document.getElementById('agentSelect');
    if (!el) return;
    try { agentCached = localStorage.getItem(agentKey()) || null; } catch (e) {}
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://127.0.0.1:8766/agents', true);
      xhr.timeout = 5000;
      xhr.onload = function () {
        if (xhr.status !== 200) return;
        try {
          var r = JSON.parse(xhr.responseText);
          agentList = r.agents || [];
          var cur = r.current || null;
          // 记住的上次选择优先；否则用 bridge 当前 agent
          var target = agentCached || cur;
          populateAgentSelect(el, agentList, target);
          if (agentCached && agentCached !== cur) {
            QPLog('P3', '上次选择 agent=' + agentCached + ' 与 bridge 当前=' + cur + ' 不一致，请求切换');
            switchAgent(agentCached);
          }
        } catch (e) {}
      };
      xhr.onerror = function () {};
      xhr.ontimeout = function () {};
      xhr.send();
    } catch (e) {}
  }

  function populateAgentSelect(el, agents, selected) {
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!agents || !agents.length) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = '(无可用 agent)';
      el.appendChild(none);
      return;
    }
    for (var i = 0; i < agents.length; i++) {
      var opt = document.createElement('option');
      opt.value = agents[i].id;
      opt.textContent = agents[i].name + (agents[i].id !== agents[i].name ? ' (' + agents[i].id + ')' : '');
      opt.title = agents[i].description || '';
      if (selected && selected === agents[i].id) opt.selected = true;
      el.appendChild(opt);
    }
  }

  function switchAgent(agentId) {
    if (!agentId) return;
    QPLog('P3', '切换 agent: ' + agentId);
    try { localStorage.setItem(agentKey(), agentId); } catch (e) {}
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'http://127.0.0.1:8766/agent/set?agent=' + encodeURIComponent(agentId), true);
    xhr.timeout = 10000;
    xhr.onload = function () {
      var ok = false;
      try { ok = xhr.status === 200 && JSON.parse(xhr.responseText).ok; } catch (e) {}
      if (ok) {
        QPLog('P3', 'agent 切换成功，重建会话');
        ChatUi.addMessage('system', '已切换到 agent「' + agentId + '」，正在重建会话…');
        // 旧 sessionId 随子进程重启失效：清当前会话状态 + 内存/缓存，重建。
        // 同步清 docStates 的 messages 与 localStorage 历史：新 agent = 全新会话无记忆，
        // 若保留旧消息，切走再切回会显示死会话的旧记录（P15「用户看得见但 AI 不记得 = 误导」）。
        acpSessionId = null;
        saveCachedSessionId(currentDocId, null);
        if (currentDocId) {
          docStates[currentDocId] = { acpSessionId: null, messages: [] };
          saveHistory(currentDocId, []);
        }
        ChatUi.clear();
        ChatUi.showEmptyHint();
        if (acpState === 'connected') ensureSession();
      } else {
        QPLog('P3', 'agent 切换失败 HTTP ' + xhr.status);
        ChatUi.addMessage('error', 'agent 切换失败');
      }
    };
    xhr.onerror = function () {
      ChatUi.addMessage('error', 'agent 切换失败（bridge 不可达）');
    };
    xhr.send();
  }

  // P14：清空对话按钮（确认弹窗）
  function bindClearButton() {
    var btn = document.getElementById('clearBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (window.confirm('确定要清空当前对话历史吗？此操作不可恢复。')) {
        clearCurrentSession();
      }
    });
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
      onRebuild: onRebuild,
      onClearCommand: clearCurrentSession
    });
    // P3：agent 下拉切换（localStorage 记住）；P14：清空对话按钮
    var agentSelect = document.getElementById('agentSelect');
    if (agentSelect) {
      agentSelect.addEventListener('change', function () {
        if (agentSelect.value && agentSelect.value !== agentCached) {
          switchAgent(agentSelect.value);
        }
      });
    }
    bindClearButton();
    bindAttachButton(); // P6：附件上传
    tryAutoExpand();    // P7：自动展开侧边栏（尽力而为）
    // P1：初始状态（启动握手：ACP 连接中 + WPS 未激活）
    updateStatus();

    // P8/P15：确定当前文档 id，恢复该文档的历史消息（前端缓存）
    currentDocId = getDocId();
    var cachedMsgs = loadHistory(currentDocId);
    if (cachedMsgs && cachedMsgs.length) {
      ChatUi.restore(cachedMsgs);
      QPLog('P15', '恢复文档 ' + currentDocId + ' 历史 ' + cachedMsgs.length + ' 条');
    } else {
      ChatUi.showEmptyHint();
    }
    startDocCheck();

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

      // P3：加载可用 agent 列表（从 bridge /agents），初始化下拉选择
      loadAgentList();

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

  // ── P7：自动展开侧边栏（尽力而为） ──
  // WPS 无官方文档化"自动展开 taskpane 到最大宽度" API；CreateTaskPane 不接收宽高参数。
  // 尽力尝试 ResizeWindow（若存在）。注意：taskpane 的 window.innerWidth 是侧边栏自身宽度，
  // 不能作为目标宽度参考（否则 30% 会把侧边栏缩得更小）——用屏幕可用宽度估算，且只增不减。
  function tryAutoExpand() {
    try {
      if (typeof window !== 'undefined' && window.Application && typeof window.Application.ResizeWindow === 'function') {
        var screenW = (typeof window.screen !== 'undefined' && window.screen.availWidth) ? window.screen.availWidth : 1440;
        var currentW = (typeof window.innerWidth === 'number') ? window.innerWidth : 0;
        // 目标 = 屏幕的 30%（合理侧边栏宽度），且不小于当前宽度（只展开不缩小）
        var target = Math.max(320, Math.floor(screenW * 0.3), currentW || 0);
        var h = window.innerHeight || 800;
        window.Application.ResizeWindow(target, h);
        QPLog('P7', '自动展开侧边栏: ' + target + 'x' + h + '（当前 ' + currentW + '）');
      } else {
        QPLog('P7', 'WPS 不支持 ResizeWindow，跳过自动展开（平台限制）');
      }
    } catch (e) {
      QPLog('P7', '自动展开失败（平台限制）: ' + (e && e.message ? e.message : e));
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
    // 任何下行活动（文本 chunk / status_update / request_permission）都证明请求仍存活：
    // 同时重置两个看门狗。尤其工具链场景（每次工具调用都有 request_permission 下行），
    // 首个文本 chunk 可能晚于 60s 才到达——只重置 activityTimer 会让 noFirstChunkTimer
    // 误报中断（P2 真实工具链假阳性）。
    if (activityTimer) {
      clearTimeout(activityTimer);
      activityTimer = setTimeout(onActivityTimeout, P2_ACTIVITY_MS);
    }
    if (noFirstChunkTimer) {
      clearTimeout(noFirstChunkTimer);
      noFirstChunkTimer = setTimeout(onNoFirstChunkTimeout, P2_NO_FIRST_CHUNK_MS);
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
    schedulePersist(); // P15：中断时保留已收到的部分回复
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
    saveCachedSessionId(currentDocId, null);
    if (currentDocId && docStates[currentDocId]) {
      docStates[currentDocId].acpSessionId = null; // 防切走再切回恢复死 session
    }
    ensureSession();
  }

  // ── P13/P14：清空当前会话（/clear 指令 + "清空对话"按钮共用） ──
  function clearCurrentSession() {
    QPLog('P14', '清空当前会话 docId=' + currentDocId);
    if (acpSessionId) {
      var cid = AcpClient.send('session/close', { sessionId: acpSessionId });
      if (cid !== null) pendingRequests[cid] = { method: 'session/close' };
    }
    acpSessionId = null;
    saveCachedSessionId(currentDocId, null);
    ChatUi.clear();
    ChatUi.showEmptyHint();
    ChatUi.setStatus('会话已清空');
    streamBuffer = '';
    pendingAttachments = []; // P14：清空未发送的待选附件
    waitingResponse = false;
    gotFirstChunk = false;
    clearPromptTimers();
    lastPromptReqId = null;
    var cards = pendingToolCards.slice();
    pendingToolCards = [];
    for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'cancelled');
    ChatUi.hideTyping();
    ChatUi.setInputEnabled(true);
    ChatUi.setBusy(false);
    docStates[currentDocId] = { acpSessionId: null, messages: [] };
    saveHistory(currentDocId, []);
    if (acpState === 'connected') ensureSession();
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
    schedulePersist(); // P15：停止时保留已收到的部分回复
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

  // 连接后创建/复用会话（initialize 由 acp-bridge 无需显式）。
  // P15：同一文档重开时优先 session/load 复用缓存的 sessionId（恢复 AI 上下文记忆），
  // 无缓存才 session/new。sessionId 按 docId 持久化在 localStorage（qp.session.<docId>）。
  function ensureSession() {
    if (acpSessionId) return;
    // 已有在途的 session/new 或 session/load：不重复发送（防 onAcpConnChange 重入/onUserSend 竞态）
    for (var k in pendingRequests) {
      if (pendingRequests[k] && (pendingRequests[k].method === 'session/new' || pendingRequests[k].method === 'session/load')) {
        return;
      }
    }
    var cachedSid = loadCachedSessionId(currentDocId);
    var method = cachedSid ? 'session/load' : 'session/new';
    var params = {
      cwd: SESSION_CWD,
      mcpServers: MCP_SERVERS
    };
    if (cachedSid) params.sessionId = cachedSid;
    var id = AcpClient.send(method, params);
    if (id !== null) {
      pendingRequests[id] = { method: method };
      QPLog('main', 'ensureSession: 发送 ' + method + ' id=' + id + ' (cwd=' + SESSION_CWD + ', mcpServers=' + MCP_SERVERS.length + (cachedSid ? ', cachedSid=' + cachedSid : '') + ')');
      ChatUi.setStatus(cachedSid ? 'ACP: 恢复会话…' : 'ACP: 创建会话…');
    } else {
      QPLog('main', 'ensureSession: ' + method + ' 发送失败（未连接）');
    }
  }

  // ── ACP 响应处理 ──
  function onAcpResponse(id, result, error) {
    var req = pendingRequests[id];
    if (!req) return;
    QPLog('main', 'ACP 响应 id=' + id + ' method=' + req.method + (error ? ' error=' + JSON.stringify(error).slice(0, 200) : ''));

    if (req.method === 'session/new' || req.method === 'session/load') {
      if (error) {
        if (req.method === 'session/load') {
          // 旧 sessionId 失效（bridge/qwenpaw 重启）：清缓存回退 session/new，这是预期降级
          QPLog('P15', 'session/load 失败，清缓存重建: ' + JSON.stringify(error).slice(0, 150));
          saveCachedSessionId(currentDocId, null);
          ChatUi.addMessage('system', '上次会话已失效，正在创建新会话…');
          if (!acpSessionId) ensureSession(); // 回退 session/new
        } else {
          ChatUi.setStatus('ACP: 会话创建失败');
          ChatUi.addMessage('error', '会话创建失败: ' + (error.message || JSON.stringify(error)));
        }
      } else if (result && result.sessionId) {
        acpSessionId = result.sessionId;
        saveCachedSessionId(currentDocId, acpSessionId);
        QPLog('main', req.method + ' 成功 sessionId=' + acpSessionId);
        ChatUi.setStatus('就绪');
      } else if (req.method === 'session/load' && loadCachedSessionId(currentDocId)) {
        // session/load 成功但未返回 sessionId：复用请求时用的缓存 id
        acpSessionId = loadCachedSessionId(currentDocId);
        QPLog('P15', 'session/load 成功（未回 sessionId，复用缓存）=' + acpSessionId);
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
      schedulePersist(); // P15：本轮结束落盘历史
    } else if (req.method === 'session/close') {
      acpSessionId = null;
      saveCachedSessionId(currentDocId, null); // P15：关闭会话同步清 sessionId 缓存
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
        schedulePersist(); // P15：流式过程中防抖落盘
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
  // ── P6：附件上传（文件/图片）──
  // V1 已核实：QwenPaw ACP session/prompt 只提取 prompt 块的 text（_extract_text 无多模态）。
  // → 文本文件提取为文本原样传给 qwenpaw；图片/二进制暂不支持（占位提示，不假装能看）。
  function bindAttachButton() {
    var btn = document.getElementById('attachBtn');
    var fileInput = document.getElementById('attachFile');
    if (!btn || !fileInput) return;
    btn.addEventListener('click', function () {
      fileInput.click();
    });
    fileInput.addEventListener('change', function () {
      handleAttachFiles(fileInput.files);
      fileInput.value = '';
    });
    // P6-G：粘贴图片识别（剪贴板有图片时提示占位；文本粘贴走默认行为）
    var input = document.getElementById('input');
    if (input) {
      input.addEventListener('paste', function (e) {
        var items = (e.clipboardData && e.clipboardData.items) || [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].type && items[i].type.indexOf('image') === 0) {
            e.preventDefault();
            ChatUi.addMessage('system', '已检测到剪贴板图片，但当前 ACP 仅支持文本，暂不能上传图片。请把图片内容粘贴为文字。');
            return;
          }
        }
      });
    }
  }

  function handleAttachFiles(files) {
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) {
      (function (file) {
        var name = file.name || '附件';
        if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(name)) {
          // V1：图片无法原样传 qwenpaw（ACP 无多模态），占位提示
          ChatUi.addMessage('system', '图片「' + name + '」暂不支持上传（当前 ACP 仅支持文本），请把内容粘贴为文字。');
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || '');
          if (text.length > MAX_ATTACH_TEXT) {
            text = text.slice(0, MAX_ATTACH_TEXT) + '\n…[内容过长已截断]';
          }
          pendingAttachments.push({ name: name, text: text });
          ChatUi.addMessage('system', '已添加附件：' + name + '（' + text.length + ' 字符）');
          QPLog('P6', '附件已就绪: ' + name + ' len=' + text.length);
        };
        reader.onerror = function () {
          ChatUi.addMessage('system', '读取附件「' + name + '」失败');
        };
        reader.readAsText(file);
      })(files[i]);
    }
  }

  // P6：把主文本 + 附件组装成 prompt blocks（[{"type":"text","text":...}]）
  function buildPromptBlocks(text) {
    var blocks = [{ type: 'text', text: text }];
    for (var i = 0; i < pendingAttachments.length; i++) {
      var att = pendingAttachments[i];
      if (!att || att.image) continue;
      blocks.push({
        type: 'text',
        text: '【附件：' + att.name + '】\n' + att.text
      });
    }
    return blocks;
  }

  function onUserSend(text) {
    QPLog('P2', '用户发送: ' + text.slice(0, 100) + (pendingAttachments.length ? '（附件 ' + pendingAttachments.length + ' 个）' : ''));
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
    if (pendingAttachments.length) {
      for (var a = 0; a < pendingAttachments.length; a++) {
        if (!pendingAttachments[a].image) {
          ChatUi.addMessage('system', '附件已随消息发送：' + pendingAttachments[a].name);
        }
      }
      pendingAttachments = [];
    }
    schedulePersist();
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
      prompt: buildPromptBlocks(text)
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

  // P11：需要结构化结果反馈的命令（写操作/有结果的操作；只读查询不刷屏）
  var FEEDBACK_ACTIONS = {
    setSelectedText: '替换选中文本',
    insertText: '插入文本',
    findReplace: '查找替换',
    findInDocument: '查找',
    setFont: '设置字体',
    setTextColor: '设置文字颜色',
    setParagraph: '设置段落格式',
    setLineSpacing: '设置行距',
    applyStyle: '应用样式',
    insertTable: '插入表格',
    insertPageBreak: '插入分页符',
    insertImage: '插入图片',
    addComment: '添加批注',
    insertBookmark: '插入书签',
    insertHeader: '插入页眉',
    insertFooter: '插入页脚',
    generateTOC: '生成目录',
    insertSectionBreak: '插入分节符',
    setPageSetup: '设置页面',
    setCellValue: '写入单元格',
    save: '保存文档',
    saveAs: '另存为'
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
    // P11：写操作/有结果操作给结构化侧边栏反馈（操作类型 + 结果摘要），只读查询不刷屏
    if (FEEDBACK_ACTIONS[action] && isTaskpane) {
      try {
        if (result && result.success) {
          var summary = result.data && result.data.summary ? result.data.summary : '';
          var detail = result.data && result.data.count !== undefined ? '（' + result.data.count + ' 处）' : '';
          ChatUi.addMessage('system', '✅ ' + FEEDBACK_ACTIONS[action] + (summary ? '：' + summary : '') + detail);
        } else {
          ChatUi.addMessage('system', '❌ ' + FEEDBACK_ACTIONS[action] + '失败：' + ((result && result.error) || '未知错误'));
        }
        schedulePersist();
      } catch (e) {}
    }
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
