/**
 * prompts.js — 自定义提示词模板按钮（P22，docs/DEV-PLAN-PromptTemplates.md）
 *
 * 模块边界（ARCHITECTURE §4.2）：P22 模板按钮纯前端——存储（localStorage 全局 'qp.prompts'）、
 * 模板条渲染、参数替换（{{date}}/{{filename}}/{{fullpath}}/{{selection}}）、设置面板内管理 UI。
 * 依赖：QP（app-state.js，状态/日志/持久化约定）、WpsBridge（getActiveDocumentInfo /
 * getSelectedTextCmd，模板参数来源）。
 * 行为：点击按钮只"填入输入框 + 聚焦 + 光标置末"，不自动发送；输入框已有内容被替换（MVP）。
 * IIFE 包裹：内部辅助（load/save/fillInput/bindManageUI）留在闭包；导出
 * QP.prompts = { init, renderStrip, resolveTemplate, renderManage, save }（spec §4.6）。
 * 加载顺序：doc-state.js 之后、bridge-config.js 之前（taskpane.html <script>）。
 */
(function () {
  'use strict';

  var STORE_KEY = 'qp.prompts'; // 全局模板；按文档模板 'qp.prompts.'+docId 留作 Stretch（spec §4.2）

  // 默认 7 条（用户 2026-09-08 拍板）；仅作 localStorage 无值时的回显，不改动存储
  var DEFAULT_PROMPTS = [
    { name: '续写', text: '请根据以下内容继续续写，保持风格一致：\n{{selection}}' },
    { name: '润色', text: '请润色以下内容，使表达更流畅、更专业：\n{{selection}}' },
    { name: '扩写', text: '请扩写以下内容，补充更多细节与论据：\n{{selection}}' },
    { name: '翻译', text: '请将以下内容翻译成中文：\n{{selection}}' },
    { name: '矫正语气', text: '请矫正以下内容的语气，使其更得体、更符合上下文：\n{{selection}}' },
    { name: '错误检查', text: '请检查以下内容中的错别字、语法和标点错误并给出修正：\n{{selection}}' },
    { name: '总结', text: '请总结以下内容，提炼要点：\n{{selection}}' }
  ];

  function defaults() {
    var now = Date.now();
    return DEFAULT_PROMPTS.map(function (p, i) {
      return { id: 'p' + now + '_' + i, name: p.name, text: p.text };
    });
  }

  // 读全局模板：key 无值 → 默认 7 条回显；已存 [] → 空列表（用户删光后不复活默认）
  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (raw === null || raw === undefined) return defaults();
    try {
      var list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    } catch (e) {}
    return defaults();
  }

  // 即时落盘 + 日志 + 重渲染（所有保存路径统一走这里）
  function save(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list || [])); } catch (e) {}
    QPLog('P22', '模板已保存: ' + (list ? list.length : 0) + ' 条');
    renderStrip();
    renderManage();
  }

  // ── 参数替换（spec §4.3）：贪婪全匹配一次性完成，替换结果不存回（仅 fill 时动态展开） ──
  function resolveTemplate(text) {
    if (!text) return '';
    var doc = null;
    try {
      if (typeof WpsBridge !== 'undefined' && WpsBridge.getActiveDocumentInfo) {
        doc = WpsBridge.getActiveDocumentInfo();
      }
    } catch (e) {}
    var filename = (doc && doc.name) ? doc.name : '(无打开文档)';
    var fullpath = '(新文档)';
    if (doc && doc.path) {
      fullpath = String(doc.path).replace(/\/+$/, '') + '/' + (doc.name || '');
    }
    var selection = '';
    try {
      if (typeof WpsBridge !== 'undefined' && WpsBridge.getSelectedTextCmd) {
        var sel = WpsBridge.getSelectedTextCmd();
        if (sel && sel.success && sel.data && sel.data.text) selection = String(sel.data.text);
      }
    } catch (e) {}
    var date = new Date().toLocaleString('zh-CN');
    return String(text)
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{filename\}\}/g, filename)
      .replace(/\{\{fullpath\}\}/g, fullpath)
      .replace(/\{\{selection\}\}/g, selection);
  }

  // ── 模板条渲染（spec §4.1/§4.2） ──
  function renderStrip() {
    var strip = document.getElementById('promptStrip');
    if (!strip) return;
    strip.innerHTML = '';
    var list = load();
    strip.style.display = list.length ? 'flex' : 'none';
    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var b = document.createElement('button');
        b.className = 'prompt-btn';
        b.textContent = item.name;
        b.title = item.text || '';
        b.addEventListener('click', function () { fillInput(item); });
        strip.appendChild(b);
      })(list[i]);
    }
  }

  // ── 点击行为（spec §4.4）：替换输入框内容 + 聚焦 + 光标置末，不自动发送 ──
  function fillInput(item) {
    var input = document.getElementById('input');
    if (!input) return;
    var rendered = resolveTemplate(item.text);
    input.value = rendered;
    input.focus();
    var end = rendered.length;
    try { input.setSelectionRange(end, end); }
    catch (e) { input.selectionStart = input.selectionEnd = end; }
    QPLog('P22', '模板填入: ' + item.name + ' len=' + end);
  }

  // ── 管理 UI（spec §4.5，设置面板内）：列表 + 改名（失焦保存）+ 删除 ──
  function renderManage() {
    var listEl = document.getElementById('promptList');
    if (!listEl) return;
    var list = load();
    listEl.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'prompt-empty';
      empty.textContent = '（无模板，可在下方添加）';
      listEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var row = document.createElement('div');
        row.className = 'prompt-item';
        var nameInput = document.createElement('input');
        nameInput.className = 'prompt-item-name';
        nameInput.type = 'text';
        nameInput.value = item.name;
        nameInput.title = '改名（失焦保存）';
        var del = document.createElement('button');
        del.className = 'prompt-item-del';
        del.textContent = '删除';
        del.title = '删除该模板';
        row.appendChild(nameInput);
        row.appendChild(del);
        nameInput.addEventListener('change', function () {
          var list2 = load();
          for (var j = 0; j < list2.length; j++) {
            if (list2[j].id === item.id) {
              list2[j].name = nameInput.value.trim() || list2[j].name;
              save(list2);
              break;
            }
          }
        });
        del.addEventListener('click', function () {
          var list2 = load();
          for (var j = 0; j < list2.length; j++) {
            if (list2[j].id === item.id) { list2.splice(j, 1); break; }
          }
          save(list2);
        });
        listEl.appendChild(row);
      })(list[i]);
    }
  }

  // ── 添加表单绑定（spec §4.5） ──
  function bindManageUI() {
    var addBtn = document.getElementById('promptAddBtn');
    var nameInput = document.getElementById('promptName');
    var textInput = document.getElementById('promptText');
    function add() {
      var name = nameInput ? nameInput.value.trim() : '';
      var text = textInput ? textInput.value.trim() : '';
      if (!name || !text) {
        QPLog('P22', '添加模板失败: 名称或内容为空');
        return;
      }
      var list = load();
      list.push({ id: 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name: name, text: text });
      save(list);
      if (nameInput) nameInput.value = '';
      if (textInput) textInput.value = '';
    }
    if (addBtn) addBtn.addEventListener('click', add);
    if (nameInput) nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
  }

  function init() {
    renderStrip();
    bindManageUI();
    renderManage();
    QPLog('P22', 'prompts init: ' + load().length + ' 条模板');
  }

  QP.prompts = {
    init: init,
    renderStrip: renderStrip,
    resolveTemplate: resolveTemplate,
    renderManage: renderManage,
    save: save
  };
})();
