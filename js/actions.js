/**
 * actions.js — 用户动作与 UI 状态（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：P1 状态合并 / P5 中止 / P6 附件 / P7 自动展开 /
 * P13-P14-P19 清空 / P21 发送可用性 / 用户发送与重试重建。依赖：QP（app-state.js）、
 * AcpClient、ChatUi、QPLog，以及 session.js 的 ensureSession、watchdog.js 的
 * clearPromptTimers/startPromptTimers、doc-state.js 的 schedulePersist/buildPreamble。
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见；导出跨文件函数（globalThis === window）。
 */
(function () {
  'use strict';
  var S = QP.state;

  // ── P1：头部状态合并（一个状态区：ACP 连接 + WPS 桥，两级状态） ──
  // onPollStatus 每 500ms 回调一次，用 last*Shown 守卫避免重复写 DOM
  function updateStatus() {
    if (S.acpState !== S.lastAcpShown) {
      S.lastAcpShown = S.acpState;
      var label;
      if (S.acpState === 'connected') {
        label = '就绪';
      } else if (S.acpState === 'connecting') {
        label = '连接中';
      } else {
        label = '未连接';
      }
      ChatUi.setConnStateText(S.acpState, label);
    }
    var wps = (S.wpsState === 'connected') ? 'connected' : 'pending';
    if (wps !== S.lastWpsShown) {
      S.lastWpsShown = wps;
      if (wps === 'connected') {
        ChatUi.setWpsState('connected', 'WPS 已连接');
      } else {
        // P1/P20：懒启动端口连不上 = 预期行为（首次工具调用后才监听）。
        // 对话前显示"未激活"会误导用户以为异常——改为中性"待命"，不显示红色"错误"。
        ChatUi.setWpsState('pending', 'WPS 待命');
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

  // ── P21：发送按钮可用性统一判定 ──
  // 可对话条件 = ACP 已连接 + 会话已建立（acpSessionId 非空）+ 无进行中请求。
  // 条件不满足时禁用发送按钮并给出占位提示；随状态变化自动启用（bridge 就绪/会话建立成功）。
  // 注意：等待回复期间按钮禁用但"停止"仍可用（setBusy 独立控制 stopBtn，见 P5）。
  function updateSendAvailability() {
    var ready = (S.acpState === 'connected') && (S.acpSessionId !== null) && !S.waitingResponse;
    ChatUi.setInputEnabled(ready);
    var ph;
    if (S.acpState !== 'connected') {
      ph = '连接中…（等待 ACP 就绪）';
    } else if (S.sessionFailed && S.acpSessionId === null) {
      ph = '会话建立失败，请点击错误卡片重试';
    } else if (S.acpSessionId === null) {
      ph = '正在创建会话…';
    } else if (S.waitingResponse) {
      ph = 'AI 正在处理…';
    } else {
      ph = '输入指令，如：把第三段润色一下…（/help 查看指令）';
    }
    ChatUi.setPlaceholder(ph);
  }

  // ── P2：错误卡片按钮动作 ──
  function onRetry() {
    QPLog('P2', '用户点击"重试"');
    if (S.lastUserText) onUserSend(S.lastUserText);
  }

  function onRebuild() {
    QPLog('P2', '用户点击"重建会话"');
    if (S.acpSessionId) {
      var cid = AcpClient.send('session/close', { sessionId: S.acpSessionId });
      if (cid !== null) S.pendingRequests[cid] = { method: 'session/close', sessionId: S.acpSessionId };
    }
    S.acpSessionId = null;
    QP.saveCachedSessionId(S.currentDocId, null);
    if (S.currentDocId && S.docStates[S.currentDocId]) {
      S.docStates[S.currentDocId].acpSessionId = null; // 防切走再切回恢复死 session
    }
    ensureSession();
    updateSendAvailability(); // P21：重建期间会话未建 → 发送按钮禁用
  }

  // ── P13/P14/P19：清空当前会话（/clear 指令 + "清空对话"按钮共用） ──
  function clearCurrentSession() {
    QPLog('P19', '清空当前会话 docId=' + S.currentDocId);
    if (S.acpSessionId) {
      var cid = AcpClient.send('session/close', { sessionId: S.acpSessionId });
      // 记下被关闭的 sessionId：onAcpResponse 用其判断竞态（清空后立即新建的新会话不被 close 响应覆盖）
      if (cid !== null) S.pendingRequests[cid] = { method: 'session/close', sessionId: S.acpSessionId };
    }
    S.acpSessionId = null;
    QP.saveCachedSessionId(S.currentDocId, null);
    ChatUi.clear();
    ChatUi.showEmptyHint();
    S.streamBuffer = '';
    S.pendingAttachments = []; // P14：清空未发送的待选附件
    S.waitingResponse = false;
    S.gotFirstChunk = false;
    clearPromptTimers();
    // 清空时若仍有在途 prompt：删除其 pending 记录，防遗留响应被 onAcpResponse 处理——
    // 否则 stale 响应会清掉 P19 刚新建的会话（错误路径 acpSessionId=null）或打乱新会话上的在途请求（同 onStop）。
    if (S.lastPromptReqId !== null && S.pendingRequests[S.lastPromptReqId]) {
      delete S.pendingRequests[S.lastPromptReqId];
    }
    S.lastPromptReqId = null;
    var cards = S.pendingToolCards.slice();
    S.pendingToolCards = [];
    for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'cancelled');
    ChatUi.hideTyping();
    ChatUi.setBusy(false);
    S.docStates[S.currentDocId] = { acpSessionId: null, messages: [] };
    QP.saveHistory(S.currentDocId, []);
    // P8：响应结束后执行在途期间被延迟的文档切换（先清当前文档，再切到实际活动文档）
    try { if (typeof flushDeferredDocSwitch === 'function') flushDeferredDocSwitch(); } catch (e) {}
    // P19：清空后立即新建空会话（防止惰性新建与旧上下文串；新建失败由会话看门狗给可见错误+可重试，
    // 不清空动作不回滚）。新会话沿用 P16：session/new 成功置 preamblePending → 首条 prompt 重新注入
    // 环境上下文（重新现取当前文档身份）。
    if (S.acpState === 'connected') {
      ChatUi.setStatus('正在新建会话…');
      ensureSession();
    } else {
      ChatUi.setStatus('会话已清空（未连接，重连后自动建会话）');
    }
    updateSendAvailability(); // P21：会话未建 → 发送按钮保持禁用
  }

  // ── P5：中止执行 ──
  function onStop() {
    QPLog('P5', '用户点击"停止"');
    if (!S.waitingResponse) return;
    var reqId = S.lastPromptReqId;
    if (reqId !== null && S.pendingRequests[reqId]) {
      delete S.pendingRequests[reqId];
    }
    S.lastPromptReqId = null;
    S.waitingResponse = false;
    S.gotFirstChunk = false;
    clearPromptTimers();
    var cards = S.pendingToolCards.slice();
    S.pendingToolCards = [];
    for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'cancelled');
    ChatUi.hideTyping();
    updateSendAvailability(); // P21：停止后恢复可发送（若会话仍有效）
    ChatUi.setBusy(false);
    ChatUi.addMessage('system', '已停止');
    ChatUi.setStatus('已停止');
    S.streamBuffer = '';
    schedulePersist(); // P15：停止时保留已收到的部分回复
    if (S.acpSessionId) {
      // Phase 2 C8（plan-2026-09-05 §6.5/D8）：中止语义按能力标志适配。
      //   cancel=true（qwenpaw）：session/cancel（ACP 标准中止，会话保留）；
      //   cancel=false（opencode，V7 不支持 session/cancel）：中止 = 放弃当前会话（session/close），
      //     下次发送自动重建——有明确行为，不静默无效。
      if (S.capabilities.cancel) {
        var cid = AcpClient.send('session/cancel', { sessionId: S.acpSessionId });
        QPLog('P5', '已发送 session/cancel id=' + cid);
      } else {
        var oldSid = S.acpSessionId;
        var cid2 = AcpClient.send('session/close', { sessionId: oldSid });
        if (cid2 !== null) S.pendingRequests[cid2] = { method: 'session/close', sessionId: oldSid };
        QPLog('P5', 'opencode 不支持 cancel：已发送 session/close id=' + cid2 + '（中止=放弃会话，下次自动重建）');
        ChatUi.addMessage('system', '已停止（当前 AI 后端不支持取消，已结束本次会话，下次发送将自动新建会话）');
        S.acpSessionId = null;
        QP.saveCachedSessionId(S.currentDocId, null); // P15：同步清 sessionId 缓存
        if (S.currentDocId && S.docStates[S.currentDocId]) {
          S.docStates[S.currentDocId].acpSessionId = null; // 防切走再切回恢复死 session
        }
        if (S.acpState === 'connected') ensureSession();
        updateSendAvailability(); // P21：重建期间会话未建 → 发送按钮禁用
      }
    }
    // P8：停止后执行在途期间被延迟的文档切换
    try { if (typeof flushDeferredDocSwitch === 'function') flushDeferredDocSwitch(); } catch (e) {}
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
          if (text.length > QP.MAX_ATTACH_TEXT) {
            text = text.slice(0, QP.MAX_ATTACH_TEXT) + '\n…[内容过长已截断]';
          }
          S.pendingAttachments.push({ name: name, text: text });
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
    for (var i = 0; i < S.pendingAttachments.length; i++) {
      var att = S.pendingAttachments[i];
      if (!att || att.image) continue;
      blocks.push({
        type: 'text',
        text: '【附件：' + att.name + '】\n' + att.text
      });
    }
    return blocks;
  }

  function onUserSend(text) {
    QPLog('P2', '用户发送: ' + text.slice(0, 100) + (S.pendingAttachments.length ? '（附件 ' + S.pendingAttachments.length + ' 个）' : ''));
    if (!S.acpSessionId) {
      // 会话未就绪/失效（可能是 bridge 重启导致旧 sessionId 失效）：
      // 主动重建会话并提示用户重发
      ChatUi.addMessage('error', 'AI 会话未就绪，正在重建会话，请稍候重发…');
      ensureSession();
      return;
    }
    if (S.waitingResponse) {
      ChatUi.addMessage('system', '上一条还在处理中，请稍候…');
      return;
    }
    S.lastUserText = text;
    ChatUi.addMessage('user', text);
    if (S.pendingAttachments.length) {
      for (var a = 0; a < S.pendingAttachments.length; a++) {
        if (!S.pendingAttachments[a].image) {
          ChatUi.addMessage('system', '附件已随消息发送：' + S.pendingAttachments[a].name);
        }
      }
      S.pendingAttachments = [];
    }
    schedulePersist();
    S.waitingResponse = true;
    S.gotFirstChunk = false;
    updateSendAvailability(); // P21：等待回复 → 发送按钮禁用（停止按钮仍可用）
    ChatUi.setBusy(true);
    ChatUi.setStatus('处理中…');
    ChatUi.showTyping('思考中…');
    S.pendingToolCards = [];
    S.streamBuffer = '';
    var blocks = buildPromptBlocks(text);
    // P16：新会话（session/new）首条 prompt 注入环境上下文 preamble（独立文本块，不进用户气泡）；
    // 仅注入一次；session/load（重开文档）不注入；无活动文档优雅降级（跳过不崩溃）。
    if (S.preamblePending) {
      var pre = buildPreamble();
      S.preamblePending = false; // 无论是否取到文档，仅尝试注入一次
      if (pre) {
        blocks.unshift({ type: 'text', text: pre });
        QPLog('P16', '已向新会话注入环境上下文 preamble（blocks=' + blocks.length + '）');
      } else {
        QPLog('P16', '无活动文档，跳过环境上下文注入（优雅降级）');
      }
    }
    var id = AcpClient.send('session/prompt', {
      sessionId: S.acpSessionId,
      prompt: blocks
    });
    if (id !== null) {
      S.lastPromptReqId = id;
      S.pendingRequests[id] = { method: 'session/prompt' };
      QPLog('P2', 'prompt 已发送 id=' + id + ' sessionId=' + S.acpSessionId);
      startPromptTimers();
    } else {
      S.waitingResponse = false;
      S.gotFirstChunk = false;
      updateSendAvailability(); // P21：发送失败 → 恢复可发送
      ChatUi.setBusy(false);
      ChatUi.hideTyping();
      ChatUi.addMessage('error', '发送失败：未连接 ACP');
    }
  }

  // 导出跨文件函数（globalThis === window）
  globalThis.updateStatus = updateStatus;
  globalThis.tryAutoExpand = tryAutoExpand;
  globalThis.updateSendAvailability = updateSendAvailability;
  globalThis.onRetry = onRetry;
  globalThis.onRebuild = onRebuild;
  globalThis.clearCurrentSession = clearCurrentSession;
  globalThis.onStop = onStop;
  globalThis.bindAttachButton = bindAttachButton;
  globalThis.onUserSend = onUserSend;
})();
