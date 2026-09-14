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

  // P23：per-taskpane 实例随机 token——未保存文档 docId 唯一化。
  // 未保存文档无稳定身份（path 空、默认名会被 WPS 复用），若直接以 appType:path:name 作 key，
  // 会与"上一个被关闭的同名未保存文档"串台（UI 历史 + AI sessionId 缓存都命中旧记录）。
  // 本 token 在**同一 taskpane 实例内稳定**（同一实例内多个未保存文档靠 name 区分），
  // 在不同 taskpane/会话实例间唯一（杜绝 localStorage 跨实例串台）。
  var instanceToken = (Math.random().toString(36) + Date.now().toString(36)).replace(/[^a-z0-9]/g, '').slice(0, 12);

  // P23：保存迁移判定辅助状态（模块私有，不进 QP.state——纯 doc-state 内部逻辑）
  var lastCheckDocId = null; // 上一次活动文档检测到的 docId（"无中间文档活跃"约束：防"关闭旧文档→打开另一文档"误判为保存）
  var lastIdentity = null;   // 当前文档最近身份 {name, path, appType}（判定同名就地保存 / 改名保存 / 另存为）
  var lastDocCount = null;   // 上一次检测到的文档集合数量（保存/重命名不增减集合；关闭文档会使 Count 减小）

  // P8 文档隔离 key：优先用轻量 getDocIdentity（只读 Name/Path，不触发 Paragraphs 计数，
  // 因为 startDocCheck 每 3s 调用一次，重计数会卡 WPS）；回退默认 'default'。
  // P23：未保存文档（path 空）追加实例随机 token → appType::unsaved::<token>::name，
  // 已保存文档维持 appType:path:name（与旧版一致，历史缓存兼容）。
  function makeDocId(info) {
    var appType = info.appType || 'doc';
    if (info.path) return appType + ':' + info.path + ':' + info.name;
    return appType + '::unsaved::' + instanceToken + '::' + info.name;
  }

  // P23：判定 docId 是否为未保存文档（volatile）——是则历史/会话缓存一律不落 localStorage
  function isVolatileDocId(id) {
    return !!id && id.indexOf('::unsaved::') !== -1;
  }

  function getDocId() {
    try {
      if (typeof WpsBridge !== 'undefined' && WpsBridge.getDocIdentity) {
        var info = WpsBridge.getDocIdentity();
        if (info && info.name) return makeDocId(info);
      } else if (typeof WpsBridge !== 'undefined' && WpsBridge.getActiveDocumentInfo) {
        var info2 = WpsBridge.getActiveDocumentInfo();
        if (info2 && info2.name) return makeDocId(info2);
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
  // P23：未保存文档（volatile docId）历史不落 localStorage——临时草稿无跨会话身份，关闭即弃
  function schedulePersist() {
    if (S.persistTimer) clearTimeout(S.persistTimer);
    S.persistTimer = setTimeout(function () {
      S.persistTimer = null;
      if (!S.currentDocId || isVolatileDocId(S.currentDocId)) return;
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
    if (!isVolatileDocId(S.currentDocId)) QP.saveHistory(S.currentDocId, ChatUi.snapshot()); // P23
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

  // P23：读取当前文档集合数量（保存/重命名不会增减；关闭文档会减小）。读取失败返回 null（约束跳过）
  function readDocCount(appType) {
    try {
      if (typeof WpsBridge !== 'undefined' && WpsBridge.getDocCount) {
        var c = WpsBridge.getDocCount(appType);
        return (typeof c === 'number') ? c : null;
      }
    } catch (e) {}
    return null;
  }

  // P8：立即复查当前活动文档（读取 docId，变化则切换）。
  // 供周期检测与 poll 命令执行后调用——命令执行时 WPS 必然活跃、Application.ActiveDocument
  // 读取可信，可即时覆盖"先打开插件、再新建/打开文档"时 3s 周期前的空档（activeDocument 不刷新）。
  // 若 AI 正在回复（S.waitingResponse），不立即切换（switchToDoc 会中止在途响应），
  // 仅标记 docSwitchDeferred，待响应结束由 flushDeferredDocSwitch() 再切换。
  // P23：在切换前先判定"未保存文档被保存/另存为"的迁移（同一文档，不改会话只迁缓存 key），
  // 判定失败才走普通文档切换。
  function doSwitchIfChanged() {
    var info = null;
    try { info = getDocEnvContext(); } catch (e) {}
    var id = (info && info.name) ? makeDocId(info) : 'default';
    var prev = S.currentDocId;
    var count = (info && info.name) ? readDocCount(info.appType) : null;
    if (!id || id === prev) {
      // 无变化：仅跟踪当前身份与集合数量（P23 同名就地保存 / 改名保存判定用）
      if (info && info.name) { lastIdentity = info; lastDocCount = count; }
      lastCheckDocId = id;
      return;
    }
    // 变化：仅当上一次检测仍看到当前文档（无中间文档/无文档空档）时才可能判定为"保存迁移"，
    // 否则（切走又切回、关旧开新）一律走普通文档切换
    try {
      if (info && info.name && lastCheckDocId === prev && maybeHandleSaveMigration(id, info, lastDocCount, count)) {
        lastCheckDocId = id;
        lastIdentity = info;
        lastDocCount = count;
        return;
      }
    } catch (e) {
      QPLog('P23', '保存迁移判定异常，按普通切换处理: ' + (e && e.message ? e.message : e));
    }
    // 变化但非保存迁移：若旧文档是未保存文档且已确认关闭（无活动文档，或旧名已不在文档集合），
    // 清理其残留内存状态——WPS 会复用默认名，若不清理，同实例内"关闭未保存 A 后新建同名 B"
    // 会得到相同 volatile docId 并继承 A 的会话/历史（P23 核心串台场景的同实例版本）。
    // 仅当确认旧文档已关闭才清理：同名可恢复的切换（A 仍打开）必须保留状态。
    if (isVolatileDocId(prev)) {
      var oldName = lastIdentity ? lastIdentity.name : null;
      var oldGone = (id === 'default') || (!!oldName && !wpsHasDocNamed(oldName, info ? info.appType : null));
      if (oldGone && S.docStates[prev]) {
        delete S.docStates[prev];
        QPLog('P23', '未保存文档已关闭，清理残留状态: ' + prev);
      }
    }
    switchToDoc(id);
    lastCheckDocId = id;
    if (info && info.name) { lastIdentity = info; lastDocCount = count; }
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

  // P23：判断"旧文档名是否仍在文档集合中"——保存/另存为会让文档对象就地重命名（旧名消失），
  // 而"切换到另一仍打开的文档"旧名仍在集合中。这是区分"保存迁移"与"文档切换"的关键信号。
  // 无法读取集合（WPS 不可用 / API 不支持）时保守返回 true（视为切换，宁可漏迁不可误迁）。
  function wpsHasDocNamed(name, appType) {
    if (!name) return true;
    try {
      if (typeof WpsBridge !== 'undefined' && WpsBridge.hasDocumentNamed) {
        return !!WpsBridge.hasDocumentNamed(name, appType);
      }
    } catch (e) {}
    return true;
  }

  // P23：判定当前 volatile/已保存文档是否发生了"保存/另存为"迁移（旧 docId -> 新 docId）。
  // 必须全部满足：
  //   1. 新身份为已保存文档（path 非空）；新旧均非 'default'
  //   2. 目标 docId 无既有状态（内存 docStates / 历史 / 会话缓存都为空）——否则视为切到另一已有文档
  //   3. 无中间文档活跃（lastCheckDocId === 旧 docId，调用方保证）
  //   4. 文档集合数量未变化（保存/重命名不增减集合；关闭文档会让 Count 减小——
  //      用于拦截"关闭旧文档后切到另一文档"的误判，如未保存 A 关闭后 B 自动激活）
  //   5. 判定信号（二选一）：
  //      - 同名就地保存：旧名 === 新名 且旧 path 空 -> 新 path 非空（最可靠，同名文档在同一应用内唯一）
  //      - 改名保存 / 另存为：旧名不再存在于文档集合（对象被就地重命名）
  // 满足则迁移并返回 true（不再走 switchToDoc）。
  function maybeHandleSaveMigration(newId, newInfo, prevCount, curCount) {
    var oldId = S.currentDocId;
    if (!oldId || oldId === newId) return false;
    if (oldId === 'default' || newId === 'default') return false;
    if (!newInfo || !newInfo.path || !newInfo.name) return false;
    // 集合数量变化（有文档被关闭/打开）→ 不是保存/另存为，视为切换
    if (prevCount !== null && curCount !== null && prevCount !== curCount) return false;
    // 目标 docId 有既有状态 → 是切到另一已有文档，不是保存
    if (S.docStates[newId]) return false;
    try { if (QP.loadHistory(newId).length) return false; } catch (e) {}
    try { if (QP.loadCachedSessionId(newId)) return false; } catch (e) {}
    var oldInfo = lastIdentity;
    var isSave = false;
    if (isVolatileDocId(oldId)) {
      // 未保存文档 -> 已保存
      if (!oldInfo || oldInfo.path) {
        isSave = false; // 无身份记录或异常态（当前文档此前已有路径），不迁移
      } else if (oldInfo.name === newInfo.name) {
        isSave = true;  // 同名就地保存（path '' -> 非空）
      } else {
        isSave = !wpsHasDocNamed(oldInfo.name, newInfo.appType); // 改名保存：旧名已不在集合
      }
    } else {
      // 已保存文档另存为新路径：同对象重命名，旧名已不在集合
      isSave = !wpsHasDocNamed(oldInfo ? oldInfo.name : null, newInfo.appType);
    }
    if (!isSave) return false;
    migrateDocId(oldId, newId);
    lastIdentity = newInfo;
    QPLog('P23', '判定为保存/另存为迁移: ' + oldId + ' -> ' + newId);
    return true;
  }

  // P23：docId 迁移（未保存 -> 已保存 / 已保存另存为新路径）。
  // 语义：**不是文档切换**——不新建 ACP 会话、不丢当前对话（AI 侧 sessionId 保持不变），
  // 仅把前端隔离 key 与 localStorage 缓存从旧 docId 搬到新 docId。
  function migrateDocId(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    QPLog('P23', 'docId 迁移: ' + oldId + ' -> ' + newId);
    // 1. 内存状态迁移（move：不保留 volatile 备份——保留会与同实例后续同名未保存文档串台，
    //    这正是本 bug 修复目标）。以当前 live 状态为准（DOM 消息 + 全局 acpSessionId）。
    var prev = S.docStates[oldId];
    S.docStates[newId] = {
      acpSessionId: (S.acpSessionId !== null && S.acpSessionId !== undefined) ? S.acpSessionId : (prev ? prev.acpSessionId : null),
      messages: ChatUi.snapshot(),
      preamblePending: S.preamblePending
    };
    delete S.docStates[oldId];
    // 2. 当前文档切到稳定 id（不改 acpSessionId，不 ensureSession）
    S.currentDocId = newId;
    // 3. localStorage 缓存迁移（history/session key 搬家；volatile 旧 key 一般不存在，防御性处理）
    try {
      var hkOld = QP.historyKey(oldId), hkNew = QP.historyKey(newId);
      var hv = localStorage.getItem(hkOld);
      if (hv !== null) { localStorage.setItem(hkNew, hv); localStorage.removeItem(hkOld); }
    } catch (e) {}
    try {
      var skOld = QP.sessionKey(oldId), skNew = QP.sessionKey(newId);
      var sv = localStorage.getItem(skOld);
      if (sv !== null) { localStorage.setItem(skNew, sv); localStorage.removeItem(skOld); }
    } catch (e) {}
    // 4. 保存后立即把历史与会话缓存落到稳定 docId（防迁移后立刻关闭丢数据/丢 AI 记忆）
    if (S.acpSessionId) QP.saveCachedSessionId(newId, S.acpSessionId);
    QP.saveHistory(newId, ChatUi.snapshot());
    // 5. 会话保持不变 → 状态维持"就绪"（不重建）
    if (S.acpSessionId) ChatUi.setStatus('就绪');
    QPLog('P23', '迁移完成 currentDocId=' + S.currentDocId + ' acpSessionId=' + S.acpSessionId +
      ' 历史条数=' + ChatUi.snapshot().length);
  }

  // P8：周期检测活动文档变化（同一 taskpane 实例内多文档隔离；每文档独立 taskpane 时是 no-op）
  function startDocCheck() {
    if (S.docCheckTimer) return;
    S.docCheckTimer = setInterval(checkDocNow, QP.DOC_CHECK_MS);
    // P23：初始化迁移判定状态（从当前文档起算）
    lastCheckDocId = S.currentDocId;
    try {
      var info = getDocEnvContext();
      lastIdentity = info;
      lastDocCount = (info && info.name) ? readDocCount(info.appType) : null;
    } catch (e) {
      lastIdentity = null;
      lastDocCount = null;
    }
  }

  // 仅导出跨文件需要的函数（globalThis === window）
  globalThis.getDocId = getDocId;
  globalThis.isVolatileDocId = isVolatileDocId;
  globalThis.migrateDocId = migrateDocId;
  globalThis.getSessionCwd = getSessionCwd;
  globalThis.buildPreamble = buildPreamble;
  globalThis.schedulePersist = schedulePersist;
  globalThis.checkDocNow = checkDocNow;
  globalThis.flushDeferredDocSwitch = flushDeferredDocSwitch;
  globalThis.startDocCheck = startDocCheck;
})();
