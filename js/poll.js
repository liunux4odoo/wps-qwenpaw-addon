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
    getActivePresentation: 'getActivePresentation',

    // PPT（演示文稿）—— 端口自 wps-office-mcp poll action，参见 docs/ARCHITECTURE §8.4
    createPresentation: 'createPresentation',
    getOpenPresentations: 'getOpenPresentations',
    switchPresentation: 'switchPresentation',
    openPresentation: 'openPresentation',
    closePresentation: 'closePresentation',
    addSlide: 'addSlide',
    deleteSlide: 'deleteSlide',
    duplicateSlide: 'duplicateSlide',
    moveSlide: 'moveSlide',
    getSlideCount: 'getSlideCount',
    getSlideInfo: 'getSlideInfo',
    switchSlide: 'switchSlide',
    getSlideTitle: 'getSlideTitle',
    setSlideTitle: 'setSlideTitle',
    setSlideSubtitle: 'setSlideSubtitle',
    setSlideContent: 'setSlideContent',
    addTextBox: 'addTextBox',
    deleteTextBox: 'deleteTextBox',
    getTextBoxes: 'getTextBoxes',
    setTextBoxText: 'setTextBoxText',
    setTextBoxStyle: 'setTextBoxStyle',
    addShape: 'addShape',
    deleteShape: 'deleteShape',
    getShapes: 'getShapes',
    setShapeText: 'setShapeText',
    setShapePosition: 'setShapePosition',
    setShapeStyle: 'setShapeStyle',
    setShapeBorder: 'setShapeBorder',
    setShapeShadow: 'setShapeShadow',
    setShapeTransparency: 'setShapeTransparency',
    setShapeZOrder: 'setShapeZOrder',
    groupShapes: 'groupShapes',
    duplicateShape: 'duplicateShape',
    alignShapes: 'alignShapes',
    distributeShapes: 'distributeShapes',
    smartDistribute: 'smartDistribute',
    setSlideBackground: 'setSlideBackground',
    setSlideLayout: 'setSlideLayout',
    setSlideNumber: 'setSlideNumber',
    setSlideTransition: 'setSlideTransition',
    removeSlideTransition: 'removeSlideTransition',
    applyTransitionToAll: 'applyTransitionToAll',
    addAnimation: 'addAnimation',
    removeAnimation: 'removeAnimation',
    startSlideShow: 'startSlideShow',
    endSlideShow: 'endSlideShow',
    insertPptImage: 'insertPptImage',
    deletePptImage: 'deletePptImage',
    insertPptTable: 'insertPptTable',
    getPptTableCell: 'getPptTableCell',
    setPptTableCell: 'setPptTableCell',
    unifyFont: 'unifyFont',
    beautifySlide: 'beautifySlide',
    autoBeautifySlide: 'autoBeautifySlide',
    beautifyAllSlides: 'beautifyAllSlides',
    autoLayout: 'autoLayout',
    addArrow: 'addArrow',
    addConnector: 'addConnector',
    addPptHyperlink: 'addPptHyperlink',
    removePptHyperlink: 'removePptHyperlink',
    findPptText: 'findPptText',
    replacePptText: 'replacePptText',
    getSlideNotes: 'getSlideNotes',
    setSlideNotes: 'setSlideNotes',
    exportSlideAsImage: 'exportSlideAsImage',
    applyColorScheme: 'applyColorScheme',
    setMasterBackground: 'setMasterBackground',
    getSlideMaster: 'getSlideMaster',
    setPptFooter: 'setPptFooter',
    setPptDateTime: 'setPptDateTime',
    setImageStyle: 'setImageStyle',
    setBackgroundColor: 'setBackgroundColor',
    setBackgroundImage: 'setBackgroundImage',
    setBackgroundGradient: 'setBackgroundGradient',
    setShapeGradient: 'setShapeGradient',
    setShapeFullStyle: 'setShapeFullStyle',
    setShapeRoundness: 'setShapeRoundness',
    setFontColor: 'setFontColor',
    setSlideSize: 'setSlideSize',
    setShapeFill: 'setShapeFill',
    setSlideTheme: 'setSlideTheme'
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
    saveAs: '另存为',

    // PPT 写操作（P11 结构化侧边栏反馈）
    createPresentation: '创建演示文稿',
    closePresentation: '关闭演示文稿',
    addSlide: '添加幻灯片',
    deleteSlide: '删除幻灯片',
    duplicateSlide: '复制幻灯片',
    moveSlide: '移动幻灯片',
    switchSlide: '切换幻灯片',
    switchPresentation: '切换演示文稿',
    openPresentation: '打开演示文稿',
    setSlideTitle: '设置标题',
    setSlideSubtitle: '设置副标题',
    setSlideContent: '设置幻灯片内容',
    addTextBox: '添加文本框',
    deleteTextBox: '删除文本框',
    setTextBoxText: '设置文本框文本',
    setTextBoxStyle: '设置文本框样式',
    addShape: '添加形状',
    deleteShape: '删除形状',
    setShapeText: '设置形状文本',
    setShapePosition: '设置形状位置',
    setShapeStyle: '设置形状样式',
    setShapeBorder: '设置形状边框',
    setShapeShadow: '设置形状阴影',
    setShapeTransparency: '设置形状透明度',
    setShapeZOrder: '设置形状层级',
    groupShapes: '组合形状',
    duplicateShape: '复制形状',
    alignShapes: '对齐形状',
    distributeShapes: '分布形状',
    smartDistribute: '智能分布',
    setSlideBackground: '设置幻灯片背景',
    setSlideLayout: '设置幻灯片布局',
    setSlideNumber: '设置幻灯片页码',
    setSlideTransition: '设置幻灯片切换',
    removeSlideTransition: '移除切换效果',
    applyTransitionToAll: '应用全局切换',
    addAnimation: '添加动画',
    removeAnimation: '移除动画',
    startSlideShow: '开始放映',
    endSlideShow: '结束放映',
    insertPptImage: '插入图片',
    deletePptImage: '删除图片',
    insertPptTable: '插入表格',
    setPptTableCell: '设置表格单元格',
    unifyFont: '统一字体',
    beautifySlide: '美化幻灯片',
    autoBeautifySlide: '自动美化',
    beautifyAllSlides: '美化全部幻灯片',
    autoLayout: '自动布局',
    addArrow: '添加箭头',
    addConnector: '添加连接线',
    addPptHyperlink: '添加超链接',
    removePptHyperlink: '移除超链接',
    findPptText: '查找文本',
    replacePptText: '替换文本',
    setSlideNotes: '设置备注',
    applyColorScheme: '应用配色方案',
    setMasterBackground: '设置母版背景',
    setPptFooter: '设置页脚',
    setPptDateTime: '设置日期时间',
    setImageStyle: '设置图片样式',
    setBackgroundColor: '设置背景颜色',
    setBackgroundImage: '设置背景图片',
    setBackgroundGradient: '设置渐变背景',
    setShapeGradient: '设置形状渐变',
    setShapeFullStyle: '设置形状完整样式',
    setShapeRoundness: '设置形状圆角',
    setFontColor: '设置字体颜色',
    setSlideSize: '设置幻灯片大小',
    setShapeFill: '设置形状填充',
    setSlideTheme: '设置幻灯片主题'
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
    // 命令执行后即时复查活动文档（P8）：命令在 WPS 活跃时执行，activeDocument 读取可信，
    // 覆盖"先打开插件、再新建/打开文档"时周期检测前的空档（避免会话上下文不刷新）。
    try { if (typeof checkDocNow === 'function') checkDocNow(); } catch (e) {}
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
