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
    getComments: 'getComments',
    insertBookmark: 'insertBookmark',
    getBookmarks: 'getBookmarks',
    insertHyperlink: 'insertHyperlink',
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
    convertToPDF: 'convertToPDF',
    getDocumentStats: 'getDocumentStats',
    getActiveWorkbook: 'getActiveWorkbook',
    getCellValue: 'getCellValue',
    setCellValue: 'setCellValue',

    // Excel（WPS 表格）—— 端口自 opencode-wps-linux/handlers/excel-handler.js
    // （2026-09-18 方案：把上游 handler 有的命令全量同步到插件执行器，excel 85 个）
    addCellComment: 'addCellComment',
    addConditionalFormat: 'addConditionalFormat',
    addDataValidation: 'addDataValidation',
    autoFilter: 'autoFilter',
    autoFitAll: 'autoFitAll',
    autoFitColumn: 'autoFitColumn',
    autoFitRow: 'autoFitRow',
    autoSum: 'autoSum',
    calculateSheet: 'calculateSheet',
    cleanData: 'cleanData',
    clearFormats: 'clearFormats',
    clearRange: 'clearRange',
    closeWorkbook: 'closeWorkbook',
    consolidate: 'consolidate',
    copyFormat: 'copyFormat',
    copyRange: 'copyRange',
    copySheet: 'copySheet',
    createChart: 'createChart',
    createNamedRange: 'createNamedRange',
    createPivotTable: 'createPivotTable',
    createSheet: 'createSheet',
    createWorkbook: 'createWorkbook',
    deleteCellComment: 'deleteCellComment',
    deleteColumns: 'deleteColumns',
    deleteNamedRange: 'deleteNamedRange',
    deleteRows: 'deleteRows',
    deleteSheet: 'deleteSheet',
    diagnoseFormula: 'diagnoseFormula',
    evaluateFormula: 'evaluateFormula',
    exportChartAsImage: 'exportChartAsImage',
    exportRangeAsImage: 'exportRangeAsImage',
    fillSeries: 'fillSeries',
    findInSheet: 'findInSheet',
    freezePanes: 'freezePanes',
    getCellComments: 'getCellComments',
    getContext: 'getContext',
    getFormula: 'getFormula',
    getNamedRanges: 'getNamedRanges',
    getOpenWorkbooks: 'getOpenWorkbooks',
    getRangeData: 'getRangeData',
    getSelection: 'getSelection',
    getSheetList: 'getSheetList',
    groupColumns: 'groupColumns',
    groupRows: 'groupRows',
    hideColumns: 'hideColumns',
    hideRows: 'hideRows',
    insertColumns: 'insertColumns',
    insertExcelImage: 'insertExcelImage',
    insertRows: 'insertRows',
    lockCells: 'lockCells',
    mergeCells: 'mergeCells',
    moveSheet: 'moveSheet',
    openWorkbook: 'openWorkbook',
    pasteRange: 'pasteRange',
    protectSheet: 'protectSheet',
    protectWorkbook: 'protectWorkbook',
    removeDuplicates: 'removeDuplicates',
    renameSheet: 'renameSheet',
    replaceInSheet: 'replaceInSheet',
    setArrayFormula: 'setArrayFormula',
    setBorder: 'setBorder',
    setCellFormat: 'setCellFormat',
    setCellStyle: 'setCellStyle',
    setColumnWidth: 'setColumnWidth',
    setFormula: 'setFormula',
    setHyperlink: 'setHyperlink',
    setNumberFormat: 'setNumberFormat',
    setPrintArea: 'setPrintArea',
    setRangeData: 'setRangeData',
    setRowHeight: 'setRowHeight',
    setZoom: 'setZoom',
    showColumns: 'showColumns',
    showRows: 'showRows',
    sortRange: 'sortRange',
    subtotal: 'subtotal',
    switchSheet: 'switchSheet',
    switchWorkbook: 'switchWorkbook',
    textToColumns: 'textToColumns',
    transpose: 'transpose',
    unfreezePanes: 'unfreezePanes',
    unmergeCells: 'unmergeCells',
    unprotectSheet: 'unprotectSheet',
    updateChart: 'updateChart',
    updatePivotTable: 'updatePivotTable',
    wrapText: 'wrapText',
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
    insertHyperlink: '插入超链接',
    insertHeader: '插入页眉',
    insertFooter: '插入页脚',
    generateTOC: '生成目录',
    insertSectionBreak: '插入分节符',
    setPageSetup: '设置页面',
    setCellValue: '写入单元格',
    save: '保存文档',
    saveAs: '另存为',
    convertToPDF: '导出PDF',

    // Excel 写操作（P11 结构化侧边栏反馈；只读查询不刷屏）
    addCellComment: '添加批注',
    addConditionalFormat: '添加条件格式',
    addDataValidation: '添加数据验证',
    autoFilter: '筛选数据',
    autoFitAll: '自动调整',
    autoFitColumn: '调整列宽',
    autoFitRow: '调整行高',
    calculateSheet: '重新计算',
    cleanData: '清洗数据',
    clearFormats: '清除格式',
    clearRange: '清除区域',
    closeWorkbook: '关闭工作簿',
    consolidate: '合并计算',
    copyFormat: '复制格式',
    copyRange: '复制区域',
    copySheet: '复制工作表',
    createChart: '创建图表',
    createNamedRange: '创建命名区域',
    createPivotTable: '创建数据透视表',
    createSheet: '创建工作表',
    createWorkbook: '创建工作簿',
    deleteCellComment: '删除批注',
    deleteColumns: '删除列',
    deleteNamedRange: '删除命名区域',
    deleteRows: '删除行',
    deleteSheet: '删除工作表',
    exportChartAsImage: '导出图表',
    exportRangeAsImage: '导出区域图片',
    fillSeries: '填充序列',
    freezePanes: '冻结窗格',
    groupColumns: '组合列',
    groupRows: '组合行',
    hideColumns: '隐藏列',
    hideRows: '隐藏行',
    insertColumns: '插入列',
    insertExcelImage: '插入图片',
    insertRows: '插入行',
    lockCells: '锁定单元格',
    mergeCells: '合并单元格',
    moveSheet: '移动工作表',
    openWorkbook: '打开工作簿',
    pasteRange: '粘贴区域',
    protectSheet: '保护工作表',
    protectWorkbook: '保护工作簿',
    removeDuplicates: '删除重复值',
    renameSheet: '重命名工作表',
    replaceInSheet: '替换内容',
    setArrayFormula: '设置数组公式',
    setBorder: '设置边框',
    setCellFormat: '设置单元格格式',
    setCellStyle: '设置单元格样式',
    setColumnWidth: '设置列宽',
    setFormula: '设置公式',
    setHyperlink: '设置超链接',
    setNumberFormat: '设置数字格式',
    setPrintArea: '设置打印区域',
    setRangeData: '写入范围数据',
    setRowHeight: '设置行高',
    setZoom: '设置缩放',
    showColumns: '显示列',
    showRows: '显示行',
    sortRange: '排序',
    subtotal: '分类汇总',
    switchSheet: '切换工作表',
    switchWorkbook: '切换工作簿',
    textToColumns: '分列',
    transpose: '转置',
    unfreezePanes: '取消冻结',
    unmergeCells: '取消合并',
    unprotectSheet: '取消保护',
    updateChart: '更新图表',
    updatePivotTable: '更新透视表',
    wrapText: '自动换行',

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

  // P24：连续相同反馈折叠（如批量 setCellValue 40 次只显示一条「✅ 写入单元格 ×40」），
  // 消除刷屏；仅当上一条反馈仍是容器最后一条消息（无后续消息插入）时折叠，否则新建一条；
  // 元素被清除/切换文档（parentNode 为空）时自动重置。
  var lastFeedbackText = null;
  var lastFeedbackEl = null;
  var lastFeedbackCount = 0;
  function addFeedback(text) {
    if (text === lastFeedbackText && lastFeedbackEl && lastFeedbackEl.parentNode
        && lastFeedbackEl.nextElementSibling === null) {
      lastFeedbackCount++;
      lastFeedbackEl.textContent = text + ' ×' + lastFeedbackCount;
      return lastFeedbackEl;
    }
    lastFeedbackText = text;
    lastFeedbackCount = 1;
    lastFeedbackEl = ChatUi.addMessage('system', text);
    return lastFeedbackEl;
  }

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
          addFeedback('✅ ' + FEEDBACK_ACTIONS[action] + (summary ? '：' + summary : '') + detail);
        } else {
          addFeedback('❌ ' + FEEDBACK_ACTIONS[action] + '失败：' + ((result && result.error) || '未知错误'));
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
