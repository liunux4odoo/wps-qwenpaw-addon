#!/usr/bin/env node
/**
 * Frontend 行为验证：每个场景用**全新环境**加载真实 js/main.js（vm sandbox + DOM/XHR/AcpClient 桩），
 * 验证 plan-2026-09-04 §6.2（会话建立看门狗：超时清 pending + 重试 ≤1 + 可见错误）
 * 与 §6.3（/config 不可达：不静默带相对路径 spawn；恢复后能继续）。
 *
 * 用法：node /tmp/kilo/test_frontend_race.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const MAIN_JS = path.join(__dirname, '..', 'js', 'main.js');
const WATCHDOG_MS = 25000;

function loadEnv(initialConfigMode) {
  let configMode = initialConfigMode;
  const st = {
    timers: [], timerSeq: 0,
    chatCalls: { status: [], messages: [], errorCards: [] },
    acpCalls: { send: [], connected: false }, acpIdSeq: 0,
    store: {}, els: {},
    acpCbs: { conn: null, response: null, update: null, request: null },
  };

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
    setInputEnabled() {}, setBusy() {}, appendAssistantChunk() {}, finishAssistant() {},
    addToolCard() { return {}; }, markToolCard() {},
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
        finish(200, { wpsMcpEntry: '/abs/wps/index.js', pollPortStart: 59000, pollPortEnd: 59999 });
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
    finish(404, {});
  };

  const sandbox = {
    console, Date, Math, JSON,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
    XMLHttpRequest: XHRStub, localStorage: localStorageStub,
    document: documentStub, alert() {},
    ChatUi: ChatUiStub, AcpClient: AcpClientStub,
    WpsPollClient: WpsPollClientStub, WpsBridge: WpsBridgeStub,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MAIN_JS, 'utf8'), sandbox, { filename: 'main.js' });

  return {
    setConfig(mode) { configMode = mode; },
    conn(state) { st.acpCbs.conn(state); },
    respond(id, result, error) { st.acpCbs.response(id, result, error); },
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

console.log(failures === 0 ? '\n✅ 前端行为验证全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
