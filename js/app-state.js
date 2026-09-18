/**
 * app-state.js — 全局状态容器（从 main.js 拆出，最先生加载）
 *
 * 模块边界（ARCHITECTURE §4.2）：本文件是加载项「控制器层」的单一状态源，
 * 零 DOM/ACP/聊天 UI 业务逻辑（除 isTaskpane 检测与 localStorage 持久化工具）。
 * 所有可变状态集中在 QP.state，配置/常量/工具函数挂在 QP 上，供其余控制器模块共享：
 *   各控制器文件顶部 `var S = QP.state;` 后以 S.x 访问状态、QP.y 访问配置/工具。
 *
 * 由 index.html（ribbon 上下文）与 taskpane.html（taskpane 上下文）均先于其他控制器
 * 模块加载（见两份 HTML 的 <script> 顺序与 manifest.xml）。
 */
'use strict';

// ── 统一调试日志：console.log + POST 到 bridge /debug/log（持久化，WPS CEF 崩溃时也能在 bridge 日志看到） ──
// 全局函数：各控制器模块以裸 QPLog(...) 调用；同时暴露 window.QPLog 供叶子模块（chat-ui/acp-client 等）使用。
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

var QP = (function () {
  var state = {
    // ── taskpane 上下文状态 ──
    isTaskpane: !!document.getElementById('messages'),
    pollPort: 58891,                // 本窗口分配到的 poll 端口（路线 P；默认 58891 兜底，分配失败时回退旧行为）
    acpSessionId: null,
    streamBuffer: '',               // 当前流式消息的累积文本
    preamblePending: false,         // P16：新会话（session/new 成功）待注入环境上下文 preamble（仅首条 prompt 注入一次）
    waitingResponse: false,         // 是否有 in-flight 请求（禁止并发发送）
    pendingRequests: {},            // requestId -> { method, text }
    ribbonUI: null,

    // ── 会话建立看门狗（plan-2026-09-04 根因 1 路线 B）──
    sessionRetries: 0,              // 当前逻辑会话建立的重试次数（上限 1，见 onSessionTimeout）
    sessionTimer: null,             // 会话建立看门狗定时器
    sessionFailed: false,           // P21：会话建立失败（重试用尽）——发送按钮保持禁用 + 占位提示

    // ── ACP session 默认工作目录（平台通用，P16 兜底）──
    sessionCwd: null,               // bridge /config 下发的平台通用默认值；未拉取前为 null（用 JS 平台探测兜底）

    // ── bridge /config 权威配置门禁（plan-2026-09-04 根因 2）──
    wpsMcpEntryReady: false,        // MCP_SERVERS[0].args 已由 /config 下发权威绝对路径
    bridgeConfigErrorShown: false,  // 错误卡片只展示一次（恢复后再失败可再次展示）
    configFetching: false,          // 是否有在途的 /config 拉取链（防重复触发）

    // ── ACP server 能力标志（plan-2026-09-05 §6，bridge /config 下发，Phase 2 前端按标志适配）──
    // 默认值对齐 qwenpaw 现状（/config 拉取前 / 失败时行为零变化）。
    acpServerName: 'qwenpaw',       // /config 下发的当前 ACP server（版本倾斜检测用，见 switchAgent）
    capabilities: {
      honorMcpEnv: true,
      approval: 'auto',             // auto=自动批准(allow_once) / none=无审批 / manual=手动确认
      thoughtHeartbeat: true,
      loadSession: true,
      cancel: true,
      agents: true,
      switchSemantics: 'restart'    // restart=kill+重启 / config_option=会话级 set_config_option
    },

    // ── 阶段 3 批 1：P1 状态合并 / P2 中断恢复 / P4 过程呈现 / P5 中止 ──
    extendCount: 0,                 // 当前已顺延次数（任何下行清零）
    acpState: 'connecting',         // 'connecting' | 'connected' | 'disconnected'
    wpsState: 'pending',            // 'pending'（未激活，预期）| 'connected'
    lastAcpShown: null,             // 已渲染的 ACP 状态（避免 500ms 轮询重复写 DOM）
    lastWpsShown: null,             // 已渲染的 WPS 状态
    gotFirstChunk: false,           // P2 诊断：prompt 发出后是否收到首个 chunk
    lastUserText: '',               // P2 重试用：最近一次用户消息
    lastPromptReqId: null,          // 当前 prompt 的请求 id
    pendingToolCards: [],           // P4：当前进行中的工具卡片（新工具调用时旧的先标记完成）
    noFirstChunkTimer: null,        // P2：无首 chunk 看门狗
    activityTimer: null,            // P2：无下行活动看门狗

    // ── 阶段 3 批 2：P8 文档隔离 / P15 历史缓存 / P3 agent 选择 ──
    currentDocId: null,             // 当前活动文档 id（会话隔离 key）
    docStates: {},                  // docId -> {acpSessionId, messages}
    docSwitchDeferred: false,       // P8：AI 在途响应期间检测到文档变化 → 延迟到响应结束再切换
    persistTimer: null,             // P15：历史落盘防抖
    agentList: [],                  // P3：可用 agent 列表
    agentCached: null,              // P3：localStorage 记住的上次 agent
    docCheckTimer: null,            // P8：活动文档检测间隔
    pendingAttachments: [],         // P6：待发送附件 [{name, text}]（文本提取；图片为 {name, image:true} 占位）

    // ── Phase 3：ACP server 配置（plan-2026-09-05 §7）──
    serverList: [],                 // Phase 3：可用 server 列表（/servers）
    serverCached: null,             // Phase 3：localStorage 记住的上次 server
    settingsOpen: false,            // Phase 3：设置面板开关状态
    currentConfigOptions: null      // Phase 3：当前会话 configOptions（opencode model/effort/mode）

    // ribbon 上下文私有状态（WPS_Enum / TASKPANE_DOCK_POSITION / taskpaneIdCache）留在 ribbon.js
  };

  function historyKey(docId) { return 'qp.history.' + (docId || 'default'); }
  function sessionKey(docId) { return 'qp.session.' + (docId || 'default'); }

  // P23：未保存文档（volatile docId）的历史/会话缓存一律不落 localStorage——
  // 临时草稿无跨会话身份，关闭即弃，避免 volatile key 长期堆积 / 跨实例串台。
  // 依赖 doc-state.js 的 isVolatileDocId（运行时存在；加载时序 app-state 最先、doc-state 随后，
  // 所有持久化函数都在运行时调用，届时已定义）。
  function isVolatileDocIdForPersist(docId) {
    try {
      return typeof globalThis.isVolatileDocId === 'function' && globalThis.isVolatileDocId(docId);
    } catch (e) {
      return false;
    }
  }

  // Phase 3：agent 选择按 server 隔离（不同 server 的 agent 语义不同，opencode 是 mode）。
  // 旧版全局 key 'qp.agent' 兼容回退：server-scoped 无值时读旧 key（一次迁移）。
  var LEGACY_AGENT_KEY = 'qp.agent';
  function agentKey() { return 'qp.agent.' + (state.acpServerName || 'qwenpaw'); }
  function serverKey() { return 'qp.server'; }
  function configKey() { return 'qp.config.' + (state.acpServerName || 'qwenpaw'); }

  function loadSavedAgent() {
    var k = agentKey();
    try {
      var v = localStorage.getItem(k);
      if (v === null && k !== LEGACY_AGENT_KEY) v = localStorage.getItem(LEGACY_AGENT_KEY);
      return v || null;
    } catch (e) { return null; }
  }

  function saveSavedAgent(id) {
    var k = agentKey();
    try {
      localStorage.setItem(k, id);
      if (k !== LEGACY_AGENT_KEY) localStorage.removeItem(LEGACY_AGENT_KEY);
    } catch (e) {}
  }

  function loadHistory(docId) {
    if (isVolatileDocIdForPersist(docId)) return []; // P23：volatile 一律无历史
    try {
      var raw = localStorage.getItem(historyKey(docId));
      return (raw && JSON.parse(raw)) || [];
    } catch (e) { return []; }
  }

  function saveHistory(docId, msgs) {
    if (isVolatileDocIdForPersist(docId)) return; // P23：volatile 不落盘
    try {
      localStorage.setItem(historyKey(docId), JSON.stringify((msgs || []).slice(-200)));
    } catch (e) {}
  }

  function loadCachedSessionId(docId) {
    if (isVolatileDocIdForPersist(docId)) return null; // P23：volatile 无 sessionId 缓存（跨实例不复用）
    try { return localStorage.getItem(sessionKey(docId)) || null; } catch (e) { return null; }
  }

  function saveCachedSessionId(docId, sid) {
    if (isVolatileDocIdForPersist(docId)) return; // P23：volatile 不落盘
    try {
      if (sid) localStorage.setItem(sessionKey(docId), sid);
      else localStorage.removeItem(sessionKey(docId));
    } catch (e) {}
  }

  // Phase 3：从 localStorage 读取记住的 model/effort（按 server 隔离；会话级不跨会话，新会话需重新应用）
  function loadSavedConfigOptions() {
    try {
      var raw = localStorage.getItem(configKey());
      return (raw && JSON.parse(raw)) || {};
    } catch (e) { return {}; }
  }

  function saveSavedConfigOptions(cfg) {
    try { localStorage.setItem(configKey(), JSON.stringify(cfg)); } catch (e) {}
  }

  return {
    state: state,

    // ── 配置 / 常量 ──
    ACP_WS_URL: 'ws://127.0.0.1:8765',
    // P16：QwenPaw ACP session 工作目录——默认兜底（无活动文档时）；实际用当前活动文档目录（getSessionCwd()）。
    // 平台通用：/config 下发后以 S.sessionCwd（bridge 平台解析，Linux/macOS /tmp、Windows 用户 %TEMP%）为准；
    // 未拉取前按平台探测兜底（仅 last-resort——正常路径会话创建已被 /config 门禁，bridge 值必已就绪）。
    //   Windows -> 系统临时目录常量（JS 内无法取用户 %TEMP%，非精确等价，仅兜底）
    //   其它（Linux/macOS）-> /tmp
    SESSION_CWD: (function () {
      try {
        var pf = (typeof navigator !== 'undefined' && navigator.platform) ? String(navigator.platform) : '';
        var ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? String(navigator.userAgent) : '';
        if (/Win/i.test(pf) || /Windows/i.test(ua)) return 'C:\\Windows\\Temp';
      } catch (e) {}
      return '/tmp';
    })(),
    // 解析当前 session 默认工作目录：/config 下发的平台通用值优先，未就绪用 JS 平台探测兜底
    resolveSessionCwd: function () {
      return (state.sessionCwd || QP.SESSION_CWD);
    },

    // wps-office-mcp MCP 服务器（§5.1 + §13 v0.17 路线 P）：
    // 走 stdio（QwenPaw 每 ACP session spawn 独立 wps-mcp 子进程），bridge 集中分配独立 poll 端口
    // （WPS_POLL_PORT env 注入，59000+ 段，多窗口并发不抢 :58891、不串台）。
    // env 是 [{name,value}] 列表（ACP schema: McpServerStdio.env = List[EnvVariable]），
    // 端口值由 bridge /poll-port/allocate 分配后覆盖（bridge 转发 session/new 时也会强制注入权威值）。
    // 入口路径不硬编码本机绝对路径：由 bridge /config 下发（bridge 依据仓库根解析，
    // opencode-wps 以 submodule 固定在 third_party/opencode-wps/，路径可确定）。
    // args 初始为空占位：fetchBridgeConfig 成功前 ensureSession 被 wpsMcpEntryReady 门禁拦截，
    // 绝不携带相对/空路径去 spawn；成功后代之以权威绝对路径。
    MCP_SERVERS: [{
      name: 'wps',
      command: 'node',
      args: [],
      env: [{ name: 'WPS_POLL_PORT', value: '58891' }]
    }],

    // ── 会话建立看门狗（plan-2026-09-04 根因 1 路线 B）──
    SESSION_TIMEOUT_MS: 25000,      // 必须盖过 bridge 切换后 qwenpaw 重启就绪时间（实测 ≥8s）+ 余量

    // ── 阶段 3 批 1：P2 中断恢复看门狗阈值（按实测分层）──
    // qwenpaw 单次请求内存在 78s/91s/104s 的 thinking 完全静默窗口，60s 阈值必然误报。
    P2_NO_FIRST_CHUNK_MS: 120000,   // 发送后 120s 无任何 chunk → 疑似中断（覆盖 91s 静默 + 余量）
    P2_ACTIVITY_MS: 180000,         // 连续 180s 无任何下行活动 → 疑似中断
    P2_EXTEND_MS: 60000,            // 疑似中断后每次自动顺延时长（不死判）
    P2_MAX_EXTENDS: 3,              // 顺延上限：总等待 = 首阈值 + 3×60s ≤ 5min

    // ── 阶段 3 批 2：P8 文档隔离 / P6 附件 ──
    DOC_CHECK_MS: 3000,             // P8：活动文档检测周期
    MAX_ATTACH_TEXT: 60000,         // P6：单个附件文本上限（超出截断）

    // ── 工具函数（持久化 key 与存取）──
    QPLog: QPLog,
    historyKey: historyKey,
    sessionKey: sessionKey,
    LEGACY_AGENT_KEY: LEGACY_AGENT_KEY,
    agentKey: agentKey,
    serverKey: serverKey,
    configKey: configKey,
    loadSavedAgent: loadSavedAgent,
    saveSavedAgent: saveSavedAgent,
    loadHistory: loadHistory,
    saveHistory: saveHistory,
    loadCachedSessionId: loadCachedSessionId,
    saveCachedSessionId: saveCachedSessionId,
    loadSavedConfigOptions: loadSavedConfigOptions,
    saveSavedConfigOptions: saveSavedConfigOptions
  };
})();
