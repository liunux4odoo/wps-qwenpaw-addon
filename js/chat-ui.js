/**
 * chat-ui.js — 聊天界面渲染（纯 DOM 操作）
 *
 * 模块边界（ARCHITECTURE §4.2）：只懂 DOM 渲染，不知道协议、不知道文档。
 * 供 main.js 调用渲染消息、状态、输入控制。
 *
 * 阶段 3 批 1（docs/DEV-PLAN-Phase3.md §1 P1/P2/P4/P5）扩展：
 *   - P1：头部状态区（ACP 连接 + WPS 桥两级状态，合并右上角）
 *   - P2：可操作错误卡片（重试 / 重建会话按钮）
 *   - P4：显示过程开关（localStorage 持久化）、工具卡片、打字指示器 + 阶段切换
 *   - P5：停止按钮（AI 响应期间显示）
 */
var ChatUi = (function () {
  'use strict';

  var els = {};
  var onSend = null;
  var onStop = null;
  var onRetry = null;
  var onRebuild = null;
  var onClearCommand = null;
  var showProcess = true;
  var md = (typeof MarkdownRenderer !== 'undefined') ? MarkdownRenderer : null;

  /**
   * 初始化 UI：缓存 DOM 元素、绑定事件
   * @param {object} opts { onSend, onStop, onRetry, onRebuild }
   */
  function init(opts) {
    els.messages = document.getElementById('messages');
    els.input = document.getElementById('input');
    els.sendBtn = document.getElementById('sendBtn');
    els.stopBtn = document.getElementById('stopBtn');
    els.statusDot = document.getElementById('statusDot');
    els.connLabel = document.getElementById('connLabel');
    els.wpsLabel = document.getElementById('wpsLabel');
    els.toolStatus = document.getElementById('toolStatus');
    els.showProcessToggle = document.getElementById('showProcess');
    els.typingIndicator = document.getElementById('typingIndicator');
    els.phaseLabel = document.getElementById('phaseLabel');

    if (opts) {
      if (opts.onSend) onSend = opts.onSend;
      if (opts.onStop) onStop = opts.onStop;
      if (opts.onRetry) onRetry = opts.onRetry;
      if (opts.onRebuild) onRebuild = opts.onRebuild;
      if (opts.onClearCommand) onClearCommand = opts.onClearCommand;
    }

    // P4：显示过程开关（localStorage 持久化，默认开启）
    try { showProcess = localStorage.getItem('qp.showProcess') !== '0'; } catch (e) {}
    if (els.showProcessToggle) {
      els.showProcessToggle.checked = showProcess;
      els.showProcessToggle.addEventListener('change', function () {
        showProcess = els.showProcessToggle.checked;
        try { localStorage.setItem('qp.showProcess', showProcess ? '1' : '0'); } catch (e) {}
        if (els.messages) els.messages.classList.toggle('hide-process', !showProcess);
      });
    }
    if (!showProcess && els.messages) {
      els.messages.classList.add('hide-process');
    }

    if (els.sendBtn) {
      els.sendBtn.addEventListener('click', handleSend);
    }
    if (els.stopBtn) {
      els.stopBtn.addEventListener('click', handleStop);
    }
    if (els.input) {
      els.input.addEventListener('keydown', function (e) {
        // Enter 发送（不按 Shift），Shift+Enter 换行
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
    }
  }

  function handleSend() {
    if (!els.input || !onSend) return;
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = '';
    // P13：/ 开头快捷指令由 UI 层消费（/clear 等），不发给 AI
    if (isCommand(text)) return;
    onSend(text);
  }

  function handleStop() {
    if (onStop) onStop();
  }

  /**
   * 追加一条消息
   * @param {string} role - 'user' | 'assistant' | 'error' | 'system'
   * @param {string} text - 文本内容
   * @returns {HTMLElement}
   */
  function addMessage(role, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : role);
    if (role === 'assistant' && md) {
      // P10：assistant 消息渲染 Markdown（转义安全）；data-raw 存原文供 P15 快照/历史复用
      el.setAttribute('data-raw', text);
      el.innerHTML = md.render(text);
    } else {
      el.textContent = text;
    }
    // P12：首条真实消息到达后移除空状态引导（避免常驻顶部）
    var hints = els.messages.querySelectorAll('.empty-hint');
    for (var h = 0; h < hints.length; h++) {
      var hint = hints[h];
      if (hint.parentNode) hint.parentNode.removeChild(hint);
    }
    els.messages.appendChild(el);
    scrollBottom();
    return el;
  }

  /**
   * P8/P15：快照当前消息列表（供按 docId 保存/切换）
   * @returns {Array<{role:string,text:string}>} role: 'user'|'assistant'|'error'|'system'
   */
  function snapshot() {
    var msgs = [];
    if (!els.messages) return msgs;
    var nodes = els.messages.querySelectorAll('.msg');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var role = 'system';
      if (el.className.indexOf('assistant') !== -1) role = 'assistant';
      else if (el.className.indexOf('user') !== -1) role = 'user';
      else if (el.className.indexOf('error') !== -1) role = 'error';
      var text;
      // P2 错误卡：只取标题+正文（不含按钮文本），避免 textContent 拼出按钮标签
      if (el.className.indexOf('error-card') !== -1) {
        var t = el.querySelector('.error-card-title');
        var b = el.querySelector('.error-card-text');
        text = (t ? t.textContent : '') + (b && b.textContent ? '：' + b.textContent : '');
      } else {
        text = el.getAttribute('data-raw');
        if (text === null || text === undefined) text = el.textContent;
      }
      if (text) msgs.push({ role: role, text: text });
    }
    return msgs;
  }

  /**
   * P8/P15：恢复消息列表（清空并重渲染）
   * @param {Array<{role:string,text:string}>} msgs
   */
  function restore(msgs) {
    if (!els.messages) return;
    els.messages.innerHTML = '';
    var list = msgs || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.role === 'assistant' && md) {
        var el = document.createElement('div');
        el.className = 'msg assistant';
        el.setAttribute('data-raw', m.text);
        el.innerHTML = md.render(m.text);
        els.messages.appendChild(el);
      } else {
        addMessage(m.role || 'system', m.text);
      }
    }
    scrollBottom();
  }

  /**
   * P8/P15：清空消息列表
   */
  function clear() {
    if (els.messages) els.messages.innerHTML = '';
  }

  /**
   * P12：空状态引导（无消息时显示，帮助用户上手）
   */
  function showEmptyHint() {
    if (!els.messages) return;
    if (els.messages.querySelector('.msg')) return;
    var box = document.createElement('div');
    box.className = 'empty-hint';
    var title = document.createElement('div');
    title.className = 'empty-title';
    title.textContent = '开始对话';
    box.appendChild(title);
    var tips = [
      '把「foo」改成「bar」',
      '把第三段润色一下',
      '给全文加标题',
      '插入一个 3×4 表格'
    ];
    for (var i = 0; i < tips.length; i++) {
      var tip = document.createElement('div');
      tip.className = 'empty-tip';
      tip.textContent = '试试：' + tips[i];
      box.appendChild(tip);
    }
    els.messages.appendChild(box);
    scrollBottom();
    return box;
  }

  /**
   * P13：处理快捷指令文本（如 /clear）。返回 true 表示已消费（不再作为普通消息发送）。
   * @param {string} text
   * @returns {boolean}
   */
  function isCommand(text) {
    if (!text || text.charAt(0) !== '/') return false;
    var parts = text.trim().split(/\s+/);
    var cmd = (parts[0] || '').toLowerCase();
    if (cmd === '/clear') {
      if (onClearCommand) onClearCommand();
      return true;
    }
    if (cmd === '/help') {
      addMessage('system', '可用指令：/clear 清空当前会话；/help 帮助');
      return true;
    }
    addMessage('system', '未知指令：' + parts[0] + '（可用 /help 查看）');
    return true;
  }

  /**
   * P2：可操作错误卡片（带"重试" / "重建会话"按钮）
   * @param {string} title - 错误标题（友好文案）
   * @param {string} text - 错误详情
   * @param {object} opts - { retry: boolean, rebuild: boolean }
   */
  function addErrorCard(title, text, opts) {
    var card = document.createElement('div');
    card.className = 'msg error-card';

    var t = document.createElement('div');
    t.className = 'error-card-title';
    t.textContent = title || '出错了';
    card.appendChild(t);

    if (text) {
      var b = document.createElement('div');
      b.className = 'error-card-text';
      b.textContent = text;
      card.appendChild(b);
    }

    var actions = document.createElement('div');
    actions.className = 'error-card-actions';
    if (opts && opts.retry && onRetry) {
      var retry = document.createElement('button');
      retry.className = 'err-btn primary';
      retry.textContent = '重试';
      retry.addEventListener('click', function () { onRetry(); });
      actions.appendChild(retry);
    }
    if (opts && opts.rebuild && onRebuild) {
      var rebuild = document.createElement('button');
      rebuild.className = 'err-btn';
      rebuild.textContent = '重建会话';
      rebuild.addEventListener('click', function () { onRebuild(); });
      actions.appendChild(rebuild);
    }
    card.appendChild(actions);

    els.messages.appendChild(card);
    scrollBottom();
    return card;
  }

  /**
   * 流式追加：更新最后一条 assistant 消息（无则新建）。
   * P10：流式过程中重新渲染完整累积文本（Markdown 随内容增长实时生效）。
   * @param {string} chunk - 文本增量
   */
  function appendAssistantChunk(chunk) {
    var last = els.messages.lastElementChild;
    if (!last || last.className.indexOf('assistant') === -1) {
      last = addMessage('assistant', '');
    }
    if (md) {
      // 累积纯文本（存于 last 的 data-raw 属性），每次重新渲染
      var raw = last.getAttribute('data-raw') || '';
      raw += chunk;
      last.setAttribute('data-raw', raw);
      last.innerHTML = md.render(raw);
    } else {
      last.textContent += chunk;
    }
    scrollBottom();
  }

  /**
   * 结束 assistant 消息（无实际内容时兜底为空文本，确保有消息元素）
   */
  function finishAssistant() {
    var last = els.messages.lastElementChild;
    if (!last || last.className.indexOf('assistant') === -1) {
      addMessage('assistant', '');
    }
  }

  /**
   * P4：工具卡片（结构化：工具名 + 状态；点击展开/收起细节）
   * @param {string} name - 工具名
   * @param {string} detail - 可展开细节（可选，通常为参数摘要）
   * @returns {HTMLElement}
   */
  function addToolCard(name, detail) {
    var card = document.createElement('div');
    card.className = 'tool-card pending';
    if (!detail) card.style.cursor = 'default'; // 无可展开细节时非可点击

    var row = document.createElement('div');
    row.className = 'tool-card-row';

    var icon = document.createElement('span');
    icon.className = 'tool-card-icon';
    icon.textContent = '🔧';

    var label = document.createElement('span');
    label.className = 'tool-card-name';
    label.textContent = name || '工具调用';

    var status = document.createElement('span');
    status.className = 'tool-card-status';
    status.textContent = '调用中…';

    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(status);
    card.appendChild(row);

    if (detail) {
      var detailEl = document.createElement('div');
      detailEl.className = 'tool-card-detail';
      detailEl.textContent = detail;
      detailEl.style.display = 'none';
      card.appendChild(detailEl);
      card.addEventListener('click', function () {
        detailEl.style.display = detailEl.style.display === 'none' ? 'block' : 'none';
      });
    }

    els.messages.appendChild(card);
    scrollBottom();
    return card;
  }

  /**
   * P4：更新工具卡片状态
   * @param {HTMLElement} el - addToolCard 返回值
   * @param {string} state - 'pending' | 'done' | 'error' | 'cancelled'
   */
  function markToolCard(el, state) {
    if (!el) return;
    var label;
    switch (state) {
      case 'pending': el.className = 'tool-card pending'; label = '调用中…'; break;
      case 'done': el.className = 'tool-card done'; label = '✅ 完成'; break;
      case 'error': el.className = 'tool-card error'; label = '❌ 失败'; break;
      case 'cancelled': el.className = 'tool-card cancelled'; label = '⏹ 已停止'; break;
      default: el.className = 'tool-card'; label = '完成'; break;
    }
    var status = el.querySelector('.tool-card-status');
    if (status) status.textContent = label;
  }

  /**
   * P4：显示打字指示器 + 阶段文案（思考中…/正在调用工具…/正在生成回复…）
   * @param {string} phase
   */
  function showTyping(phase) {
    if (els.typingIndicator) els.typingIndicator.style.display = 'inline-flex';
    if (els.phaseLabel) els.phaseLabel.textContent = phase || '思考中…';
  }

  /** P4：隐藏打字指示器 */
  function hideTyping() {
    if (els.typingIndicator) els.typingIndicator.style.display = 'none';
  }

  /**
   * 设置活动状态条文本（toolbar 右侧）
   * @param {string} label
   */
  function setStatus(label) {
    if (els.toolStatus) els.toolStatus.textContent = label;
  }

  /**
   * P1：设置头部 ACP 连接状态（圆点 + 文案）
   * @param {string} state - 'connecting' | 'connected' | 'disconnected'
   * @param {string} label - 如 "连接中" / "就绪" / "未连接"
   */
  function setConnStateText(state, label) {
    if (els.statusDot) {
      els.statusDot.className = 'status-dot ' + (state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected');
    }
    if (els.connLabel) els.connLabel.textContent = label || '';
  }

  /**
   * P1：设置头部 WPS 桥二级状态
   * @param {string} state - 'connected' | 'pending'
   * @param {string} label - 如 "WPS 已连接" / "WPS 未激活"
   */
  function setWpsState(state, label) {
    if (!els.wpsLabel) return;
    els.wpsLabel.textContent = label || '';
    els.wpsLabel.className = 'wps-label ' + (state === 'connected' ? 'connected' : 'pending');
  }

  /**
   * 控制输入可用性（等待 AI 回复时禁用，避免并发乱序）
   * @param {boolean} enabled
   */
  function setInputEnabled(enabled) {
    if (els.input) els.input.disabled = !enabled;
    if (els.sendBtn) els.sendBtn.disabled = !enabled;
  }

  /**
   * P5：AI 响应期间显示"停止"按钮
   * @param {boolean} busy
   */
  function setBusy(busy) {
    if (els.stopBtn) els.stopBtn.style.display = busy ? 'inline-block' : 'none';
  }

  function scrollBottom() {
    if (els.messages) els.messages.scrollTop = els.messages.scrollHeight;
  }

  return {
    init: init,
    addMessage: addMessage,
    addErrorCard: addErrorCard,
    appendAssistantChunk: appendAssistantChunk,
    finishAssistant: finishAssistant,
    addToolCard: addToolCard,
    markToolCard: markToolCard,
    showTyping: showTyping,
    hideTyping: hideTyping,
    setStatus: setStatus,
    setConnStateText: setConnStateText,
    setWpsState: setWpsState,
    setInputEnabled: setInputEnabled,
    setBusy: setBusy,
    snapshot: snapshot,
    restore: restore,
    clear: clear,
    showEmptyHint: showEmptyHint,
    isCommand: isCommand
  };
})();
