/**
 * acp-events.js — ACP 响应 / 流式通知 / 服务端请求处理（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：ACP 事件回调（onResponse / onSessionUpdate / onRequest）
 * 与 configOptions 解析（parseConfigOptions 定义于本文件，onAcpResponse 内调用）。
 * 依赖：QP（app-state.js）、AcpClient、ChatUi、QPLog，以及 watchdog.js 的
 * touchActivity/clearPromptTimers、session.js 的 clearSessionWatchdog/ensureSession/
 * maybeApplyConfigOption、actions.js 的 updateSendAvailability、doc-state.js 的
 * schedulePersist、agents.js 的 updateCapabilityUI（fetchBridgeConfig 链路）。
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见；导出跨文件函数（globalThis === window）。
 */
(function () {
  'use strict';
  var S = QP.state;

  // 解析 session/new 响应的 configOptions（opencode model/effort/mode），填充配置行 UI
  function parseConfigOptions(configOptions) {
    if (!configOptions || !Array.isArray(configOptions)) return;
    if (S.capabilities.switchSemantics !== 'config_option') return; // 仅 opencode 等 config_option 语义
    S.currentConfigOptions = configOptions;
    var modelOpt = null, effortOpt = null;
    for (var i = 0; i < configOptions.length; i++) {
      var o = configOptions[i];
      if (o && o.id === 'model') modelOpt = o;
      else if (o && o.id === 'effort') effortOpt = o;
    }
    var saved = QP.loadSavedConfigOptions();
    ChatUi.populateConfigOptions(modelOpt, effortOpt, saved.model, saved.effort);
  }

  // ── ACP 响应处理 ──
  function onAcpResponse(id, result, error) {
    var req = S.pendingRequests[id];
    if (!req) return;
    QPLog('main', 'ACP 响应 id=' + id + ' method=' + req.method + (error ? ' error=' + JSON.stringify(error).slice(0, 200) : ''));

    if (req.method === 'session/new' || req.method === 'session/load') {
      clearSessionWatchdog(); // 任何响应（成功/失败）都结束在途等待
      if (error) {
        if (req.method === 'session/load') {
          // 旧 sessionId 失效（bridge/qwenpaw 重启）：清缓存回退 session/new，这是预期降级
          QPLog('P15', 'session/load 失败，清缓存重建: ' + JSON.stringify(error).slice(0, 150));
          QP.saveCachedSessionId(S.currentDocId, null);
          ChatUi.addMessage('system', '上次会话已失效，正在创建新会话…');
          if (!S.acpSessionId) ensureSession(); // 回退 session/new
        } else {
          S.sessionFailed = true; // P21：创建会话即时报错 → 发送按钮保持禁用 + 可重建
          ChatUi.setStatus('ACP: 会话创建失败');
          ChatUi.addErrorCard('会话创建失败', (error.message || JSON.stringify(error)) + '。可重建会话后重试。', { rebuild: true });
          updateSendAvailability(); // P21：失败态刷新占位
        }
      } else if (result && result.sessionId) {
        S.acpSessionId = result.sessionId;
        QP.saveCachedSessionId(S.currentDocId, S.acpSessionId);
        S.sessionRetries = 0; // 建立成功：清重试计数（下次切换/重建重新计时）
        S.sessionFailed = false; // P21：建立成功 → 清除失败标记
        // P16：仅 session/new 的新会话在首条 prompt 注入环境上下文；session/load（重开文档）不注入
        S.preamblePending = (req.method === 'session/new');
        QPLog('main', req.method + ' 成功 sessionId=' + S.acpSessionId + (S.preamblePending ? '（待注入环境上下文）' : ''));
        ChatUi.setStatus('就绪');
        updateSendAvailability(); // P21：会话建立成功 → 启用发送
        // Phase 3：解析 session/new 返回的 configOptions（opencode model/effort），填充配置行 UI
        parseConfigOptions(result.configOptions);
        // Phase 2 C3：opencode 会话级 mode 应用（V11 set_config_option；qwenpaw restart 语义跳过）
        maybeApplyConfigOption(S.acpSessionId);
      } else if (req.method === 'session/load' && QP.loadCachedSessionId(S.currentDocId)) {
        // session/load 成功但未返回 sessionId：复用请求时用的缓存 id
        S.acpSessionId = QP.loadCachedSessionId(S.currentDocId);
        S.preamblePending = false; // P16：load 不注入
        S.sessionRetries = 0;
        S.sessionFailed = false; // P21：恢复成功 → 清除失败标记
        QPLog('P15', 'session/load 成功（未回 sessionId，复用缓存）=' + S.acpSessionId);
        ChatUi.setStatus('就绪');
        updateSendAvailability(); // P21：会话恢复成功 → 启用发送
        parseConfigOptions(result.configOptions); // Phase 3：同 new 场景解析 configOptions
        maybeApplyConfigOption(S.acpSessionId); // Phase 2 C3：同 load 场景
      }
    } else if (req.method === 'session/prompt') {
      // 完整响应到达：流式结束，收尾 assistant 消息
      S.waitingResponse = false;
      S.gotFirstChunk = false;
      clearPromptTimers();
      S.lastPromptReqId = null;
      // P8：响应结束 → 执行在途期间被延迟的文档切换（AI 工具切文档不中止自身响应）
      try { if (typeof flushDeferredDocSwitch === 'function') flushDeferredDocSwitch(); } catch (e) {}
      ChatUi.finishAssistant();
      ChatUi.hideTyping();
      updateSendAvailability(); // P21：回复结束 → 恢复可发送（若会话仍有效）
      ChatUi.setBusy(false);
      var cards = S.pendingToolCards.slice();
      S.pendingToolCards = [];
      if (error) {
        // 会话可能已失效（如 bridge/qwenpaw 重启）：清除旧 sessionId 并重建
        QPLog('P2', 'session/prompt 错误 -> 重建会话: ' + JSON.stringify(error).slice(0, 200));
        for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'error');
        ChatUi.addErrorCard('对话中断', (error.message || JSON.stringify(error)) + '。可重试当前消息或重建会话。', { retry: true, rebuild: true });
        S.acpSessionId = null;
        ensureSession();
        ChatUi.setStatus('ACP: 会话重建中…');
        updateSendAvailability(); // P21：会话已失效重建中 → 发送按钮禁用（"正在创建会话…"占位）
      } else {
        var stopReason = result && result.stopReason;
        QPLog('P2', 'session/prompt 结束 stopReason=' + stopReason + ' 累计流式长度=' + S.streamBuffer.length);
        if (stopReason === 'cancelled') {
          for (var j = 0; j < cards.length; j++) ChatUi.markToolCard(cards[j], 'cancelled');
          ChatUi.addMessage('system', '已停止');
          ChatUi.setStatus('已停止');
        } else {
          for (var k = 0; k < cards.length; k++) ChatUi.markToolCard(cards[k], 'done');
          ChatUi.setStatus('已完成');
        }
      }
      S.streamBuffer = '';
      schedulePersist(); // P15：本轮结束落盘历史
    } else if (req.method === 'session/close') {
      // P19 竞态防护：清空/重建后立即 session/new 时，若 session/new 响应先于 close 到达
      //（acpSessionId 已是新会话），close 响应不得用 null 覆盖新会话——仅当仍是本次关闭的会话才清空。
      if (!S.acpSessionId || S.acpSessionId === req.sessionId) {
        S.acpSessionId = null;
        QP.saveCachedSessionId(S.currentDocId, null); // P15：关闭会话同步清 sessionId 缓存
        ChatUi.setStatus('ACP: 会话已关闭');
      }
      updateSendAvailability(); // P21：会话关闭 → 刷新发送可用性（重建中的清空场景保持禁用）
    }
    delete S.pendingRequests[id];
  }

  // ── ACP 流式通知（session/update） ──
  function onAcpSessionUpdate(sessionId, update) {
    if (!update) return;
    // 非当前会话的 session/update（如 cancel:false 中止 close 重建后，旧会话的残留流式/工具调用）
    // 一律不处理——不续命、不渲染。bridge 按 sessionId 路由且 close 后旧映射残留（见 review finding），
    // 若让旧会话的 tool_call 渲染，会污染新会话的 pendingToolCards/过程呈现。
    if (S.acpSessionId && sessionId && sessionId !== S.acpSessionId) return;
    // Phase 2 C6（plan-2026-09-05 §6.3）：看门狗改为"任意下行消息都续命"——
    // opencode 不发 agent_thought_chunk / status_update（V5 实测），长工具执行期只靠
    // tool_call / tool_call_update / usage_update / available_commands_update 证明存活；
    // 未识别 update 类型也一律续命（协议通用行为，不误报中断）。
    touchActivity();
    if (update.sessionUpdate === 'agent_message_chunk' && update.content) {
      var text = update.content.text || '';
      if (text) {
        // P5：无进行中请求（已停止/已恢复）→ 丢弃残留流式，不污染 UI
        if (!S.waitingResponse) {
          QPLog('P2', '丢弃残留流式 chunk');
          return;
        }
        if (!S.gotFirstChunk) {
          S.gotFirstChunk = true;
          QPLog('P2', 'first-chunk 到达');
          // P4：首个文本到达 → 工具阶段结束，进入"生成回复"阶段
          ChatUi.showTyping('正在生成回复…');
          var cards = S.pendingToolCards.slice();
          S.pendingToolCards = [];
          for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'done');
        }
        S.streamBuffer += text;
        ChatUi.appendAssistantChunk(text);
        schedulePersist(); // P15：流式过程中防抖落盘
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      // P2 v1.4：thinking 心跳——qwenpaw 思考时密集下发 agent_thought_chunk
      //（实测每 0.1-0.2s 一条），作为续命信号重置看门狗：即使无文本 chunk，
      // 长思考/静默期间看门狗也不触发（覆盖 91s+ thinking 完全静默窗口）。
      // 可选的"正在思考…"打字指示器：仅进行中请求 + 尚无首文本 chunk + 无工具卡片时提示
      //（避免覆盖 tool_call 阶段设置的"正在调用工具…"标签，见审查 finding）
      if (S.waitingResponse && !S.gotFirstChunk && S.pendingToolCards.length === 0) {
        ChatUi.showTyping('正在思考…');
      }
    } else if (update.sessionUpdate === 'tool_call') {
      // Phase 2：opencode 不发 request_permission/status_update（V4/V5），工具调用以
      // tool_call 下发——渲染工具卡片（P4 过程呈现），字段形状做防御式提取。
      if (!S.waitingResponse) return;
      var tct = update.toolCall || update.content || {};
      var tcName = tct.name || tct.title || tct.tool_call_id || '工具调用';
      var tcArgs = tct.arguments || tct.input || null;
      // 新工具调用 → 之前的工具已完成（标记 done），避免卡片滞留"调用中"
      var prevTc = S.pendingToolCards.slice();
      S.pendingToolCards = [];
      for (var p = 0; p < prevTc.length; p++) ChatUi.markToolCard(prevTc[p], 'done');
      ChatUi.showTyping('正在调用工具…');
      var tcCard = ChatUi.addToolCard(tcName, tcArgs ? JSON.stringify(tcArgs).slice(0, 200) : '');
      S.pendingToolCards.push(tcCard);
    } else if (update.sessionUpdate === 'status_update') {
      // P4：阶段/工具调用状态（qwenpaw 若下发 status_update）；仅进行中请求时处理
      if (!S.waitingResponse) return;
      var st = update.status || {};
      if (st.subtype === 'tool_call' && st.toolCall) {
        var tc = st.toolCall;
        var name = tc.title || tc.tool_call_id || '工具调用';
        // 新工具调用 → 之前的工具已完成（标记 done），避免卡片滞留"调用中"
        var prev = S.pendingToolCards.slice();
        S.pendingToolCards = [];
        for (var q = 0; q < prev.length; q++) ChatUi.markToolCard(prev[q], 'done');
        ChatUi.showTyping('正在调用工具…');
        var card = ChatUi.addToolCard(name);
        S.pendingToolCards.push(card);
      } else if (st.subtype === 'phase' || st.subtype === 'spinner') {
        var phaseLabel = st.label || st.text || '';
        if (phaseLabel) ChatUi.showTyping(phaseLabel);
      }
    }
  }

  // ── ACP 服务端请求（如 session/request_permission） ──
  // wps 工具 policy 为 default_effect: ask（§8.1）：每次工具调用需审批。
  // Phase 2 C5（plan-2026-09-05 §6.2）：审批行为按能力标志适配——
  //   approval=auto（qwenpaw 现状）：自动批准 allow_once（仅本次会话本次调用），无则取 options[0]；
  //   approval=none/manual（opencode 等）：不自动批准、不盲选第一个——弹 UI 手动确认
  //     （默认 build 权限全 allow 时 opencode 根本不发 request_permission，此路径只在改 ask 规则时触发）。
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
      if (S.waitingResponse) {
        // 新工具调用 → 之前的工具已结束（标记 done），避免多张卡片滞留"调用中"
        var prev = S.pendingToolCards.slice();
        S.pendingToolCards = [];
        for (var p = 0; p < prev.length; p++) ChatUi.markToolCard(prev[p], 'done');
        var card = ChatUi.addToolCard(toolTitle || '工具调用', toolArgs ? JSON.stringify(toolArgs).slice(0, 200) : '');
        S.pendingToolCards.push(card);
        ChatUi.showTyping('正在调用工具…');
      }
      var approvalMode = S.capabilities.approval || 'auto';
      if (approvalMode === 'auto') {
        // qwenpaw 现状：自动批准 allow_once（仅本次会话本次调用），无 allow_once 时取 options[0]。
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
      } else {
        // manual/none（opencode 改 ask 规则）：弹 UI 手动确认，不盲选（§6.2 降级兜底）。
        QPLog('main', 'request_permission: 手动审批（approval=' + approvalMode + '）tool=' + toolTitle);
        ChatUi.addApprovalCard(toolTitle || '工具调用', toolArgs ? JSON.stringify(toolArgs).slice(0, 200) : '', {
          onAllow: function () {
            // 用户显式允许：优先选最受限的授权 option（allow_once 一次性 > allow_session 会话级），
            // 避免单个"允许"点击意外授予持久权限（allow_always）；不盲选 options[0]。
            var best = null;
            var scoped = null;
            for (var j = 0; j < options.length; j++) {
              var oid = options[j].optionId || '';
              if (oid === 'allow_once') { best = options[j]; break; }
              if (oid === 'allow_session') { scoped = options[j]; }
            }
            if (!best) best = scoped;
            if (best) {
              AcpClient.respond(req.id, { outcome: { outcome: 'selected', optionId: best.optionId } });
              QPLog('main', 'request_permission: 手动允许 ' + best.optionId + ' (tool=' + toolTitle + ')');
            } else {
              // 无一次性/会话级 option（如只有 allow_always）：弹 UI 让用户明确选择，不替用户决定
              ChatUi.addMessage('system', '工具「' + toolTitle + '」需要更高权限授权，请在 AI 后端调整权限规则后重试。');
              AcpClient.respond(req.id, { outcome: { outcome: 'cancelled' } });
              QPLog('main', 'request_permission: 无一次性/会话级 option，已取消（避免误授持久权限）');
            }
          },
          onDeny: function () {
            AcpClient.respond(req.id, { outcome: { outcome: 'cancelled' } });
            QPLog('main', 'request_permission: 手动拒绝 (tool=' + toolTitle + ')');
          }
        });
      }
    }
  }

  // 导出跨文件函数（globalThis === window）
  globalThis.onAcpResponse = onAcpResponse;
  globalThis.onAcpSessionUpdate = onAcpSessionUpdate;
  globalThis.onAcpRequest = onAcpRequest;
})();
