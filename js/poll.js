/**
 * poll.js — 轮询命令处理（角色 B：WPS 操作执行）（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：wps-office-mcp 轮询命令 action -> WpsBridge 方法分发。
 * 只做分发，不写业务逻辑（WPS 操作全在 wps-bridge.js）。依赖：QP（app-state.js）、
 * WpsBridge、ChatUi、QPLog，以及 doc-state.js 的 schedulePersist、actions.js 的 updateStatus。
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见；POLL_ACTION_MAP/FEEDBACK_ACTIONS
 * 为模块私有（不落全局）；导出跨文件函数（globalThis === window）。
 */
(function () {
  'use strict';
  var S = QP.state;

  // 覆盖 wps-office-mcp 轮询命令契约全集（word/common/excel/ppt + execute_method 白名单路径）。
  var POLL_ACTION_MAP = {
    ping: 'ping',
    wireCheck: 'wireCheck',
    getAppInfo: 'getAppInfo',
    getActiveDocument: 'getActiveDocument',
    getSelectedText: 'getSelectedText',
    setSelectedText: 'setSelectedText',
    insertText: 'insertText',
    getDocumentText: 'getDocumentText',
    getDocumentTextByRange: 'getDocumentTextByRange',
    getDocumentParagraphs: 'getDocumentParagraphs',
    findReplace: 'findReplace',
    findInDocument: 'findInDocument',
    smartFillField: 'smartFillField',
    replaceBookmarkContent: 'replaceBookmarkContent',
    setFont: 'setFont',
    setTextColor: 'setTextColor',
    setParagraph: 'setParagraph',
    setLineSpacing: 'setLineSpacing',
    applyStyle: 'applyStyle',
    insertTable: 'insertTable',
    insertPageBreak: 'insertPageBreak',
    insertImage: 'insertImage',
    addComment: 'addComment',
    insertBookmark: 'insertBookmark',
    insertHeader: 'insertHeader',
    insertFooter: 'insertFooter',
    generateTOC: 'generateTOC',
    insertSectionBreak: 'insertSectionBreak',
    setPageSetup: 'setPageSetup',
    getOpenDocuments: 'getOpenDocuments',
    switchDocument: 'switchDocument',
    openDocument: 'openDocument',
    createDocument: 'createDocument',
    save: 'save',
    saveAs: 'saveAs',
    openFile: 'openFile',
    getActiveWorkbook: 'getActiveWorkbook',
    getCellValue: 'getCellValue',
    setCellValue: 'setCellValue',
    getActivePresentation: 'getActivePresentation'
  };

  // P11：需要结构化结果反馈的命令（写操作/有结果的操作；只读查询不刷屏）
  var FEEDBACK_ACTIONS = {
    setSelectedText: '替换选中文本',
    insertText: '插入文本',
    findReplace: '查找替换',
    findInDocument: '查找',
    setFont: '设置字体',
    setTextColor: '设置文字颜色',
    setParagraph: '设置段落格式',
    setLineSpacing: '设置行距',
    applyStyle: '应用样式',
    insertTable: '插入表格',
    insertPageBreak: '插入分页符',
    insertImage: '插入图片',
    addComment: '添加批注',
    insertBookmark: '插入书签',
    insertHeader: '插入页眉',
    insertFooter: '插入页脚',
    generateTOC: '生成目录',
    insertSectionBreak: '插入分节符',
    setPageSetup: '设置页面',
    setCellValue: '写入单元格',
    save: '保存文档',
    saveAs: '另存为'
  };

  function onPollCommand(action, params) {
    QPLog('poll', '收到命令 action=' + action + ' params=' + JSON.stringify(params).slice(0, 300));
    var t0 = Date.now();
    var result;
    try {
      var bridgeMethod = POLL_ACTION_MAP[action];
      if (bridgeMethod && typeof WpsBridge[bridgeMethod] === 'function') {
        result = WpsBridge[bridgeMethod](params || {});
      } else if (action && action.indexOf('Application.') === 0) {
        // wps_execute_method 白名单路径（如 Application.ActiveDocument.Content.Text）
        result = WpsBridge.executeMethod(action, params || {});
      } else {
        result = { success: false, data: null, error: '未支持的命令: ' + action };
      }
    } catch (e) {
      result = { success: false, data: null, error: '执行异常: ' + (e && e.message ? e.message : e) };
      QPLog('poll', '命令执行抛异常 action=' + action + ' err=' + (e && e.message ? e.message : e));
    }
    QPLog('poll', '命令完成 action=' + action + ' 耗时=' + (Date.now() - t0) + 'ms success=' + result.success + ' error=' + (result.error || ''));
    // P11：写操作/有结果操作给结构化侧边栏反馈（操作类型 + 结果摘要），只读查询不刷屏
    if (FEEDBACK_ACTIONS[action] && S.isTaskpane) {
      try {
        if (result && result.success) {
          var summary = result.data && result.data.summary ? result.data.summary : '';
          var detail = result.data && result.data.count !== undefined ? '（' + result.data.count + ' 处）' : '';
          ChatUi.addMessage('system', '✅ ' + FEEDBACK_ACTIONS[action] + (summary ? '：' + summary : '') + detail);
        } else {
          ChatUi.addMessage('system', '❌ ' + FEEDBACK_ACTIONS[action] + '失败：' + ((result && result.error) || '未知错误'));
        }
        schedulePersist();
      } catch (e) {}
    }
    return result;
  }

  function onPollStatus(failCount, lastError) {
    if (failCount > 0) {
      QPLog('poll', 'WPS 桥轮询失败 #' + failCount + ' lastError=' + lastError);
      // P1：懒启动端口连不上 = 预期（首次工具调用后才监听），不显示"错误"
      S.wpsState = 'pending';
    } else {
      QPLog('poll', 'WPS 桥已连接');
      S.wpsState = 'connected';
    }
    updateStatus();
  }

  // 导出跨文件函数（globalThis === window）
  globalThis.onPollCommand = onPollCommand;
  globalThis.onPollStatus = onPollStatus;
})();
