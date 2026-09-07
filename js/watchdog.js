/**
 * watchdog.js — P2 中断恢复看门狗（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：prompt 发送后的看门狗（无首 chunk / 无下行活动 /
 * 自动顺延 / 判定中断恢复）。依赖：QP（app-state.js）、ChatUi、QPLog，
 * 以及 actions.js 的 updateSendAvailability、doc-state.js 的 schedulePersist。
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见；导出跨文件函数（globalThis === window）。
 */
(function () {
  'use strict';
  var S = QP.state;

  // ── P2：中断恢复看门狗 ──
  function clearPromptTimers() {
    if (S.noFirstChunkTimer) { clearTimeout(S.noFirstChunkTimer); S.noFirstChunkTimer = null; }
    if (S.activityTimer) { clearTimeout(S.activityTimer); S.activityTimer = null; }
    S.extendCount = 0;
  }

  function startPromptTimers() {
    clearPromptTimers();
    S.noFirstChunkTimer = setTimeout(onNoFirstChunkTimeout, QP.P2_NO_FIRST_CHUNK_MS);
    S.activityTimer = setTimeout(onActivityTimeout, QP.P2_ACTIVITY_MS);
  }

  function touchActivity() {
    // 任何下行活动（thinking 心跳 / 文本 chunk / status_update / request_permission）
    // 都证明请求仍存活：
    // 1) 退出"疑似中断"顺延态（extendCount 清零，回到正常等待）
    // 2) 同时重置两个看门狗。尤其工具链场景（每次工具调用都有 request_permission 下行），
    //    首个文本 chunk 可能晚于阈值到达——只重置 activityTimer 会让 noFirstChunkTimer
    //    误报中断（P2 真实工具链假阳性）。
    S.extendCount = 0;
    if (S.activityTimer) {
      clearTimeout(S.activityTimer);
      S.activityTimer = setTimeout(onActivityTimeout, QP.P2_ACTIVITY_MS);
    }
    if (S.noFirstChunkTimer) {
      clearTimeout(S.noFirstChunkTimer);
      S.noFirstChunkTimer = setTimeout(onNoFirstChunkTimeout, QP.P2_NO_FIRST_CHUNK_MS);
    }
  }

  // P2 v1.4：看门狗触发时不死判——先进入"疑似中断"自动顺延（UI 提示"AI 仍在处理…"），
  // 顺延期间任何下行 → 回到正常状态（touchActivity 清零 extendCount）；顺延次数用尽
  // 仍无下行 → 才判定中断。覆盖 qwenpaw 单次请求内 91s+ 的 thinking 完全静默窗口。
  function onWatchdogTimeout(kind) {
    if (S.extendCount < QP.P2_MAX_EXTENDS) {
      S.extendCount++;
      QPLog('P2', kind + ' 看门狗触发，第 ' + S.extendCount + '/' + QP.P2_MAX_EXTENDS
        + ' 次自动顺延（AI 仍在处理，再等 ' + (QP.P2_EXTEND_MS / 1000) + 's）');
      ChatUi.showTyping('AI 仍在处理…');
      ChatUi.setStatus('AI 仍在处理…（' + S.extendCount + '/' + QP.P2_MAX_EXTENDS + '）');
      if (S.noFirstChunkTimer) { clearTimeout(S.noFirstChunkTimer); S.noFirstChunkTimer = setTimeout(onNoFirstChunkTimeout, QP.P2_EXTEND_MS); }
      if (S.activityTimer) { clearTimeout(S.activityTimer); S.activityTimer = setTimeout(onActivityTimeout, QP.P2_EXTEND_MS); }
      return;
    }
    QPLog('P2', kind + ' 看门狗触发，顺延次数已用尽，判定中断');
    recoverFromInterruption(kind === 'noFirstChunk'
      ? '长时间未收到 AI 响应，连接可能已中断'
      : 'AI 响应中断（长时间无数据）');
  }

  function onNoFirstChunkTimeout() { onWatchdogTimeout('noFirstChunk'); }
  function onActivityTimeout() { onWatchdogTimeout('activity'); }

  // P2：恢复 UI 状态 + 可操作错误卡片（重试/重建会话）
  function recoverFromInterruption(reason) {
    if (!S.waitingResponse) return;
    QPLog('P2', '中断恢复: ' + reason);
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
    for (var i = 0; i < cards.length; i++) ChatUi.markToolCard(cards[i], 'error');
    ChatUi.hideTyping();
    updateSendAvailability(); // P21：会话仍有效 → 恢复可发送；会话失效则保持禁用
    ChatUi.setBusy(false);
    ChatUi.addErrorCard('连接中断', reason + '。可重试当前消息或重建会话。', { retry: true, rebuild: true });
    ChatUi.setStatus('对话中断');
    S.streamBuffer = '';
    schedulePersist(); // P15：中断时保留已收到的部分回复
  }

  // 导出跨文件函数（globalThis === window）
  globalThis.clearPromptTimers = clearPromptTimers;
  globalThis.startPromptTimers = startPromptTimers;
  globalThis.touchActivity = touchActivity;
})();
