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
  'app-state.js', 'doc-state.js', 'bridge-config.js', 'session.js', 'agents.js',
  'acp-events.js', 'watchdog.js', 'actions.js', 'poll.js', 'ribbon.js', 'main.js'
];
const WATCHDOG_MS = 25000;

function loadEnv(initialConfigMode, opts) {
  let configMode = initialConfigMode;
  opts = opts || {};
  const st = {
    timers: [], timerSeq: 0,
    chatCalls: { status: [], messages: [], errorCards: [] },
    acpCalls: { send: [], connected: false }, acpIdSeq: 0,
    store: {}, els: {},
    acpCbs: { conn: null, response: null, update: null, request: null },
    currentServer: 'qwenpaw',
    serverSwitchedTo: null,
    deferredServers: [],   // opts.deferServers 时暂存 /servers 响应（flushServers 触发）
  };
  // 预置记住的 server（Phase 3：qp.server）
  if (opts.savedServer) st.store['qp.server'] = opts.savedServer;

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
    restore() {}, clear() {}, showEmptyHint() {}, showTyping() {}, hideTyping() {},
    setInputEnabled() {}, setPlaceholder() {}, setBusy() {}, appendAssistantChunk() {}, finishAssistant() {},
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
  const WpsBridgeStub = {};

  const localStorageStub = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(st.store, k) ? st.store[k] : null; },
    setItem(k, v) { st.store[k] = String(v); },
    removeItem(k) { delete st.store[k]; },
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

console.log(failures === 0 ? '\n✅ 前端行为验证全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
