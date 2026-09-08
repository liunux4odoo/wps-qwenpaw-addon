/**
 * agents.js — agent / ACP server 选择与设置面板（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：P3 agent 列表加载与切换 + Phase 3（plan-2026-09-05 §7）
 * ACP server 列表 / 切换 / 会话重置 / 设置面板绑定。applyConfigOption 亦定义于本文件
 * （bindSettingsUI 的 model/effort 下拉使用）。
 * 依赖：QP（app-state.js）、AcpClient、ChatUi、QPLog，以及 bridge-config.js 的
 * fetchBridgeConfig、session.js 的 clearSessionWatchdog/ensureSession、watchdog.js 的
 * clearPromptTimers、actions.js 的 updateSendAvailability/clearCurrentSession。
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见；导出跨文件函数（globalThis === window）。
 */
(function () {
  'use strict';
  var S = QP.state;

  // ── P3：agent 列表加载与切换 ──
  // bridge /agents 返回可用 agent 列表（qwenpaw agent list）；/agent/set 切换（重启 qwenpaw acp 子进程）。
  // 前端 localStorage 记住上次选择，刷新/重启自动回填。agent 切换后旧 sessionId 失效 → 重建会话。
  function loadAgentList() {
    var el = document.getElementById('agentSelect');
    if (!el) return;
    // Phase 3：agent 选择按 server 隔离（agentKey 已 server-scoped；旧全局 key 兼容回退）
    S.agentCached = QP.loadSavedAgent();
    // qwenpaw agent list 冷启动约 8s（bridge 已 TTL 缓存+预取，但首次仍可能慢），给足超时
    // 重试间隔需盖过 bridge 的失败负缓存窗口（AGENTS_FAIL_TTL=5s），否则重试命中缓存空列表
    var attempts = 0;
    var delays = [6000, 8000];
    function attempt() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'http://127.0.0.1:8766/agents', true);
      xhr.timeout = 20000;
      xhr.onload = function () {
        if (xhr.status !== 200) { fail('HTTP ' + xhr.status); return; }
        try {
          var r = JSON.parse(xhr.responseText);
          S.agentList = r.agents || [];
          if (!S.agentList.length) { fail('空列表'); return; }
          var cur = r.current || null;
          // 记住的上次选择优先；否则用 bridge 当前 agent
          var target = S.agentCached || cur;
          populateAgentSelect(el, S.agentList, target);
          if (S.agentCached && S.agentCached !== cur) {
            QPLog('P3', '上次选择 agent=' + S.agentCached + ' 与 bridge 当前=' + cur + ' 不一致，请求切换');
            switchAgent(S.agentCached);
          }
        } catch (e) { fail('解析失败'); }
      };
      xhr.onerror = function () { fail('网络错误'); };
      xhr.ontimeout = function () { fail('超时'); };
      xhr.send();
    }
    function fail(reason) {
      QPLog('P3', 'agent 列表加载失败: ' + reason);
      if (attempts < delays.length) {
        var d = delays[attempts];
        attempts++;
        setTimeout(attempt, d);
      } else {
        populateAgentSelect(el, [], null);
      }
    }
    attempt();
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
    S.agentCached = agentId; // P3：同步内存态（set_config_option 应用 / 重连重建时读取）
    QP.saveSavedAgent(agentId); // Phase 3：按当前 server 维度持久化（agentKey server-scoped）
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'http://127.0.0.1:8766/agent/set?agent=' + encodeURIComponent(agentId), true);
    xhr.timeout = 10000;
    xhr.onload = function () {
      var ok = false;
      try { ok = xhr.status === 200 && JSON.parse(xhr.responseText).ok; } catch (e) {}
      if (!ok) {
        QPLog('P3', 'agent 切换失败 HTTP ' + xhr.status);
        ChatUi.addMessage('error', 'agent 切换失败');
        return;
      }
      QPLog('P3', 'agent 切换成功: ' + agentId);
      // Phase 2 C3：切换语义按能力标志——
      //   config_option（opencode）：mode 是会话级 set_config_option（V11），对当前会话应用即可，
      //     不销毁会话/历史（与 qwenpaw restart 的"重建"语义不同）；
      //   restart（qwenpaw）：kill+重启子进程 → 旧 sessionId 失效，清空重建（原行为）。
      if (S.capabilities.switchSemantics === 'config_option') {
        if (S.acpSessionId) {
          var cid = AcpClient.send('session/set_config_option', {
            sessionId: S.acpSessionId, configId: 'mode', value: agentId
          });
          if (cid !== null) S.pendingRequests[cid] = { method: 'session/set_config_option' };
          QPLog('P3', 'config_option 切换：set_config_option(mode=' + agentId + ') id=' + cid);
          ChatUi.addMessage('system', '已切换 mode 到「' + agentId + '」（当前会话生效）');
        } else {
          // 无当前会话：选择已记录（agentCached/localStorage），下次建会话时 maybeApplyConfigOption 应用
          ChatUi.addMessage('system', '已选择 mode「' + agentId + '」，将在下次会话生效');
        }
        updateSendAvailability();
        return;
      }
      // 版本倾斜防护：bridge 是 opencode 但未下发 switchSemantics（旧 bridge）→ mode 切换不会真正
      // 生效，此时绝不能再静默销毁会话/历史（A3 无静默错误）。
      if (S.acpServerName === 'opencode' && S.capabilities.switchSemantics !== 'config_option') {
        QPLog('P3', '版本倾斜：acpServer=opencode 但无 switchSemantics=config_option，切换不会生效');
        ChatUi.addMessage('error', '检测到 bridge 版本过旧（未下发 switchSemantics），opencode mode 切换不会生效。请重启 bridge 后再试。');
        return;
      }
      // restart 语义（qwenpaw）：旧 sessionId 随子进程重启失效，清当前会话状态 + 内存/缓存，重建。
      // 同步清 docStates 的 messages 与 localStorage 历史：新 agent = 全新会话无记忆，
      // 若保留旧消息，切走再切回会显示死会话的旧记录（P15「用户看得见但 AI 不记得 = 误导」）。
      ChatUi.addMessage('system', '已切换到 agent「' + agentId + '」，正在重建会话…');
      S.acpSessionId = null;
      QP.saveCachedSessionId(S.currentDocId, null);
      if (S.currentDocId) {
        S.docStates[S.currentDocId] = { acpSessionId: null, messages: [] };
        QP.saveHistory(S.currentDocId, []);
      }
      ChatUi.clear();
      ChatUi.showEmptyHint();
      if (S.acpState === 'connected') ensureSession();
      updateSendAvailability(); // P21：agent 切换重建中会话未建 → 发送按钮禁用
    };
    xhr.onerror = function () {
      ChatUi.addMessage('error', 'agent 切换失败（bridge 不可达）');
    };
    xhr.send();
  }

  // ── Phase 3：ACP server 配置（plan-2026-09-05 §7）──

  // 生成人类可读的能力差异说明（UI 展示用，如 opencode 无审批 / 中止=重建会话）
  function describeCapabilities(caps) {
    if (!caps) return [];
    var notes = [];
    if (caps.approval === 'none') notes.push('无审批环节（工具直接执行）');
    else if (caps.approval === 'manual') notes.push('工具调用需手动确认');
    if (caps.cancel === false) notes.push('中止 = 结束会话重建');
    if (caps.switchSemantics === 'config_option') notes.push('agent/mode 为会话级配置');
    if (caps.thoughtHeartbeat === false) notes.push('无思考心跳，按任意下行续命');
    if (caps.loadSession === false) notes.push('不支持历史会话恢复');
    return notes;
  }

  // 更新能力说明展示（设置面板 + server 下拉）
  function updateCapabilityUI() {
    var notes = describeCapabilities(S.capabilities);
    ChatUi.setCapabilityNotes(notes.length ? '能力说明：' + notes.join('；') : '');
    var desc = '';
    for (var i = 0; i < S.serverList.length; i++) {
      if (S.serverList[i].name === S.acpServerName) desc = S.serverList[i].description || '';
    }
    ChatUi.setServerDesc(desc || (S.acpServerName ? '当前：' + S.acpServerName : ''));
  }

  // 加载可用 server 列表（/servers）并填充下拉；与 bridge 当前值对齐并校验本地记录
  // skipAutoSwitch=true 时只刷新显示，不触发自动切换（/server/set 失败回滚用，防无限重试循环）
  function loadServerList(skipAutoSwitch) {
    try { S.serverCached = localStorage.getItem(QP.serverKey()) || null; } catch (e) {}
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'http://127.0.0.1:8766/servers', true);
    xhr.timeout = 10000;
    xhr.onload = function () {
      if (xhr.status !== 200) { ChatUi.setServerList([], null); return; }
      try {
        var r = JSON.parse(xhr.responseText);
        S.serverList = r.servers || [];
        var current = r.current || null;
        ChatUi.setServerList(S.serverList, current);
        updateCapabilityUI();
        // 记住的上次选择与 bridge 当前不一致 → 自动切换（A7：重启加载项后仍生效）
        // skipAutoSwitch（切换失败回滚）时跳过：只显示 bridge 实际 server，不重试（防循环）
        if (!skipAutoSwitch && S.serverCached && current && S.serverCached !== current) {
          QPLog('main', '上次选择 server=' + S.serverCached + ' 与 bridge 当前=' + current + ' 不一致，请求切换');
          switchServer(S.serverCached);
        }
      } catch (e) { ChatUi.setServerList([], null); }
    };
    xhr.onerror = function () { ChatUi.setServerList([], null); };
    xhr.ontimeout = function () { ChatUi.setServerList([], null); };
    xhr.send();
  }

  // 切换 ACP server：POST /server/set（bridge 换 adapter + 重启子进程），成功后重置会话并重建
  function switchServer(name) {
    if (!name) return;
    QPLog('main', '切换 ACP server: ' + name);
    S.serverCached = name;
    try { localStorage.setItem(QP.serverKey(), name); } catch (e) {}
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'http://127.0.0.1:8766/server/set?server=' + encodeURIComponent(name), true);
    xhr.timeout = 20000; // 含子进程重启（bridge SWITCH_READY_TIMEOUT=8s）+ 余量
    xhr.onload = function () {
      var ok = false;
      try { ok = xhr.status === 200 && JSON.parse(xhr.responseText).ok; } catch (e) {}
      if (!ok) {
        QPLog('main', 'server 切换失败 HTTP ' + xhr.status);
        ChatUi.addMessage('error', 'ACP server 切换失败');
        loadServerList(true); // 回滚显示为 bridge 实际 server；skipAutoSwitch 防无限重试循环
        return;
      }
      QPLog('main', 'server 切换成功: ' + name);
      // 切换后：重新拉 /config（acpServerName + capabilities 随 server 变化）→ 重置会话 → 重建
      fetchBridgeConfig(function () {
        resetAfterServerSwitch();
        loadAgentList();
        if (S.acpState === 'connected') ensureSession();
        updateSendAvailability();
      }, function () {
        // /config 失败不阻塞：仍重置会话（capabilities 保持旧值，版本倾斜由 switchAgent 防护）
        QPLog('main', 'server 切换后 /config 拉取失败，按旧能力继续');
        resetAfterServerSwitch();
        loadAgentList();
        if (S.acpState === 'connected') ensureSession();
        updateSendAvailability();
      });
    };
    xhr.onerror = function () {
      QPLog('main', 'server 切换网络错误');
      ChatUi.addMessage('error', 'ACP server 切换失败（bridge 不可达）');
    };
    xhr.send();
  }

  // server 切换后的会话重置：旧 session 属于旧 server，一律清空重建（同 agent restart 语义）
  function resetAfterServerSwitch() {
    // 清理进行中请求（旧 server 子进程已被 bridge 重启，响应不可信）
    // 关键：清掉在途的 session/new|load——否则 ensureSession 被 stale pending 挡住
    //（其子进程已 kill，响应永不到达 → 25s 看门狗误报"会话建立失败"），见 review finding。
    for (var pk in S.pendingRequests) {
      var p = S.pendingRequests[pk];
      if (p && (p.method === 'session/new' || p.method === 'session/load')) {
        delete S.pendingRequests[pk];
      }
    }
    clearSessionWatchdog();
    if (S.waitingResponse) {
      var reqId = S.lastPromptReqId;
      if (reqId !== null && S.pendingRequests[reqId]) delete S.pendingRequests[reqId];
      S.lastPromptReqId = null;
      S.waitingResponse = false;
      S.gotFirstChunk = false;
      clearPromptTimers();
      var cards = S.pendingToolCards.slice();
      S.pendingToolCards = [];
      for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'cancelled');
      ChatUi.hideTyping();
      ChatUi.setBusy(false);
      S.streamBuffer = '';
    }
    S.acpSessionId = null;
    QP.saveCachedSessionId(S.currentDocId, null);
    if (S.currentDocId) {
      S.docStates[S.currentDocId] = { acpSessionId: null, messages: [] };
      QP.saveHistory(S.currentDocId, []);
    }
    ChatUi.clear();
    ChatUi.showEmptyHint();
    S.currentConfigOptions = null;         // 不同 server 的 configOptions 不同
    ChatUi.populateConfigOptions(null, null); // 隐藏 model/effort 配置行
    updateCapabilityUI();                // 能力差异随 server 变化
    // P8：服务器切换重置了在途响应 → 执行被延迟的文档切换（避免 docSwitchDeferred 滞留）
    try { if (typeof flushDeferredDocSwitch === 'function') flushDeferredDocSwitch(); } catch (e) {}
    QPLog('main', 'server 切换：会话已重置，等待重建');
  }

  // 绑定设置按钮（开关设置面板）+ server 下拉 change + model/effort 下拉 change
  function bindSettingsUI() {
    var sbtn = document.getElementById('settingsBtn');
    if (sbtn) {
      sbtn.addEventListener('click', function () {
        S.settingsOpen = !S.settingsOpen;
        ChatUi.toggleSettings(S.settingsOpen);
      });
    }
    var ssel = document.getElementById('serverSelect');
    if (ssel) {
      ssel.addEventListener('change', function () {
        if (ssel.value && ssel.value !== S.acpServerName) switchServer(ssel.value);
      });
    }
    var msel = document.getElementById('modelSelect');
    if (msel) {
      msel.addEventListener('change', function () {
        if (msel.value && S.acpSessionId) applyConfigOption('model', msel.value);
      });
    }
    var esel = document.getElementById('effortSelect');
    if (esel) {
      esel.addEventListener('change', function () {
        if (esel.value && S.acpSessionId) applyConfigOption('effort', esel.value);
      });
    }
  }

  // 应用会话级配置（opencode set_config_option，V9：configOptions 只读不生效，只能 set）
  // 同时持久化到 localStorage（会话级不跨会话，新会话由 maybeApplyConfigOption 重新应用）
  function applyConfigOption(configId, value) {
    if (!value) return;
    var saved = QP.loadSavedConfigOptions();
    saved[configId] = value;
    QP.saveSavedConfigOptions(saved);
    if (!S.acpSessionId) {
      QPLog('main', '已记录 ' + configId + '=' + value + '（无会话，将在下次会话生效）');
      return;
    }
    var id = AcpClient.send('session/set_config_option', {
      sessionId: S.acpSessionId, configId: configId, value: value
    });
    if (id !== null) {
      S.pendingRequests[id] = { method: 'session/set_config_option' };
      QPLog('main', 'set_config_option(' + configId + '=' + value + ') id=' + id);
    }
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

  // 导出跨文件函数（globalThis === window）
  globalThis.loadAgentList = loadAgentList;
  globalThis.switchAgent = switchAgent;
  globalThis.updateCapabilityUI = updateCapabilityUI;
  globalThis.loadServerList = loadServerList;
  globalThis.bindSettingsUI = bindSettingsUI;
  globalThis.bindClearButton = bindClearButton;
})();
