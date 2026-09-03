/**
 * chat-ui.js — 聊天界面渲染（纯 DOM 操作）
 *
 * 模块边界（ARCHITECTURE §4.2）：只懂 DOM 渲染，不知道协议、不知道文档。
 * 供 main.js 调用渲染消息、状态、输入控制。
 */
var ChatUi = (function () {
  'use strict';

  var els = {};
  var onSend = null;

  /**
   * 初始化 UI：缓存 DOM 元素、绑定事件
   * @param {object} opts { onSend: function(text) }
   */
  function init(opts) {
    els.messages = document.getElementById('messages');
    els.input = document.getElementById('input');
    els.sendBtn = document.getElementById('sendBtn');
    els.statusDot = document.getElementById('statusDot');
    els.toolStatus = document.getElementById('toolStatus');

    if (opts && opts.onSend) onSend = opts.onSend;

    if (els.sendBtn) {
      els.sendBtn.addEventListener('click', handleSend);
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
    onSend(text);
  }

  /**
   * 追加一条消息
   * @param {string} role - 'user' | 'assistant' | 'error' | 'system'
   * @param {string} text - 文本内容
   */
  function addMessage(role, text) {
    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : role);
    el.textContent = text;
    els.messages.appendChild(el);
    scrollBottom();
    return el;
  }

  /**
   * 流式追加：更新最后一条 assistant 消息（无则新建）
   * @param {string} chunk - 文本增量
   */
  function appendAssistantChunk(chunk) {
    var last = els.messages.lastElementChild;
    if (!last || last.className.indexOf('assistant') === -1) {
      last = addMessage('assistant', '');
    }
    last.textContent += chunk;
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
   * 设置工具状态条文本
   * @param {string} label
   */
  function setStatus(label) {
    if (els.toolStatus) els.toolStatus.textContent = label;
  }

  /**
   * 设置连接状态指示
   * @param {boolean} connected
   */
  function setConnState(connected) {
    if (els.statusDot) {
      els.statusDot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
    }
  }

  /**
   * 控制输入可用性（等待 AI 回复时禁用，避免并发乱序）
   * @param {boolean} enabled
   */
  function setInputEnabled(enabled) {
    if (els.input) els.input.disabled = !enabled;
    if (els.sendBtn) els.sendBtn.disabled = !enabled;
  }

  function scrollBottom() {
    if (els.messages) els.messages.scrollTop = els.messages.scrollHeight;
  }

  return {
    init: init,
    addMessage: addMessage,
    appendAssistantChunk: appendAssistantChunk,
    finishAssistant: finishAssistant,
    setStatus: setStatus,
    setConnState: setConnState,
    setInputEnabled: setInputEnabled
  };
})();
