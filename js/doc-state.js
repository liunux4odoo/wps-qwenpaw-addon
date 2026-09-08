/**
 * doc-state.js — 文档隔离 / 历史缓存 / 环境上下文（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：P8 多文档隔离 + P15 历史缓存 + P16 环境上下文。
 * 依赖：QP（app-state.js，状态/持久化工具）、ChatUi、WpsBridge、QPLog。
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见（不落 window.S）；仅导出跨文件
 * 需要的函数（globalThis === window，浏览器中即全局）。内部辅助（getDocEnvContext/
 * saveDocState/switchToDoc）不导出。
 */
(function () {
  'use strict';
  var S = QP.state;

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

  // ── P16：WPS 活动文档环境上下文（session bootstrap）──
  // 从 WpsBridge 读取轻量文档身份 {name, path, appType}（与 getDocId 同源，只读不触发计数）。
  function getDocEnvContext() {
    try {
      if (typeof WpsBridge !== 'undefined' && WpsBridge.getDocIdentity) {
        return WpsBridge.getDocIdentity();
      }
      if (typeof WpsBridge !== 'undefined' && WpsBridge.getActiveDocumentInfo) {
        return WpsBridge.getActiveDocumentInfo();
      }
    } catch (e) {}
    return null;
  }

  // P16：session/new / session/load 的 cwd = 当前活动文档目录（doc.Path）；无路径回退默认
  function getSessionCwd() {
    var info = getDocEnvContext();
    if (info && info.path) return info.path;
    return QP.SESSION_CWD;
  }

  // P16：构建环境上下文 preamble（独立文本块，仅进 ACP prompt、不进用户气泡）
  // 契约：文档类型（appType）/ 完整路径（未保存标注"未保存的新文档"）/ 工作目录 + 三条行为规则。
  // 无活动文档 → 返回 null（优雅降级：不发 preamble、不崩溃）。
  function buildPreamble() {
    var info = getDocEnvContext();
    if (!info) return null;
    var appTypeLabel = {
      wps: 'Word/WPS 文字',
      et: 'Excel/WPS 表格',
      wpp: 'PowerPoint/WPS 演示'
    }[info.appType] || info.appType || '文档';
    var name = info.name || '未命名文档';
    var saved = !!(info.path);
    var fullPath = saved ? (info.path.replace(/\/+$/, '') + '/' + name) : null;
    var pathDesc = saved ? fullPath : '（未保存的新文档）';
    var cwd = info.path || QP.SESSION_CWD;
    return '【当前工作环境】（自动注入的环境上下文，请据此工作）\n'
      + '文档类型：' + appTypeLabel + '\n'
      + '文档名称：' + name + '\n'
      + '文档路径：' + pathDesc + '\n'
      + '工作目录：' + cwd + '\n\n'
      + '行为规则：\n'
      + '1. 对文档做任何修改前，先读取文档当前状态，不要假设内容；\n'
      + '2. 本会话只围绕当前打开的活动文档工作，不要自行打开其他文档；\n'
      + '3. 同目录下的周边文档可按路径检索，但默认以当前文档为工作中心。';
  }

  // P15：消息变更后防抖落盘（localStorage，按 docId）
  function schedulePersist() {
    if (S.persistTimer) clearTimeout(S.persistTimer);
    S.persistTimer = setTimeout(function () {
      S.persistTimer = null;
      if (!S.currentDocId) return;
      QP.saveHistory(S.currentDocId, ChatUi.snapshot());
    }, 600);
  }

  // P8：保存当前文档状态到内存
  function saveDocState() {
    if (!S.currentDocId) return;
    S.docStates[S.currentDocId] = {
      acpSessionId: S.acpSessionId,
      messages: ChatUi.snapshot(),
      preamblePending: S.preamblePending // P16：随文档保存待注入标记（新会话未发首条前切走再切回不丢）
    };
    QP.saveHistory(S.currentDocId, ChatUi.snapshot());
  }

  // P8：切换到目标文档（保存当前状态 → 恢复目标状态 → 重建/复用会话）
  function switchToDoc(docId) {
    if (docId === S.currentDocId) return;
    QPLog('P8', '文档切换: ' + S.currentDocId + ' -> ' + docId);
    saveDocState();
    // 清理当前进行中的请求（与 P5 停止逻辑一致）
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
    S.currentDocId = docId;
    S.pendingAttachments = []; // P8：切换文档时清空未发送的待选附件（不串台）
    var st = S.docStates[docId];
    if (st && st.messages && st.messages.length) {
      ChatUi.restore(st.messages);
      S.acpSessionId = st.acpSessionId || null;
      S.preamblePending = !!st.preamblePending; // P16：恢复该文档待注入标记
    } else {
      var hist = QP.loadHistory(docId);
      ChatUi.restore(hist);
      if (!hist.length) ChatUi.showEmptyHint();
      S.acpSessionId = null;
      S.preamblePending = false; // P16：新文档状态，由 session/new 成功后再置位
    }
    QPLog('P8', '切换到文档 ' + docId + '，恢复会话=' + S.acpSessionId + ' 历史条数=' + (ChatUi.snapshot().length));
    ChatUi.setStatus(S.acpSessionId ? '就绪' : '加载会话…');
    if (S.acpState === 'connected') {
      if (!S.acpSessionId) ensureSession();
    }
    updateSendAvailability(); // P21：切换后按新文档会话状态刷新发送可用性
  }

  // P8：立即复查当前活动文档（读取 docId，变化则切换）。
  // 供周期检测与 poll 命令执行后调用——命令执行时 WPS 必然活跃、Application.ActiveDocument
  // 读取可信，可即时覆盖"先打开插件、再新建/打开文档"时 3s 周期前的空档（activeDocument 不刷新）。
  // 若 AI 正在回复（S.waitingResponse），不立即切换（switchToDoc 会中止在途响应），
  // 仅标记 docSwitchDeferred，待响应结束由 flushDeferredDocSwitch() 再切换。
  function doSwitchIfChanged() {
    var id;
    try { id = getDocId(); } catch (e) { return; }
    if (id && id !== S.currentDocId) switchToDoc(id);
  }

  function checkDocNow() {
    if (S.waitingResponse) {
      S.docSwitchDeferred = true;
      return;
    }
    doSwitchIfChanged();
  }

  // P8：AI 在途响应结束（/停止/中断/清空/服务器切换）后，执行被延迟的文档切换。
  // 此处直接切换（不再受 waitingResponse 门控——调用方已在响应结束后调用）。
  function flushDeferredDocSwitch() {
    if (!S.docSwitchDeferred) return;
    S.docSwitchDeferred = false;
    doSwitchIfChanged();
  }

  // P8：周期检测活动文档变化（同一 taskpane 实例内多文档隔离；每文档独立 taskpane 时是 no-op）
  function startDocCheck() {
    if (S.docCheckTimer) return;
    S.docCheckTimer = setInterval(checkDocNow, QP.DOC_CHECK_MS);
  }

  // 仅导出跨文件需要的函数（globalThis === window）
  globalThis.getDocId = getDocId;
  globalThis.getSessionCwd = getSessionCwd;
  globalThis.buildPreamble = buildPreamble;
  globalThis.schedulePersist = schedulePersist;
  globalThis.checkDocNow = checkDocNow;
  globalThis.flushDeferredDocSwitch = flushDeferredDocSwitch;
  globalThis.startDocCheck = startDocCheck;
})();
