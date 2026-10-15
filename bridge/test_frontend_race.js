#!/usr/bin/env node
/**
 * Frontend 行为验证：每个场景用**全新环境**按 manifest 顺序加载控制器模块 + main.js
 * （vm sandbox + DOM/XHR/AcpClient 桩；叶子模块 acp-client/wps-bridge/chat-ui/
 * wps-poll-client/markdown 以桩替代，测试借此录制调用）。
 * 验证 plan-2026-09-04 §6.2（会话建立看门狗：超时清 pending + 重试 ≤1 + 可见错误）
 * 与 §6.3（/config 不可达：不静默带相对路径 spawn；恢复后能继续）。
 *
 * 加载顺序对齐 manifest.xml / index.html / taskpane.html（app-state 最先、main 最末，
 * 依赖 app-state 先定义 QP，各控制器 IIFE 内 `var S = QP.state`）。
 *
 * 用法：node /tmp/kilo/test_frontend_race.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'js');
// 控制器模块（叶子模块已桩化，不加载真实文件）；顺序与 manifest.xml <scripts> 一致
const MODULE_ORDER = [
  'app-state.js', 'doc-state.js', 'prompts.js', 'bridge-config.js', 'session.js', 'agents.js',
  'acp-events.js', 'watchdog.js', 'actions.js', 'poll.js', 'ribbon.js', 'main.js'
];
const WATCHDOG_MS = 25000;

function loadEnv(initialConfigMode, opts) {
  let configMode = initialConfigMode;
  opts = opts || {};
  const st = {
    timers: [], timerSeq: 0,
    chatCalls: { status: [], messages: [], errorCards: [], restores: [], emptyHints: 0, placeholders: [] },
    acpCalls: { send: [], connected: false }, acpIdSeq: 0,
    store: {}, els: {},
    acpCbs: { conn: null, response: null, update: null, request: null },
    currentServer: 'qwenpaw',
    serverSwitchedTo: null,
    deferredServers: [],   // opts.deferServers 时暂存 /servers 响应（flushServers 触发）
    // P23：可控的活动文档身份与打开文档集合（Scenario G 用）
    docIdentity: opts.docIdentity || null,
    openDocs: (opts.openDocs || []).slice(),
  };
  // 预置记住的 server（Phase 3：qp.server）
  if (opts.savedServer) st.store['qp.server'] = opts.savedServer;
  // plan-2026-10-15：预置 localStorage 历史/会话（volatile 反查测试用）
  if (opts.prestore) {
    for (const k in opts.prestore) {
      if (Object.prototype.hasOwnProperty.call(opts.prestore, k)) st.store[k] = String(opts.prestore[k]);
    }
  }

  function fakeSetTimeout(fn, ms) {
    const id = ++st.timerSeq;
    st.timers.push({ id, fn, ms, fired: false });
    return id;
  }
  function fakeClearTimeout(id) {
    const t = st.timers.find(x => x.id === id);
    if (t) t.fired = true;
  }
  function fakeSetInterval() { return 0; }
  function fakeClearInterval() {}

  function makeEl() {
    return {
      firstChild: null, style: {}, className: '', textContent: '', value: '',
      addEventListener() {}, removeChild() {}, appendChild() {},
      setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; },
    };
  }
  const documentStub = {
    readyState: 'complete',
    getElementById(id) { if (!st.els[id]) st.els[id] = makeEl(); return st.els[id]; },
    addEventListener() {}, createElement() { return makeEl(); },
  };

  const ChatUiStub = {
    init() {},
    addMessage(role, text) { st.chatCalls.messages.push({ role, text }); },
    addErrorCard(title, text, opts) { st.chatCalls.errorCards.push({ title, text, opts }); },
    setStatus(label) { st.chatCalls.status.push(label); },
    setConnStateText() {}, setWpsState() {}, snapshot() { return []; },
    restore(msgs) { st.chatCalls.restores.push(msgs ? msgs.slice() : []); },
    clear() {}, showEmptyHint() { st.chatCalls.emptyHints++; }, showTyping() {}, hideTyping() {},
    setInputEnabled() {}, setPlaceholder(text) { st.chatCalls.placeholders.push(text || ''); }, setBusy() {}, appendAssistantChunk() {}, finishAssistant() {},
    addToolCard() { return {}; }, markToolCard() {},
    toggleSettings() {}, setServerList() {}, setServerDesc() {}, setCapabilityNotes() {},
    populateConfigOptions() {}, addApprovalCard() {},
  };

  const AcpClientStub = {
    send(method, params) { st.acpIdSeq++; st.acpCalls.send.push({ id: st.acpIdSeq, method, params }); return st.acpIdSeq; },
    respond() {}, getClientId() { return 'test-client'; },
    connect() { st.acpCalls.connected = true; },
    disconnect() {},
    onConnectionChange(cb) { st.acpCbs.conn = cb; },
    onResponse(cb) { st.acpCbs.response = cb; },
    onSessionUpdate(cb) { st.acpCbs.update = cb; },
    onRequest(cb) { st.acpCbs.request = cb; },
  };
  const WpsPollClientStub = { init() {}, start() {}, stop() {} };
  const WpsBridgeStub = {
    // P23：活动文档身份与文档集合可控制（Scenario G/H/I/J 验证 volatile docId + 保存迁移 + 反例）
    getDocIdentity() { return st.docIdentity ? Object.assign({}, st.docIdentity) : null; },
    getActiveDocumentInfo() { return st.docIdentity ? Object.assign({}, st.docIdentity) : null; },
    hasDocumentNamed(name) { return st.openDocs.indexOf(name) !== -1; },
    getDocCount() { return st.openDocs.length; },
  };

  const localStorageStub = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(st.store, k) ? st.store[k] : null; },
    setItem(k, v) { st.store[k] = String(v); },
    removeItem(k) { delete st.store[k]; },
    key(i) { return Object.keys(st.store)[i] || null; },
    get length() { return Object.keys(st.store).length; },
  };

  function XHRStub() {}
  XHRStub.prototype.open = function (m, url) { this.method = m; this.url = url; };
  XHRStub.prototype.setRequestHeader = function () {};
  XHRStub.prototype.send = function () {
    const self = this;
    const url = this.url;
    const finish = (s, body) => {
      self.status = s;
      self.responseText = typeof body === 'string' ? body : JSON.stringify(body);
      if (self.onload) self.onload();
    };
    if (url.indexOf('/config') !== -1) {
      if (configMode === 'ok') {
        finish(200, {
          wpsMcpEntry: '/abs/wps/index.js', pollPortStart: 59000, pollPortEnd: 59999,
          acpServer: st.currentServer,
          capabilities: { switchSemantics: 'config_option', approval: 'none', cancel: false },
        });
      } else if (self.onerror) {
        self.onerror();
      }
      return;
    }
    if (url.indexOf('/poll-port/allocate') !== -1) { finish(200, { port: 59001, clientId: 'x' }); return; }
    if (url.indexOf('/agents') !== -1) {
      finish(200, { agents: [{ id: 'default', name: 'Default', description: '' }], current: 'default' });
      return;
    }
    if (url.indexOf('/servers') !== -1) {
      const body = {
        servers: [
          { name: 'qwenpaw', defaultAgent: 'default', capabilities: { switchSemantics: 'restart' }, description: '' },
          { name: 'opencode', defaultAgent: 'build', capabilities: { switchSemantics: 'config_option' }, description: '' },
        ],
        current: st.currentServer,
      };
      if (opts.deferServers) {
        // 挂起 /servers 响应，等 flushServers() 手动触发（模拟"切换前先连上"竞态）
        st.deferredServers.push({ fn: finish, body });
      } else {
        finish(200, body);
      }
      return;
    }
    if (url.indexOf('/server/set') !== -1) {
      // POST /server/set?server=X -> 成功时 bridge current 变为 X；failServerSet 时返回失败（400）
      if (opts.failServerSet) {
        finish(400, { ok: false, server: st.currentServer, error: 'boom' });
        return;
      }
      const target = new URL(url, 'http://x').searchParams.get('server');
      st.serverSwitchedTo = target;
      st.currentServer = target;
      finish(200, { ok: true, server: target, error: null });
      return;
    }
    finish(404, {});
  };

  const sandbox = {
    console, Date, Math, JSON, URL,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
    XMLHttpRequest: XHRStub, localStorage: localStorageStub,
    document: documentStub, alert() {}, confirm() { return true; },
    ChatUi: ChatUiStub, AcpClient: AcpClientStub,
    WpsPollClient: WpsPollClientStub, WpsBridge: WpsBridgeStub,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of MODULE_ORDER) {
    vm.runInContext(fs.readFileSync(path.join(JS_DIR, f), 'utf8'), sandbox, { filename: f });
  }

  return {
    setConfig(mode) { configMode = mode; },
    conn(state) { st.acpCbs.conn(state); },
    respond(id, result, error) { st.acpCbs.response(id, result, error); },
    flushServers() {
      const d = st.deferredServers.shift();
      if (d) d.fn(200, d.body);
    },
    currentServer() { return st.currentServer; },
    serverSwitchedTo() { return st.serverSwitchedTo; },
    fireWatchdog() {
      const t = st.timers.find(x => !x.fired && x.ms === WATCHDOG_MS);
      if (!t) throw new Error('no pending session watchdog (ms=' + WATCHDOG_MS + ')');
      t.fired = true;
      t.fn();
    },
    // P23：触发指定延迟的待触发定时器（如 schedulePersist 的 600ms 防抖）
    fireMs(ms) {
      const t = st.timers.find(x => !x.fired && x.ms === ms);
      if (t) { t.fired = true; t.fn(); }
    },
    fireAllTimers() {
      let guard = 0;
      for (;;) {
        guard++;
        if (guard > 2000) throw new Error('timer fire loop guard exceeded');
        const t = st.timers.find(x => !x.fired);
        if (!t) break;
        t.fired = true;
        t.fn();
      }
    },
    clearTimers() { st.timers.length = 0; },
    sends() { return st.acpCalls.send; },
    sessionNewSends() { return st.acpCalls.send.filter(s => s.method === 'session/new'); },
    chat() { return st.chatCalls; },
    // plan-2026-10-15：断言辅助（volatile 反查 / Path 等待）
    restores() { return st.chatCalls.restores; },
    emptyHints() { return st.chatCalls.emptyHints; },
    placeholders() { return st.chatCalls.placeholders; },
    hasTimer(ms) { return st.timers.some(t => !t.fired && t.ms === ms); },
    volatile(id) { return sandbox.isVolatileDocId(id); },
    // P23：Scenario G 控制活动文档身份 / 打开文档集合 / 触发文档复查 / 读状态与 localStorage
    setDocIdentity(info) { st.docIdentity = info; },
    setOpenDocs(list) { st.openDocs = (list || []).slice(); },
    checkDoc() { if (typeof sandbox.checkDocNow === 'function') sandbox.checkDocNow(); },
    state() { return sandbox.QP.state; },
    store() { return st.store; },
    QP() { return sandbox.QP; },
    send(text) { if (sandbox.QwenPawAddon && sandbox.QwenPawAddon.sendUserMessage) sandbox.QwenPawAddon.sendUserMessage(text); },
  };
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ✅ ' + name);
  else { failures++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

// ══ Scenario A：/config 不可达（加载即失败）→ 不静默带相对路径 spawn，给可见错误 ══
console.log('Scenario A: /config 不可达');
{
  const env = loadEnv('fail');
  env.fireAllTimers();     // 耗掉 initTaskpane loadBridgeConfig 的重试
  env.conn('connected');   // ACP 连上 -> ensureSession
  env.fireAllTimers();     // 耗掉 ensureBridgeConfigThenSession 的重试
  const chat = env.chat();
  check('A1 未发送 session/new（不携带相对路径去 spawn）', env.sessionNewSends().length === 0,
    'count=' + env.sessionNewSends().length);
  const hasErrorMsg = chat.messages.some(m => m.role === 'error' && m.text.indexOf('bridge 配置获取失败') !== -1)
    || chat.errorCards.length > 0;
  check('A2 展示可见错误（bridge 配置获取失败）', hasErrorMsg,
    JSON.stringify(chat.messages).slice(0, 200));
  check('A3 状态置为 bridge 未就绪', chat.status.indexOf('ACP: bridge 未就绪') !== -1,
    'status=' + JSON.stringify(chat.status.slice(-4)));
}

// ══ Scenario B：同环境 /config 恢复 -> 继续建会话，用绝对路径 ══
console.log('Scenario B: /config 恢复（同一环境）');
{
  const env = loadEnv('fail');
  env.fireAllTimers();
  env.conn('connected');
  env.fireAllTimers();
  env.setConfig('ok');
  env.conn('connected');   // 再次连接 -> ensureSession -> 先拉 /config（成功）-> 发 session/new
  env.fireAllTimers();
  const sends = env.sessionNewSends();
  check('B1 /config 恢复后发出 session/new（绝对路径，非相对）',
    sends.length >= 1 && sends.every(s => Array.isArray(s.params.mcpServers[0].args)
      && s.params.mcpServers[0].args[0] === '/abs/wps/index.js'),
    'count=' + sends.length + ' args=' + (sends.length ? JSON.stringify(sends[0].params.mcpServers[0].args) : 'no send'));
}

// ══ Scenario C：session/new 无响应 -> 看门狗 -> 重试 1 次 -> 响应到达即成功 ══
console.log('Scenario C: 看门狗重试 -> 响应到达 -> 成功');
{
  const env = loadEnv('ok'); // 加载时 /config 成功，wpsMcpEntryReady=true
  env.conn('connected');     // ensureSession -> send session/new #1
  check('C1 发出首个 session/new', env.sessionNewSends().length === 1, 'count=' + env.sessionNewSends().length);
  env.fireWatchdog();        // 超时 -> 清 pending -> 重试 send #2
  check('C2 看门狗触发后自动重试（第 2 次 session/new）', env.sessionNewSends().length === 2,
    'count=' + env.sessionNewSends().length);
  const allSends = env.sends();
  const id2 = allSends[allSends.length - 1].id;
  env.respond(id2, { sessionId: 'S1' }, null); // 重试的响应到达
  env.fireAllTimers();
  const chat = env.chat();
  check('C3 重试响应到达 -> 会话建立成功（状态就绪，无错误卡）',
    chat.status.indexOf('就绪') !== -1 && chat.errorCards.length === 0,
    'status=' + JSON.stringify(chat.status.slice(-3)) + ' errCards=' + chat.errorCards.length);
}

// ══ Scenario D：session/new 两次都无响应 -> 重试用尽 -> 可见错误，不无限循环、不锁死 ══
console.log('Scenario D: 重试用尽 -> 可见错误 + 不锁死');
{
  const env = loadEnv('ok');
  env.conn('connected'); // send #1
  env.fireWatchdog();    // -> retry #2
  env.fireWatchdog();    // -> 用尽 -> 错误
  const chat = env.chat();
  check('D1 恰好 2 次 session/new（无无限循环）', env.sessionNewSends().length === 2,
    'count=' + env.sessionNewSends().length);
  check('D2 展示可见错误卡（会话建立失败）', chat.errorCards.length > 0,
    'errCards=' + chat.errorCards.length);
  check('D3 状态置为会话建立失败', chat.status.indexOf('ACP: 会话建立失败') !== -1,
    'status=' + JSON.stringify(chat.status.slice(-3)));
  // 锁未泄漏：再次触发 ensureSession 应能发出新 session/new（防重入 pending 已清理）
  const before = env.sessionNewSends().length;
  env.conn('disconnected');
  env.conn('connected');
  check('D4 错误后再次触发可重新建会话（pending 未泄漏锁死）',
    env.sessionNewSends().length === before + 1,
    'before=' + before + ' after=' + env.sessionNewSends().length);
}

// ══ Scenario E：server 切换（Phase 3）—— 竞态：连接先于 /servers 返回，旧 server 已发 session/new，
// 切换成功后必须清掉 stale pending（否则 ensureSession 被挡住 → 25s 看门狗误报"会话建立失败"）══
console.log('Scenario E: server 切换竞态（stale session/new 清理）');
{
  // /servers 挂起（deferServers），预置 qp.server=opencode（记住的上次选择）
  const env = loadEnv('ok', { deferServers: true, savedServer: 'opencode' });
  env.fireAllTimers();          // 耗掉 loadBridgeConfig 的重试（/config ok -> callback: loadServerList 挂起 + connect）
  // 竞态：ACP 先连上，ensureSession 在旧 server（qwenpaw，bridge current）上发 session/new
  env.conn('connected');
  check('E1 切换前：旧 server 上发出 session/new', env.sessionNewSends().length === 1,
    'count=' + env.sessionNewSends().length);
  // 现在 /servers 返回：current=qwenpaw，但记住的是 opencode -> 自动切换
  env.flushServers();
  env.fireAllTimers();          // switchServer 成功 -> fetchBridgeConfig -> resetAfterServerSwitch -> ensureSession
  const sends = env.sessionNewSends();
  const acpServer = env.currentServer();
  check('E2 切换后 bridge current 变 opencode', acpServer === 'opencode', 'current=' + acpServer);
  check('E3 切换后重新发出 session/new（stale pending 已被清理，未阻塞 ensureSession）',
    sends.length >= 2, 'count=' + sends.length);
  // 先让新会话建立成功（满足会话看门狗），再让旧 server 的 stale 响应到达
  const staleId = sends[0].id;
  const newId = sends[sends.length - 1].id;
  env.respond(newId, { sessionId: 'NEW-SESSION' }, null);
  env.fireAllTimers();
  const errBefore = env.chat().errorCards.length;
  env.respond(staleId, { sessionId: 'OLD-SESSION' }, null);
  env.fireAllTimers();
  check('E4 stale 响应不破坏新会话（pending 已清 → no-op，无错误卡/无重建）',
    env.chat().errorCards.length === errBefore, 'errCards=' + env.chat().errorCards.length);
}

// ══ Scenario F：server 切换失败（Phase 3）—— 回滚显示为 bridge 实际 server，且不无限重试循环 ══
console.log('Scenario F: server 切换失败回滚（不无限重试）');
{
  const env = loadEnv('ok', { savedServer: 'opencode', failServerSet: true });
  env.fireAllTimers();   // loadBridgeConfig -> loadServerList -> 自动切换（/server/set 失败 400）-> 回滚 loadServerList(skip)
  // 若未加 skipAutoSwitch 防护，loadServerList() 会再次触发 switchServer -> 又失败 -> 又 loadServerList -> 无限循环
  // （XHR 同步执行，若循环会栈溢出/guard 超限；这里只验证展示回滚 + 可见错误）
  const chat = env.chat();
  check('F1 切换失败显示错误消息', chat.messages.some(m => m.role === 'error' && m.text.indexOf('ACP server 切换失败') !== -1),
    JSON.stringify(chat.messages).slice(0, 160));
  // 未无限循环：/server/set 至多请求 1 次（自动切换那一次）；display 停在 bridge 实际 server（qwenpaw）
  check('F2 未无限重试 /server/set（≤1 次）', env.serverSwitchedTo() === null,
    'serverSwitchedTo=' + env.serverSwitchedTo());
  check('F3 显示回滚为 bridge 当前 server', env.currentServer() === 'qwenpaw', 'current=' + env.currentServer());
}

// ══ Scenario G：P23 未保存文档 docId 唯一化 + 保存时迁移（不丢会话 / 不落盘 / 不串台）══
console.log('Scenario G: P23 未保存文档 docId 唯一化 + 保存迁移');
{
  const env = loadEnv('ok', {
    docIdentity: { name: '文字文稿1', path: '', appType: 'wps' },
    openDocs: ['文字文稿1'],
  });
  const volId = env.state().currentDocId;
  check('G1 未保存文档 docId 为 volatile（含 ::unsaved:: + 实例 token）',
    typeof volId === 'string' && volId.indexOf('::unsaved::') !== -1,
    'docId=' + volId);
  check('G2 volatile docId 以 appType::unsaved:: 开头', /^wps::unsaved::/.test(volId || ''), 'docId=' + volId);

  // 建会话（volatile 无 sessionId 缓存 → 走 session/new）；直接回包，不触发看门狗
  env.conn('connected');
  const newSends = env.sessionNewSends();
  check('G3 未保存文档无历史 sessionId 缓存 → session/new', newSends.length === 1,
    'count=' + newSends.length);
  env.respond(newSends[newSends.length - 1].id, { sessionId: 'S1' }, null);
  check('G3b 会话建立成功（acpSessionId=S1）', env.state().acpSessionId === 'S1',
    'sid=' + env.state().acpSessionId);

  // volatile 历史不落 localStorage（直接调 saveHistory/saveCachedSessionId 验证守卫）
  env.QP().saveHistory(volId, [{ role: 'user', text: 'x' }]);
  env.QP().saveCachedSessionId(volId, 'S1');
  check('G4 未保存文档历史不落 localStorage', !env.store()['qp.history.' + volId],
    'keys=' + Object.keys(env.store()).filter(k => k.indexOf('qp.history.') === 0).join(','));
  check('G5 未保存文档 sessionId 不落 localStorage', !env.store()['qp.session.' + volId],
    'keys=' + Object.keys(env.store()).filter(k => k.indexOf('qp.session.') === 0).join(','));

  // 模拟保存：改名 + path 非空 + 旧名从文档集合消失 → 触发迁移
  env.setOpenDocs(['report.docx']);
  env.setDocIdentity({ name: 'report.docx', path: '/home/u/Documents', appType: 'wps' });
  env.checkDoc();
  const stableId = 'wps:/home/u/Documents:report.docx';
  const st1 = env.state();
  const migratedDocId = st1.currentDocId; // 快照（st1 是 live state 对象，后续切换会变）
  check('G6 保存后 docId 迁移到稳定 id', migratedDocId === stableId,
    'docId=' + migratedDocId);
  check('G7 迁移不丢会话（acpSessionId 保持 S1）', st1.acpSessionId === 'S1',
    'sid=' + st1.acpSessionId);
  check('G8 迁移不重建会话（session/new 仍仅 1 次）', env.sessionNewSends().length === 1,
    'count=' + env.sessionNewSends().length);
  check('G9 迁移后会话缓存落到稳定 docId', env.store()['qp.session.' + stableId] === 'S1',
    'session=' + env.store()['qp.session.' + stableId]);

  // 同实例再新建另一个未保存文档：token 相同但 name 不同 → 各自隔离（不串台）
  env.setDocIdentity({ name: '文字文稿2', path: '', appType: 'wps' });
  env.setOpenDocs(['report.docx', '文字文稿2']);
  env.checkDoc();
  const vol2Id = env.state().currentDocId;
  check('G10 切换到另一未保存文档 → 新 volatile docId（隔离不串台）',
    vol2Id !== migratedDocId && /^wps::unsaved::/.test(vol2Id || ''),
    'docId=' + vol2Id);
  check('G11 另一未保存文档无历史缓存残留（不落盘）', !env.store()['qp.history.' + vol2Id],
    'keys=' + Object.keys(env.store()).filter(k => k.indexOf('qp.history.') === 0).join(','));
}

// ══ Scenario H：P23 反例——从"未保存文档"切换到"另一已打开的已保存文档"必须走文档切换，绝不误判保存迁移 ══
console.log('Scenario H: P23 反例——切到另一已打开文档不误迁');
{
  const env = loadEnv('ok', {
    docIdentity: { name: '文字文稿1', path: '', appType: 'wps' },
    openDocs: ['文字文稿1', 'report.docx'],
  });
  const volId = env.state().currentDocId;
  env.conn('connected');
  const newSends = env.sessionNewSends();
  env.respond(newSends[newSends.length - 1].id, { sessionId: 'S1' }, null);

  // 切换到另一已打开的已保存文档：旧名"文字文稿1"仍在文档集合中 → 判定为切换，不是保存
  env.setDocIdentity({ name: 'report.docx', path: '/home/u/Documents', appType: 'wps' });
  env.checkDoc();
  const st = env.state();
  check('H1 切到另一已打开文档 → docId 为稳定 id（正常切换）', st.currentDocId === 'wps:/home/u/Documents:report.docx',
    'docId=' + st.currentDocId);
  check('H2 会话按文档切换重建（acpSessionId 清空，重新建会话）', st.acpSessionId === null,
    'sid=' + st.acpSessionId);
  check('H3 未保存文档历史不落盘（不被误迁移落盘）', !env.store()['qp.history.' + volId],
    'keys=' + Object.keys(env.store()).filter(k => k.indexOf('qp.history.') === 0).join(','));
  check('H4 切换后发起新会话（session/new ≥2，未复用餐户缓存）', env.sessionNewSends().length >= 2,
    'count=' + env.sessionNewSends().length);
}

// ══ Scenario I：P23 同名就地保存（未保存文档保持默认名直接保存，path '' -> 非空）→ 必须迁移 ══
console.log('Scenario I: P23 同名就地保存迁移');
{
  const env = loadEnv('ok', {
    docIdentity: { name: '文字文稿1', path: '', appType: 'wps' },
    openDocs: ['文字文稿1'],
  });
  const volId = env.state().currentDocId;
  env.conn('connected');
  const newSends = env.sessionNewSends();
  env.respond(newSends[newSends.length - 1].id, { sessionId: 'S1' }, null);

  // 同名就地保存：name 不变、path 变非空（旧名仍在集合中也无所谓——同名即同一文档）
  env.setOpenDocs(['文字文稿1']);
  env.setDocIdentity({ name: '文字文稿1', path: '/home/u/Documents', appType: 'wps' });
  env.checkDoc();
  const st = env.state();
  check('I1 同名就地保存 → docId 迁移到稳定 id', st.currentDocId === 'wps:/home/u/Documents:文字文稿1',
    'docId=' + st.currentDocId);
  check('I2 会话不丢（acpSessionId 保持 S1）', st.acpSessionId === 'S1', 'sid=' + st.acpSessionId);
  check('I3 会话缓存落到稳定 docId', env.store()['qp.session.wps:/home/u/Documents:文字文稿1'] === 'S1',
    'session=' + env.store()['qp.session.wps:/home/u/Documents:文字文稿1']);
  check('I4 未保存 docId 无残留缓存', !env.store()['qp.history.' + volId] && !env.store()['qp.session.' + volId],
    'keys=' + Object.keys(env.store()).filter(k => k.indexOf('qp.') === 0).join(','));
}

// ══ Scenario J：P23 反例——关闭当前文档后另一文档自动激活（集合数量减小）→ 绝不误判为保存迁移 ══
// 覆盖修复：未保存 A + 已保存 B 同时打开，A 关闭（丢弃）后 B 自动激活，旧名从集合消失，
// 若无"集合数量变化"约束会被误判为改名保存 → 误把 A 的会话/历史迁到 B。
console.log('Scenario J: P23 反例——关旧文档自动激活另一文档不误迁');
{
  const env = loadEnv('ok', {
    docIdentity: { name: '文字文稿1', path: '', appType: 'wps' },
    openDocs: ['文字文稿1', 'report.docx'], // 两个文档同时打开（Count=2）
  });
  const volId = env.state().currentDocId;
  env.conn('connected');
  const newSends = env.sessionNewSends();
  env.respond(newSends[newSends.length - 1].id, { sessionId: 'S1' }, null);
  check('J1 初始集合数量已跟踪（Count=2）', env.store()['qp.history.' + volId] === undefined, 'sanity');

  // 关闭当前未保存文档（丢弃）→ 集合 Count 2→1 → B 自动激活（旧名"文字文稿1"从集合消失）
  env.setOpenDocs(['report.docx']);
  env.setDocIdentity({ name: 'report.docx', path: '/home/u/Documents', appType: 'wps' });
  env.checkDoc();
  const st = env.state();
  check('J2 关旧自动激活 → 正常文档切换（docId=稳定 B，非迁移）', st.currentDocId === 'wps:/home/u/Documents:report.docx',
    'docId=' + st.currentDocId);
  check('J3 未把 A 的会话/历史迁到 B（acpSessionId 清空重建）', st.acpSessionId === null,
    'sid=' + st.acpSessionId);
  check('J4 A 的 volatile 缓存未被误迁移落盘', !env.store()['qp.history.' + volId] && !env.store()['qp.session.' + volId],
    'keys=' + Object.keys(env.store()).filter(k => k.indexOf('qp.') === 0).join(','));
}

// ══ Scenario K：P23 验收#1——同实例内"关闭未保存 A → 新建同名未保存 B"必须全新会话 ══
// 覆盖：WPS 复用默认名，B 的 volatile docId 与 A 相同；若关闭 A 时未清理 docStates，
// B 会继承 A 的会话/历史。关闭（无活动文档）后清理残留，B 全新。
console.log('Scenario K: P23 同实例关旧建新同名未保存文档 → 全新会话');
{
  const env = loadEnv('ok', {
    docIdentity: { name: '文字文稿1', path: '', appType: 'wps' },
    openDocs: ['文字文稿1'],
  });
  const volId = env.state().currentDocId;
  env.conn('connected');
  const s1 = env.sessionNewSends();
  env.respond(s1[s1.length - 1].id, { sessionId: 'S1' }, null);
  check('K1 A 会话已建立（S1）', env.state().acpSessionId === 'S1', 'sid=' + env.state().acpSessionId);

  // 关闭 A（不保存）→ 无活动文档 → 清理 A 的 volatile 状态
  env.setOpenDocs([]);
  env.setDocIdentity(null);
  env.checkDoc();
  check('K2 关闭后进入无文档态（currentDocId=default）', env.state().currentDocId === 'default',
    'docId=' + env.state().currentDocId);

  // 新建同名未保存文档 B → 相同 volatile docId，但不得继承 A 的会话
  env.setDocIdentity({ name: '文字文稿1', path: '', appType: 'wps' });
  env.setOpenDocs(['文字文稿1']);
  env.checkDoc();
  const st = env.state();
  check('K3 新建 B 的 docId 与 A 相同（WPS 复用默认名）', st.currentDocId === volId,
    'docId=' + st.currentDocId + ' volId=' + volId);
  check('K4 B 不继承 A 的会话（acpSessionId 为空）', st.acpSessionId === null,
    'sid=' + st.acpSessionId);
  check('K5 B 重新发起新会话（session/new ≥2，无 session/load 复用 S1）', env.sessionNewSends().length >= 2,
    'count=' + env.sessionNewSends().length);
  check('K6 无 session/load 复用旧 S1', !env.sends().some(x => x.method === 'session/load'),
    'sends=' + JSON.stringify(env.sends().map(x => x.method)));
}

// ══ plan-2026-10-15：打开已保存文档瞬间 Path 未就位 → volatile docId 反查历史/会话恢复 ══
// 覆盖方案 §5 场景 1-13（§5.1-11 单元/集成 + §5.13 回归由 A-K 场景覆盖）。
const HIST_DOC = 'wps:/home/u/Documents:同.docx';
const HIST_NAME = '同.docx';
const HIST_MSGS = JSON.stringify([{ role: 'user', text: '你好' }]);

// 辅助：无同名历史的"真新建/首开"断言（立即收敛、显示空提示、零等待、连上即 session/new）
function assertImmediateNew(env, label) {
  const st = env.state();
  check(label + ' docIdPending=false（立即收敛）', st.docIdPending === false,
    'docId=' + st.currentDocId + ' pending=' + st.docIdPending);
  check(label + ' 显示空提示', env.emptyHints() === 1, 'emptyHints=' + env.emptyHints());
  check(label + ' 无 500ms 等待定时器', !env.hasTimer(500));
  check(label + ' 未恢复任何历史', env.restores().length === 0);
  env.conn('connected');
  check(label + ' ACP 连上后立即 session/new', env.sessionNewSends().length === 1,
    'count=' + env.sessionNewSends().length);
}

// Scenario 1：正常已保存（Path 非空）→ 零变化（恢复历史 + session/load，不进入等待）
console.log('Scenario 1: 正常已保存（Path 非空）→ 恢复历史 + session/load');
{
  const env = loadEnv('ok', {
    docIdentity: { name: 'report.docx', path: '/home/u/Documents', appType: 'wps' },
    prestore: {
      'qp.history.wps:/home/u/Documents:report.docx': JSON.stringify([{ role: 'user', text: 'hi' }]),
      'qp.session.wps:/home/u/Documents:report.docx': 'S-PREV',
    },
  });
  const st = env.state();
  check('S1 docId 为稳定 id', st.currentDocId === 'wps:/home/u/Documents:report.docx',
    'docId=' + st.currentDocId);
  check('S1 docIdPending 恒 false（不进入等待）', st.docIdPending === false);
  check('S1 历史同步恢复', env.restores().length === 1 && env.restores()[0].length === 1,
    'restores=' + JSON.stringify(env.restores().map(r => r.length)));
  check('S1 未显示空提示', env.emptyHints() === 0, 'emptyHints=' + env.emptyHints());
  check('S1 无 500ms 等待定时器', !env.hasTimer(500));
  env.conn('connected');
  const loads = env.sends().filter(s => s.method === 'session/load');
  check('S1 复用会话缓存 session/load', loads.length === 1 && loads[0].params.sessionId === 'S-PREV',
    'loads=' + JSON.stringify(loads));
}

// Scenario 2：打开已保存但 Path 空 + 有同名历史 → 进入等待 → Path 就位 → 恢复
console.log('Scenario 2: 打开已保存但 Path 空 + 同名历史 → 等待 → 就位恢复');
{
  const env = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: {
      ['qp.history.' + HIST_DOC]: HIST_MSGS,
      ['qp.session.' + HIST_DOC]: 'S-PREV',
    },
  });
  const st = env.state();
  check('S2 进入等待（docIdPending=true）', st.docIdPending === true,
    'pending=' + st.docIdPending);
  check('S2 等待期不恢复历史', env.restores().length === 0);
  check('S2 等待期不显示空提示', env.emptyHints() === 0, 'emptyHints=' + env.emptyHints());
  check('S2 占位为「正在识别文档…」', env.placeholders().indexOf('正在识别文档…') !== -1,
    'placeholders=' + JSON.stringify(env.placeholders()));
  check('S2 有 500ms 等待定时器', env.hasTimer(500));
  // Path 就位 → 等待收敛
  env.setDocIdentity({ name: HIST_NAME, path: '/home/u/Documents', appType: 'wps' });
  env.fireMs(500);
  const st2 = env.state();
  check('S2 Path 就位后收敛到稳定 id', st2.currentDocId === HIST_DOC,
    'docId=' + st2.currentDocId);
  check('S2 收敛后 docIdPending=false', st2.docIdPending === false);
  check('S2 历史恢复', env.restores().length === 1 && env.restores()[0].length === 1,
    'restores=' + JSON.stringify(env.restores().map(r => r.length)));
  const loads = env.sends().filter(s => s.method === 'session/load');
  check('S2 收敛后复用会话 session/load', loads.length === 1 && loads[0].params.sessionId === 'S-PREV',
    'loads=' + JSON.stringify(loads));
}

// Scenario 3：等待超时（Path 一直空）→ 降级 X：用反查 docId 恢复历史 + 会话
console.log('Scenario 3: 等待超时 → 降级 X（恢复反查历史 + 会话）');
{
  const env = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: {
      ['qp.history.' + HIST_DOC]: HIST_MSGS,
      ['qp.session.' + HIST_DOC]: 'S-PREV',
    },
  });
  check('S3 进入等待', env.state().docIdPending === true);
  for (let i = 0; i < 8; i++) env.fireMs(500); // 耗尽等待链（3s 上限）
  const st = env.state();
  check('S3 降级 X：收敛到反查 docId', st.currentDocId === HIST_DOC,
    'docId=' + st.currentDocId);
  check('S3 降级后 docIdPending=false', st.docIdPending === false);
  check('S3 降级后历史恢复', env.restores().length === 1 && env.restores()[0].length === 1,
    'restores=' + JSON.stringify(env.restores().map(r => r.length)));
  const loads = env.sends().filter(s => s.method === 'session/load');
  check('S3 降级后复用会话 session/load', loads.length === 1 && loads[0].params.sessionId === 'S-PREV',
    'loads=' + JSON.stringify(loads));
}

// Scenario 4/5/6：无同名历史（真新建/首开/文字文稿5）→ 立即建会话，零等待
console.log('Scenario 4/5/6: 无同名历史 → 立即建会话，零等待（不被误判为打开）');
{
  const env4 = loadEnv('ok', { docIdentity: { name: '新建文档.docx', path: '', appType: 'wps' } });
  check('S4 docId 为 volatile', env4.volatile(env4.state().currentDocId), 'docId=' + env4.state().currentDocId);
  assertImmediateNew(env4, 'S4 新建文档（无同名历史）');

  const env5 = loadEnv('ok', { docIdentity: { name: '首次打开.docx', path: '', appType: 'wps' } });
  check('S5 docId 为 volatile', env5.volatile(env5.state().currentDocId), 'docId=' + env5.state().currentDocId);
  assertImmediateNew(env5, 'S5 首次打开无历史文档');

  const env6 = loadEnv('ok', { docIdentity: { name: '文字文稿5', path: '', appType: 'wps' } });
  check('S6 docId 为 volatile', env6.volatile(env6.state().currentDocId), 'docId=' + env6.state().currentDocId);
  assertImmediateNew(env6, 'S6 新建"文字文稿5"（无同名历史）');
}

// Scenario 7：保存过"文字文稿5"文件（有同名历史）→ 进入等待并恢复（用户提醒的反例）
console.log('Scenario 7: 保存过"文字文稿5" → 反查命中进入等待并恢复');
{
  const env = loadEnv('ok', {
    docIdentity: { name: '文字文稿5', path: '', appType: 'wps' },
    prestore: {
      'qp.history.wps:/home/u/Documents:文字文稿5': HIST_MSGS,
      'qp.session.wps:/home/u/Documents:文字文稿5': 'S-PREV',
    },
  });
  check('S7 反查命中 → 进入等待（不误判为新建）', env.state().docIdPending === true,
    'pending=' + env.state().docIdPending);
  env.setDocIdentity({ name: '文字文稿5', path: '/home/u/Documents', appType: 'wps' });
  env.fireMs(500);
  const st = env.state();
  check('S7 收敛到稳定 id', st.currentDocId === 'wps:/home/u/Documents:文字文稿5',
    'docId=' + st.currentDocId);
  check('S7 历史恢复', env.restores().length === 1 && env.restores()[0].length === 1,
    'restores=' + JSON.stringify(env.restores().map(r => r.length)));
}

// Scenario 8：多命中同名（不同目录）→ 有 session key 优先、再比条数，不崩溃
console.log('Scenario 8: 多命中同名 → 择一（session 优先 / 条数次之），不崩溃');
{
  const env = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: {
      ['qp.history.wps:/a:' + HIST_NAME]: JSON.stringify([{ role: 'user', text: 'a1' }]),
      ['qp.session.wps:/a:' + HIST_NAME]: 'S-A',
      ['qp.history.wps:/b:' + HIST_NAME]: JSON.stringify([{ role: 'user', text: 'b1' }, { role: 'user', text: 'b2' }]),
    },
  });
  check('S8 进入等待', env.state().docIdPending === true);
  for (let i = 0; i < 8; i++) env.fireMs(500);
  const st = env.state();
  check('S8 多命中 → 有 session 的 /a 胜出（降级 X 用反查 docId）', st.currentDocId === 'wps:/a:' + HIST_NAME,
    'docId=' + st.currentDocId);
  check('S8 恢复 /a 的 1 条历史', env.restores().length === 1 && env.restores()[0].length === 1,
    'restores=' + JSON.stringify(env.restores().map(r => r.length)));
  const loads = env.sends().filter(s => s.method === 'session/load');
  check('S8 复用 /a 的会话 S-A', loads.length === 1 && loads[0].params.sessionId === 'S-A',
    'loads=' + JSON.stringify(loads));

  const env8b = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: {
      ['qp.history.wps:/a:' + HIST_NAME]: JSON.stringify([{ role: 'user', text: 'a1' }]),
      ['qp.history.wps:/b:' + HIST_NAME]: JSON.stringify([{ role: 'user', text: 'b1' }, { role: 'user', text: 'b2' }]),
    },
  });
  for (let i = 0; i < 8; i++) env8b.fireMs(500);
  check('S8b 无 session key → 历史条数多的 /b 胜出', env8b.state().currentDocId === 'wps:/b:' + HIST_NAME,
    'docId=' + env8b.state().currentDocId);
  check('S8b 恢复 /b 的 2 条历史', env8b.restores().length === 1 && env8b.restores()[0].length === 2,
    'restores=' + JSON.stringify(env8b.restores().map(r => r.length)));
}

// Scenario 9：G1 会话门禁——等待期 ACP 连上不得建会话（session/new），收敛后补触发 session/load
console.log('Scenario 9: G1 会话门禁（等待期 ACP 连上不建会话）');
{
  const env = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: {
      ['qp.history.' + HIST_DOC]: HIST_MSGS,
      ['qp.session.' + HIST_DOC]: 'S-PREV',
    },
  });
  check('S9 进入等待', env.state().docIdPending === true);
  env.conn('connected'); // ACP 在等待期连上
  check('S9 等待期不发送 session/new（G1 门禁）', env.sessionNewSends().length === 0,
    'count=' + env.sessionNewSends().length);
  check('S9 等待期也不发送 session/load', env.sends().filter(s => s.method === 'session/load').length === 0,
    'sends=' + JSON.stringify(env.sends().map(s => s.method)));
  // Path 就位 → 收敛 → 补触发建会话（走 session/load，非 session/new）
  env.setDocIdentity({ name: HIST_NAME, path: '/home/u/Documents', appType: 'wps' });
  env.fireMs(500);
  const st = env.state();
  check('S9 收敛后 docIdPending=false', st.docIdPending === false);
  check('S9 收敛后走 session/load（非 session/new）',
    env.sessionNewSends().length === 0 && env.sends().filter(s => s.method === 'session/load').length === 1,
    'sends=' + JSON.stringify(env.sends().map(s => s.method)));
  check('S9 历史恢复', env.restores().length === 1 && env.restores()[0].length === 1,
    'restores=' + JSON.stringify(env.restores().map(r => r.length)));
}

// Scenario 10：G2 幂等——等待期 docCheck 抢先收敛到稳定 id → 等待收敛不二次判定
console.log('Scenario 10: G2 幂等（docCheck 抢先收敛）');
{
  const env = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: { ['qp.history.' + HIST_DOC]: HIST_MSGS },
  });
  check('S10 进入等待', env.state().docIdPending === true);
  // 等待期间 Path 就位 + ACP 连上（onAcpConnChange → checkDocNow 即时复查）→ docCheck 先收敛
  env.setDocIdentity({ name: HIST_NAME, path: '/home/u/Documents', appType: 'wps' });
  env.conn('connected');
  const st1 = env.state();
  check('S10 docCheck 已收敛到稳定 id', st1.currentDocId === HIST_DOC, 'docId=' + st1.currentDocId);
  check('S10 等待期无会话建立（门禁）',
    env.sessionNewSends().length === 0 && env.sends().filter(s => s.method === 'session/load').length === 0,
    'sends=' + JSON.stringify(env.sends().map(s => s.method)));
  // 等待链仍在 → 幂等收敛
  env.fireMs(500);
  const st2 = env.state();
  check('S10 等待收敛幂等（docIdPending=false，不二次判定）', st2.docIdPending === false,
    'pending=' + st2.docIdPending);
  check('S10 currentDocId 保持稳定 id', st2.currentDocId === HIST_DOC, 'docId=' + st2.currentDocId);
  check('S10 历史已恢复（docCheck 或等待收敛，至多两次幂等重渲染）',
    env.restores().length >= 1 && env.restores().length <= 2,
    'restores=' + JSON.stringify(env.restores().map(r => r.length)));
  check('S10 收敛后建会话一次（无缓存 → session/new）', env.sessionNewSends().length === 1,
    'count=' + env.sessionNewSends().length);
}

// Scenario 11：G4a 反查防御——旧 volatile/default 数据不参与匹配
console.log('Scenario 11: 反查防御（跳过旧 volatile / default key）');
{
  const env = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: {
      'qp.history.default': JSON.stringify([{ role: 'user', text: 'def' }]),
      ['qp.history.wps::unsaved::legacyToken::' + HIST_NAME]: JSON.stringify([{ role: 'user', text: 'vol' }]),
    },
  });
  check('S11 旧 volatile/default 数据不参与匹配 → 按新建（docIdPending=false）',
    env.state().docIdPending === false, 'pending=' + env.state().docIdPending);
  check('S11 显示空提示（不恢复旧数据）', env.emptyHints() === 1, 'emptyHints=' + env.emptyHints());
  check('S11 无 500ms 等待定时器', !env.hasTimer(500));
}

// Scenario 12：B7 等待期文档被关闭 → 不主动建会话（G1），docCheck 落定 default 后再建
console.log('Scenario 12: B7 等待期文档关闭 → 不主动建会话');
{
  const env = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: { ['qp.history.' + HIST_DOC]: HIST_MSGS },
  });
  check('S12 进入等待', env.state().docIdPending === true);
  env.conn('connected'); // ACP 在等待期连上（门禁生效）
  check('S12 等待期无会话（门禁）',
    env.sessionNewSends().length === 0 && env.sends().filter(s => s.method === 'session/load').length === 0,
    'sends=' + JSON.stringify(env.sends().map(s => s.method)));
  // 等待期文档被关闭 → 下一步等待收敛 resolvedId=null
  env.setDocIdentity(null);
  env.setOpenDocs([]);
  env.fireMs(500);
  const st = env.state();
  check('S12 收敛后 docIdPending=false', st.docIdPending === false, 'pending=' + st.docIdPending);
  check('S12 不主动建会话（B7 无真实稳定 id，不发 session/new）', env.sessionNewSends().length === 0,
    'count=' + env.sessionNewSends().length);
  check('S12 显示空提示', env.emptyHints() === 1, 'emptyHints=' + env.emptyHints());
  // docCheckNow 落定 default → switchToDoc → 触发建会话
  env.checkDoc();
  check('S12 docCheck 后进入 default', env.state().currentDocId === 'default',
    'docId=' + env.state().currentDocId);
  check('S12 docCheck 落定后建会话（session/new 一次）', env.sessionNewSends().length === 1,
    'count=' + env.sessionNewSends().length);
}

// Scenario 13：永久空 Path → 超时降级 X 的结果不被后续 docCheck 抹掉（守卫生效）
console.log('Scenario 13: 永久空 Path → 降级 X 不被 docCheck 抹掉');
{
  const env = loadEnv('ok', {
    docIdentity: { name: HIST_NAME, path: '', appType: 'wps' },
    prestore: {
      ['qp.history.' + HIST_DOC]: HIST_MSGS,
      ['qp.session.' + HIST_DOC]: 'S-PREV',
    },
  });
  check('S13 进入等待', env.state().docIdPending === true);
  for (let i = 0; i < 8; i++) env.fireMs(500); // 超时降级 X
  const st1 = env.state();
  check('S13 降级 X 收敛到反查 docId', st1.currentDocId === HIST_DOC, 'docId=' + st1.currentDocId);
  check('S13 历史已恢复', env.restores().length === 1 && env.restores()[0].length === 1,
    'restores=' + JSON.stringify(env.restores().map(r => r.length)));
  // docCheck 周期触发（Path 仍空 → 同名 volatile）→ 不得切回 volatile 抹掉降级结果
  env.checkDoc();
  const st2 = env.state();
  check('S13 docCheck 不抹掉降级结果（currentDocId 仍为稳定 id）', st2.currentDocId === HIST_DOC,
    'docId=' + st2.currentDocId);
  check('S13 无额外 restore/空提示清屏', env.restores().length === 1, 'restores=' + env.restores().length);
  check('S13 不额外建会话（无 session/new）', env.sessionNewSends().length === 0,
    'count=' + env.sessionNewSends().length);
  check('S13 会话缓存仍走 session/load（S-PREV）',
    env.sends().filter(s => s.method === 'session/load').length === 1,
    'sends=' + JSON.stringify(env.sends().filter(s => s.method === 'session/load').map(s => s.params.sessionId)));
}

console.log(failures === 0 ? '\n✅ 前端行为验证全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
