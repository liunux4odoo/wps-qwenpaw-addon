/**
 * wps-bridge.js — WPS JS API 轻量封装
 *
 * 模块边界（ARCHITECTURE §4.2）：只懂 WPS JS API，不知道 ACP、不知道聊天 UI。
 * 供 main.js 查询文档/选区状态。阶段 1 最小实现：文档信息 + 选区查询。
 */
var WpsBridge = (function () {
  'use strict';

  // 日志：优先走 main.js 的 QPLog，否则 console
  function log(tag, msg) {
    if (typeof window !== 'undefined' && window.QPLog) {
      window.QPLog(tag, msg);
    } else {
      try { console.log('[' + tag + '] ' + msg); } catch (e) {}
    }
  }

  /**
   * WPS 是否可用（Application 对象存在）
   */
  function isReady() {
    try {
      var ok = !!(window.Application && window.Application.ActiveDocument);
      log('wps', 'isReady -> ' + ok);
      return ok;
    } catch (e) {
      log('wps', 'isReady 异常: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /**
   * 获取活动文档信息
   * @returns {object|null} {name, path, appType}；无活动文档返回 null
   * 注：WPS Linux jsapi 代理在访问 ActiveDocument 等子属性时若无活动文档会抛
   * "jsapi prototype return null"，必须用 try-catch 单独读属性，**不能**在 if 条件中
   * 短路访问（`if (window.Application.ActiveDocument)` 会触发原型方法调用而抛错）。
   * 参考 opencode-wps word-handler.js 的写法。
   */
  function getActiveDocumentInfo() {
    try {
      if (typeof Application === 'undefined' || !Application) {
        log('wps', 'getActiveDocumentInfo: Application 不存在');
        return null;
      }
      // WPS / Word
      var doc = null;
      try { doc = Application.ActiveDocument; } catch (e) {
        log('wps', 'getActiveDocumentInfo: 读 ActiveDocument 异常: ' + e.message);
      }
      if (doc) {
        try {
          var info = { name: doc.Name || '', path: doc.Path || '', appType: 'wps' };
          log('wps', 'getActiveDocumentInfo -> ' + JSON.stringify(info));
          return info;
        } catch (e) {
          log('wps', 'getActiveDocumentInfo: 读 doc 属性异常: ' + e.message);
          return null;
        }
      }
      // Excel
      try { doc = Application.ActiveWorkbook; } catch (e) {}
      if (doc) {
        try {
          return { name: doc.Name || '', path: doc.Path || '', appType: 'et' };
        } catch (e) { return null; }
      }
      // PowerPoint
      try { doc = Application.ActivePresentation; } catch (e) {}
      if (doc) {
        try {
          return { name: doc.Name || '', path: doc.Path || '', appType: 'wpp' };
        } catch (e) { return null; }
      }
      log('wps', 'getActiveDocumentInfo: 无活动文档');
      return null;
    } catch (e) {
      log('wps', 'getActiveDocumentInfo 外层异常: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  /**
   * 获取当前选中文本
   * @returns {string} 选中文本（无选区返回空串）
   */
  function getSelectedText() {
    try {
      if (typeof Application === 'undefined' || !Application) {
        return '';
      }
      try {
        return String((Application.Selection && Application.Selection.Text) || '');
      } catch (e) {
        log('wps', 'getSelectedText 异常: ' + (e && e.message ? e.message : e));
        return '';
      }
    } catch (e) {
      return '';
    }
  }

  return {
    isReady: isReady,
    getActiveDocumentInfo: getActiveDocumentInfo,
    getSelectedText: getSelectedText
  };
})();
