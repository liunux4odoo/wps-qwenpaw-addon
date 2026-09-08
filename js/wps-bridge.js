/**
 * wps-bridge.js — WPS JS API 轻量封装
 *
 * 模块边界（ARCHITECTURE §4.2）：只懂 WPS JS API，不知道 ACP、不知道聊天 UI。
 * 阶段 2 起承载全部编辑命令实现（插入/替换/查找/格式/表格/页眉页脚等），
 * 每个操作返回统一结构 { success, data, error }（与轮询协议 /result 契约一致）。
 * main.js 的 onPollCommand 只做 action -> WpsBridge 方法分发，不写业务逻辑。
 *
 * 参考实现：opencode-wps-linux/handlers/{common,word,excel,ppt}-handler.js
 * （本文件按 wps-office-mcp 轮询命令契约对齐 data 形状，见 docs/ARCHITECTURE §8.4）。
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

  // 获取当前 Application 引用（每次调用重新解析，不持旧引用）。
  // 修复：先打开插件、再新建/打开文档时 activeDocument 不刷新——若 WPS 的
  // window.WPS.Application 是实时命名空间，持页面加载时的 window.Application 会读到旧文档。
  // 优先级：window.WPS.Application > window.Application > 裸 Application（与 opencode-wps 参考一致）。
  function getApplication() {
    try {
      if (typeof window !== 'undefined' && window.WPS && window.WPS.Application) return window.WPS.Application;
      if (typeof window !== 'undefined' && window.Application) return window.Application;
      if (typeof Application !== 'undefined' && Application) return Application;
    } catch (e) {}
    return null;
  }

  // ── 统一响应封装（与轮询协议 /result 契约一致） ──
  function ok(data) {
    return { success: true, data: data || null, error: null };
  }
  function fail(msg) {
    return { success: false, data: null, error: msg || '未知错误' };
  }
  function invalidParam(msg) {
    return { success: false, data: null, error: '参数错误: ' + (msg || '请检查输入参数') };
  }

  // ── 通用工具函数 ──

  /** 获取选中区域 Range；无选中/无活动窗口时返回 null（部分 WPS 抛错而非返回 null） */
  function getSelectionRange() {
    try {
      var app = getApplication();
      if (!app || !app.Selection) return null;
      return app.Selection.Range;
    } catch (e) {
      return null;
    }
  }

  /** 获取活动文档（Word/WPS 文字）；无活动文档返回 null */
  function getActiveDoc() {
    try {
      var app = getApplication();
      if (!app) return null;
      return app.ActiveDocument || null;
    } catch (e) {
      return null;
    }
  }

  /** 获取当前应用类型：wps / et / wpp / unknown */
  function getAppType() {
    try {
      var app = getApplication();
      if (!app) return 'unknown';
      try { if (app.ActiveDocument) return 'wps'; } catch (e) {}
      try { if (app.ActiveWorkbook) return 'et'; } catch (e) {}
      try { if (app.ActivePresentation) return 'wpp'; } catch (e) {}
    } catch (e) {}
    return 'unknown';
  }

  /** RGB(0xRRGGBB) -> WPS/Word 使用的 BGR 数值 */
  function toBgr(rgb) {
    return ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF);
  }

  var COLOR_NAMES = {
    red: toBgr(0xFF0000), green: toBgr(0x00FF00), blue: toBgr(0x0000FF), yellow: toBgr(0xFFFF00),
    cyan: toBgr(0x00FFFF), magenta: toBgr(0xFF00FF), white: toBgr(0xFFFFFF), black: toBgr(0x000000),
    gray: toBgr(0x808080), grey: toBgr(0x808080), orange: toBgr(0xFFA500), purple: toBgr(0x800080),
    pink: toBgr(0xFFC0CB), brown: toBgr(0xA52A2A), navy: toBgr(0x000080), teal: toBgr(0x008080),
    maroon: toBgr(0x800000), lime: toBgr(0x00FF00), silver: toBgr(0xC0C0C0), gold: toBgr(0xFFD700)
  };

  /** 统一颜色解析：支持颜色名 / #RRGGBB / RRGGBB / 数字（BGR），非法返回 null */
  function parseColor(color) {
    if (typeof color === 'number') return color;
    if (typeof color !== 'string' || !color) return null;
    var lower = color.toLowerCase();
    if (COLOR_NAMES[lower] !== undefined) return COLOR_NAMES[lower];
    var hexStr = color.indexOf('#') === 0 ? color.substring(1) : color;
    if (!/^[0-9a-fA-F]{6}$/.test(hexStr)) return null;
    return toBgr(parseInt(hexStr, 16));
  }

  /** 解析正整行/列（1-based）；非法返回 null */
  function resolveRowCol(row, col) {
    var r = parseInt(row, 10);
    if (isNaN(r) || r < 1) return null;
    var c = parseInt(col, 10);
    if (isNaN(c) || c < 1) return null;
    return { row: r, col: c };
  }

  /** 获取 Excel 工作表：支持名称或索引；缺省用活动表 */
  function getExcelSheet(wb, sheet) {
    try {
      if (sheet === undefined || sheet === null || sheet === '') return wb.ActiveSheet;
      return wb.Sheets.Item(sheet);
    } catch (e) {
      return null;
    }
  }

  // ══════════════════════════════════════════════
  // 连接/信息类
  // ══════════════════════════════════════════════

  function ping() {
    return ok({ message: 'pong', timestamp: new Date().getTime(), platform: 'linux' });
  }

  function wireCheck() {
    return ok({ message: 'WPS Bridge 已连接', appType: getAppType() });
  }

  function getAppInfo() {
    try {
      var appType = getAppType();
      var appName = '';
      var app = getApplication();
      try { appName = (app && app.Name) || ''; } catch (e) {}
      return ok({ appType: appType, appName: appName, platform: 'linux', version: 1 });
    } catch (e) {
      return ok({ appType: 'unknown', appName: '', platform: 'linux' });
    }
  }

  /**
   * WPS 是否可用（Application 对象存在）
   */
  function isReady() {
    try {
      var app = getApplication();
      var okv = !!(app && app.ActiveDocument);
      log('wps', 'isReady -> ' + okv);
      return okv;
    } catch (e) {
      log('wps', 'isReady 异常: ' + (e && e.message ? e.message : e));
      return false;
    }
  }

  /**
   * 获取活动文档信息（Word/WPS 文字）
   * @returns {object|null} {name, path, appType, paragraphCount, wordCount, characterCount}；无活动文档返回 null
   * 注：WPS Linux jsapi 代理在访问 ActiveDocument 等子属性时若无活动文档会抛
   * "jsapi prototype return null"，必须用 try-catch 单独读属性，**不能**在 if 条件中
   * 短路访问。参考 opencode-wps word-handler.js 的写法。
   */
  function getActiveDocumentInfo() {
    try {
      var app = getApplication();
      if (!app) {
        log('wps', 'getActiveDocumentInfo: Application 不存在');
        return null;
      }
      // WPS / Word
      var doc = null;
      try { doc = app.ActiveDocument; } catch (e) {
        log('wps', 'getActiveDocumentInfo: 读 ActiveDocument 异常: ' + e.message);
      }
      if (doc) {
        try {
          var info = { name: doc.Name || '', path: doc.Path || '', appType: 'wps' };
          try { info.paragraphCount = doc.Paragraphs ? doc.Paragraphs.Count : 0; } catch (e) {}
          try { info.wordCount = doc.Words ? doc.Words.Count : 0; } catch (e) {}
          try { info.characterCount = doc.Characters ? doc.Characters.Count : 0; } catch (e) {}
          log('wps', 'getActiveDocumentInfo -> ' + JSON.stringify(info));
          return info;
        } catch (e) {
          log('wps', 'getActiveDocumentInfo: 读 doc 属性异常: ' + e.message);
          return null;
        }
      }
      // Excel
      try { doc = app.ActiveWorkbook; } catch (e) {}
      if (doc) {
        try {
          return { name: doc.Name || '', path: doc.Path || '', appType: 'et' };
        } catch (e) { return null; }
      }
      // PowerPoint
      try { doc = app.ActivePresentation; } catch (e) {}
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
   * 轻量文档标识（P8 文档隔离用）：只读 Name/Path/appType，不读段落/字数等计数。
   * 供 main.js 周期检测活动文档变化（每 3s 一次），避免在长文档上反复触发昂贵的
   * Paragraphs/Words/Characters 计数（会卡 WPS）。
   * @returns {object|null} {name, path, appType}
   */
  function getDocIdentity() {
    try {
      var app = getApplication();
      if (!app) return null;
      var doc = null;
      try { doc = app.ActiveDocument; } catch (e) {}
      if (doc) {
        try { return { name: doc.Name || '', path: doc.Path || '', appType: 'wps' }; } catch (e) { return null; }
      }
      try { doc = app.ActiveWorkbook; } catch (e) {}
      if (doc) {
        try { return { name: doc.Name || '', path: doc.Path || '', appType: 'et' }; } catch (e) { return null; }
      }
      try { doc = app.ActivePresentation; } catch (e) {}
      if (doc) {
        try { return { name: doc.Name || '', path: doc.Path || '', appType: 'wpp' }; } catch (e) { return null; }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // ══════════════════════════════════════════════
  // 阶段 2：编辑命令（Word/WPS 文字为主）
  // ══════════════════════════════════════════════

  /** 获取活动文档信息（轮询命令契约：data 含 paragraphCount/wordCount/characterCount） */
  function getActiveDocument() {
    var info = getActiveDocumentInfo();
    if (!info) return fail('没有打开的文档');
    return ok({
      name: info.name,
      path: info.path,
      appType: info.appType,
      paragraphCount: info.paragraphCount || 0,
      wordCount: info.wordCount || 0,
      characterCount: info.characterCount || 0
    });
  }

  /** 获取选中文本（轮询命令契约：data 含 text/length） */
  function getSelectedTextCmd() {
    try {
      var sel = null;
      var app = getApplication();
      try { sel = app && app.Selection; } catch (e) {}
      if (!sel) return fail('没有选中内容');
      var text = sel.Text || '';
      return ok({ text: text, length: text.length });
    } catch (e) {
      return fail('获取选中文本失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 替换选中文本（Word：sel.Text = text；ET：ActiveCell.Value2） */
  function setSelectedText(params) {
    try {
      var sel = null;
      var app = getApplication();
      try { sel = app && app.Selection; } catch (e) {}
      if (!sel) return fail('没有选中的文本范围');
      var text = (params && params.text !== undefined && params.text !== null) ? String(params.text) : '';
      var appType = getAppType();
      if (appType === 'et') {
        try {
          sel.Value2 = text;
          return ok({ message: '已替换选中内容' });
        } catch (e) {
          return fail('替换选中内容失败: ' + e.message);
        }
      }
      sel.Text = text;
      return ok({ message: '已替换选中文本' });
    } catch (e) {
      return fail('设置选中文本失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入文本：position 支持 'cursor'|'start'|'end'，也兼容数字（0=start，其余按光标） */
  function insertText(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (params === undefined || params === null || params.text === undefined || params.text === null) {
        return invalidParam('缺少 text');
      }
      var text = String(params.text);
      var pos = params.position;
      var textLength = text.length;
      var positionText = '光标位置';
      if (pos === 'start' || pos === 0) {
        doc.Range(0, 0).InsertBefore(text);
        positionText = '文档开头';
      } else if (pos === 'end') {
        var end = doc.Content.End - 1;
        doc.Range(end, end).InsertAfter(text);
        positionText = '文档结尾';
      } else {
        // 默认/光标/cursor/其他数字都按光标处插入
        var app = getApplication();
        if (app && app.Selection) {
          app.Selection.TypeText(text);
        } else {
          doc.Content.InsertAfter(text);
          positionText = '文档结尾';
        }
      }
      return ok({
        success: true,
        message: '文本插入成功',
        position: positionText,
        textLength: textLength
      });
    } catch (e) {
      return fail('插入文本失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 获取文档全文（支持 maxLength 截断 + start/end 偏移截取） */
  function getDocumentText(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var text = doc.Content.Text || '';
      var length = text.length;
      var start = 0;
      var end = length;

      if (params) {
        // 兼容 wps_word_get_document_text 的 start/end 偏移
        if (params.start !== undefined && params.start !== null) {
          start = parseInt(params.start, 10);
          if (isNaN(start) || start < 0) return invalidParam('start 必须为非负整数');
        }
        if (params.end !== undefined && params.end !== null) {
          end = parseInt(params.end, 10);
          if (isNaN(end) || end < start) return invalidParam('end 必须 >= start');
          end = Math.min(end, length);
        }
        text = text.substring(start, end);
        length = text.length;
      }

      var truncated = false;
      var maxLength = params && params.maxLength !== undefined ? parseInt(params.maxLength, 10) : 0;
      if (isNaN(maxLength) || maxLength < 0) return invalidParam('无效的 maxLength: ' + params.maxLength + '（必须为非负整数）');
      if (maxLength > 0 && length > maxLength) {
        text = text.substring(0, maxLength) + '\n...(截断, 共 ' + length + ' 字符)';
        truncated = true;
      }
      return ok({ text: text, length: length, truncated: truncated, maxLength: maxLength });
    } catch (e) {
      return fail('获取文档文本失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 按字符偏移读取文档原始文本 */
  function getDocumentTextByRange(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var full = doc.Content.Text || '';
      var docLength = full.length;
      var startOffset = params && params.startOffset !== undefined ? parseInt(params.startOffset, 10) : 0;
      if (isNaN(startOffset) || startOffset < 0) return invalidParam('startOffset 必须为非负整数');
      startOffset = Math.min(startOffset, docLength);
      var len = params && params.length !== undefined ? parseInt(params.length, 10) : (docLength - startOffset);
      if (isNaN(len) || len < 0) return invalidParam('length 必须为非负整数');
      len = Math.min(len, docLength - startOffset);
      var text = full.substring(startOffset, startOffset + len);
      return ok({ text: text, startOffset: startOffset, length: text.length, docLength: docLength });
    } catch (e) {
      return fail('读取文档文本失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 获取段落结构 */
  function getDocumentParagraphs(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var totalCount = doc.Paragraphs ? doc.Paragraphs.Count : 0;
      var startParagraph = params && params.startParagraph !== undefined ? parseInt(params.startParagraph, 10) : 1;
      var endParagraph = params && params.endParagraph !== undefined ? parseInt(params.endParagraph, 10) : (startParagraph + 49);
      if (isNaN(startParagraph) || startParagraph < 1) startParagraph = 1;
      if (isNaN(endParagraph)) endParagraph = startParagraph + 49;
      if (startParagraph > totalCount) startParagraph = totalCount;
      if (endParagraph > totalCount) endParagraph = totalCount;

      var paragraphs = [];
      for (var i = startParagraph; i <= endParagraph; i++) {
        var p = null;
        try { p = doc.Paragraphs.Item(i); } catch (e) { continue; }
        if (!p) continue;
        var text = '';
        var style = '';
        var start = 0;
        var end = 0;
        try { text = p.Range.Text || ''; } catch (e) {}
        try { style = p.Style ? String(p.Style.NameLocal || p.Style) : ''; } catch (e) {}
        try { start = p.Range.Start || 0; } catch (e) {}
        try { end = p.Range.End || 0; } catch (e) {}
        paragraphs.push({ index: i, text: text, style: style, start: start, end: end });
      }
      return ok({ paragraphs: paragraphs, totalCount: totalCount, returnedCount: paragraphs.length });
    } catch (e) {
      return fail('获取段落结构失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 查找替换：返回 {count, findText, replaceText}（replaceMode=true 时执行替换） */
  function findReplace(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (!params || !params.findText) return invalidParam('缺少 findText');
      var findText = String(params.findText);
      var replaceText = params.replaceText !== undefined && params.replaceText !== null ? String(params.replaceText) : '';
      var replaceAll = params.replaceAll !== false;
      var matchCase = !!params.matchCase;
      var matchWholeWord = !!params.matchWholeWord;
      var replaceMode = !!params.replaceMode;

      // 用 Content.Find 逐次查找统计命中数。
      // 统一通过 Execute 位置参数传查找/替换文本（与参考 opencode-wps word-handler.js 一致），
      // 避免前置赋值 + 位置参数双写（WPS 对 Execute 位置参数敏感，双写行为未定义）。
      // Wrap 位置参数必须传 0（wdFindStop）：Forward=true + wdFindContinue 会在到文末后回卷，
      // 导致循环永不终止（冻结 + 计数错误）。
      var count = 0;
      var find = doc.Content.Find;
      find.ClearFormatting();
      find.Replacement.ClearFormatting();

      if (replaceMode) {
        // 逐次替换并计数：Replace=1(wdReplaceOne) + Wrap=0(wdFindStop)，
        // 每次 Execute 替换一处并在文档末尾返回 false 终止，count 即真实替换数
        // （findReplaceHandler 读取 result.count，契约见 wps-office-mcp content.ts）。
        var replacedAny = false;
        for (var guard = 0; guard < 100000; guard++) {
          var okFind = find.Execute(
            findText, matchCase, matchWholeWord, false, false, false,
            true, 0, false, replaceText, 1
          );
          if (!okFind) break;
          count++;
          replacedAny = true;
          if (!replaceAll) break;
        }
        return ok({
          success: true,
          message: replacedAny ? ('替换完成，共替换 ' + count + ' 处') : ('未找到 "' + findText + '"，没有进行替换'),
          findText: findText,
          replaceText: replaceText,
          count: count
        });
      } else {
        // 仅查找计数：Wrap=0(wdFindStop) + Forward=true，Execute 依次命中并在文末返回 false
        for (var guard2 = 0; guard2 < 100000; guard2++) {
          var found = find.Execute(findText, matchCase, matchWholeWord, false, false, false, true, 0, false, '', 0);
          if (!found) break;
          count++;
        }
        return ok({
          success: true,
          message: '查找完成，"' + findText + '" 出现 ' + count + ' 次',
          findText: findText,
          replaceText: '',
          count: count
        });
      }
    } catch (e) {
      return fail('查找替换失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 查找并返回位置信息（不替换） */
  function findInDocument(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (!params || !params.findText) return invalidParam('缺少 findText');
      var findText = String(params.findText);
      var matchCase = !!params.matchCase;
      var matchWholeWord = !!params.matchWholeWord;
      var maxResults = params.maxResults !== undefined ? parseInt(params.maxResults, 10) : 20;
      if (isNaN(maxResults) || maxResults < 1) maxResults = 20;

      var results = [];
      var fullText = doc.Content.Text || '';
      // 简单索引扫描（大小写/全字匹配选项简化处理）
      var searchText = matchCase ? fullText : fullText.toLowerCase();
      var needle = matchCase ? findText : findText.toLowerCase();
      var idx = 0;
      // 增量统计换行数：scanPos 记录上次已扫描到的位置，段落在 foundAt 前的换行数
      // 由 runningNewlines + 本次 [scanPos, foundAt) 区间增量得到，避免每命中重扫全文 O(n*m)
      var runningNewlines = 0;
      var scanPos = 0;
      function countNewlines(from, to) {
        var n = 0;
        for (var k = from; k < to && k < fullText.length; k++) {
          var ch = fullText.charAt(k);
          if (ch === '\n' || ch === '\r') n++;
        }
        return n;
      }
      while (results.length < maxResults) {
        var foundAt = searchText.indexOf(needle, idx);
        if (foundAt === -1) break;
        // 全字匹配：检查边界非字母数字
        if (matchWholeWord) {
          var before = foundAt > 0 ? searchText.charAt(foundAt - 1) : ' ';
          var after = searchText.charAt(foundAt + needle.length);
          if (/[A-Za-z0-9\u4e00-\u9fa5]/.test(before) || /[A-Za-z0-9\u4e00-\u9fa5]/.test(after)) {
            idx = foundAt + needle.length;
            continue;
          }
        }
        var contextStart = Math.max(0, foundAt - 50);
        var contextEnd = Math.min(fullText.length, foundAt + findText.length + 50);
        // 段落索引：runningNewlines + [scanPos, foundAt) 区间增量 + 1
        runningNewlines += countNewlines(scanPos, foundAt);
        scanPos = foundAt;
        var paraIndex = runningNewlines + 1;
        results.push({
          text: fullText.substring(foundAt, foundAt + findText.length),
          start: foundAt,
          end: foundAt + findText.length,
          paragraphIndex: paraIndex,
          context: fullText.substring(contextStart, contextEnd)
        });
        idx = foundAt + needle.length;
        scanPos = idx;
      }
      return ok({ results: results, count: results.length, findText: findText });
    } catch (e) {
      return fail('查找失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 智能填写模板字段 */
  function smartFillField(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (!params || !params.keyword) return invalidParam('缺少 keyword');
      if (params.value === undefined || params.value === null) return invalidParam('缺少 value');
      var keyword = String(params.keyword);
      var value = String(params.value);
      var fillMode = params.fillMode || 'auto';
      var occurrence = params.occurrence !== undefined ? parseInt(params.occurrence, 10) : 1;
      if (isNaN(occurrence) || occurrence < 1) occurrence = 1;

      var fullText = doc.Content.Text || '';
      var result = '';
      var idx = -1;
      var seen = 0;
      var searchPos = 0;
      while (true) {
        var foundAt = fullText.indexOf(keyword, searchPos);
        if (foundAt === -1) break;
        seen++;
        if (seen === occurrence) { idx = foundAt; break; }
        searchPos = foundAt + keyword.length;
      }
      if (idx === -1) return fail('未找到关键字 "' + keyword + '"（第 ' + occurrence + ' 处）');

      var range = null;
      // 依据 fillMode 决定替换范围
      if (fillMode === 'placeholder' || fillMode === 'underline') {
        // 占位符/下划线：向后匹配一段可替换内容（{}、【】或下划线串）
        var endIdx = idx + keyword.length;
        var m = fullText.substring(endIdx).match(/^([{}【】_\-—\s]*)/);
        var tailLen = m ? m[0].length : 0;
        try { range = doc.Range(idx, endIdx + tailLen); } catch (e) {}
        if (range) {
          range.Text = value;
          result = '已替换 "' + keyword + '" 及其后的占位内容为 "' + value + '"';
        }
      }
      if (!range) {
        // 默认/afterColon/afterLabel/auto：在关键字后插入
        var insertAt = idx + keyword.length;
        try { range = doc.Range(insertAt, insertAt); } catch (e) {}
        if (range) {
          range.InsertAfter(value);
          result = '已在 "' + keyword + '" 后插入 "' + value + '"';
        }
      }
      if (!range) return fail('智能填写失败：无法定位插入点');
      return ok({ keyword: keyword, value: value, fillMode: fillMode, result: result });
    } catch (e) {
      return fail('智能填写失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 替换书签内容（保持书签） */
  function replaceBookmarkContent(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (!params || !params.name) return invalidParam('缺少 name');
      if (params.text === undefined || params.text === null) return invalidParam('缺少 text');
      var name = String(params.name);
      var text = String(params.text);
      if (!doc.Bookmarks || !doc.Bookmarks.Exists(name)) return fail('书签不存在: ' + name);
      var bm = doc.Bookmarks.Item(name);
      var start = bm.Range.Start;
      var end = bm.Range.End;
      bm.Range.Text = text;
      // 重建书签保持位置
      try { doc.Bookmarks.Add(name, doc.Range(start, start + text.length)); } catch (e) {}
      return ok({ name: name, text: text, start: start, end: start + text.length });
    } catch (e) {
      return fail('替换书签内容失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 设置字体 */
  function setFont(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var range = (params && params.range === 'all') ? doc.Content : getSelectionRange();
      if (!range) return fail('请先在文档中选中文本或设置光标');
      if (!params || (params.fontName === undefined && params.fontSize === undefined && params.bold === undefined && params.italic === undefined && params.underline === undefined && params.color === undefined)) {
        return invalidParam('请至少指定一个字体属性');
      }
      if (params.fontName !== undefined) range.Font.Name = params.fontName;
      if (params.fontSize !== undefined) range.Font.Size = params.fontSize;
      if (params.bold !== undefined) range.Font.Bold = params.bold;
      if (params.italic !== undefined) range.Font.Italic = params.italic;
      if (params.underline !== undefined) range.Font.Underline = params.underline;
      if (params.color !== undefined) {
        var fc = parseColor(params.color);
        if (fc === null) return fail('无效的颜色值: ' + params.color + '，支持的格式: #FF0000, FF0000, red, blue 等');
        range.Font.Color = fc;
      }
      return ok({ settings: params });
    } catch (e) {
      return fail('设置字体失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 设置选中文字颜色 */
  function setTextColor(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var range = getSelectionRange();
      if (!range) return fail('请先在文档中选中文本');
      if (!params || params.color === undefined || params.color === null) return invalidParam('缺少 color');
      var color = parseColor(params.color);
      if (color === null) return fail('无效的颜色值: ' + params.color + '，支持的格式: #FF0000, FF0000, red, blue 等');
      range.Font.Color = color;
      return ok({});
    } catch (e) {
      return fail('设置文字颜色失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 设置段落格式 */
  function setParagraph(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var range = (params && params.range === 'all') ? doc.Content : getSelectionRange();
      if (!range) return fail('请先在文档中选中文本或设置光标');
      var para = range.ParagraphFormat;
      if (params.alignment !== undefined) para.Alignment = params.alignment;
      if (params.lineSpacing !== undefined && params.lineSpacing) {
        para.LineSpacingRule = 5;
        para.LineSpacing = params.lineSpacing;
      }
      if (params.spaceBefore !== undefined) para.SpaceBefore = params.spaceBefore;
      if (params.spaceAfter !== undefined) para.SpaceAfter = params.spaceAfter;
      if (params.firstLineIndent !== undefined) para.FirstLineIndent = params.firstLineIndent;
      return ok({});
    } catch (e) {
      return fail('设置段落格式失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 设置行距 */
  function setLineSpacing(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var lineSpacing = params && params.lineSpacing;
      if (lineSpacing === undefined || lineSpacing === null || lineSpacing <= 0) return invalidParam('行距值必须为正数');
      var range;
      if (params.paragraphIndex !== undefined && params.paragraphIndex !== null) {
        var paraIdx = parseInt(params.paragraphIndex, 10);
        if (isNaN(paraIdx) || paraIdx < 0 || paraIdx >= doc.Paragraphs.Count) return invalidParam('段落索引超出范围');
        range = doc.Paragraphs.Item(paraIdx + 1).Range;
      } else {
        range = getSelectionRange();
        if (!range) return fail('请先在文档中选中文本或设置光标');
      }
      range.ParagraphFormat.LineSpacingRule = 5;
      range.ParagraphFormat.LineSpacing = lineSpacing;
      return ok({});
    } catch (e) {
      return fail('设置行距失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 应用样式到选中文本 */
  function applyStyle(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (!params || !params.styleName) return invalidParam('缺少 styleName');
      var range = getSelectionRange();
      if (!range) return fail('请先在文档中选中文本');
      range.Style = params.styleName;
      var affectedText = '';
      try { affectedText = range.Text || ''; } catch (e) {}
      return ok({ affectedText: affectedText });
    } catch (e) {
      return fail('应用样式失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入表格 */
  function insertTable(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var rows = parseInt(params && params.rows, 10);
      if (isNaN(rows) || rows < 1) return invalidParam('无效的行数: ' + params.rows + '（必须为正整数）');
      var cols = parseInt(params && params.cols, 10);
      if (isNaN(cols) || cols < 1) return invalidParam('无效的列数: ' + params.cols + '（必须为正整数）');
      var app = getApplication();
      if (!app || !app.Selection) return fail('没有打开的文档');
      var table = doc.Tables.Add(app.Selection.Range, rows, cols);
      if (params.data && Array.isArray(params.data)) {
        for (var r = 0; r < Math.min(params.data.length, rows); r++) {
          var rowData = params.data[r];
          if (Array.isArray(rowData)) {
            for (var c = 0; c < Math.min(rowData.length, cols); c++) {
              table.Cell(r + 1, c + 1).Range.Text = String(rowData[c]);
            }
          }
        }
      }
      table.Borders.Enable = true;
      return ok({ rows: rows, cols: cols });
    } catch (e) {
      return fail('插入表格失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入分页符 */
  function insertPageBreak() {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      doc.Content.InsertBreak(7);
      return ok({});
    } catch (e) {
      return fail('插入分页符失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入图片 */
  function insertImage(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var filePath = params && (params.path || params.imagePath || params.filePath);
      if (!filePath) return invalidParam('缺少 path');
      var inlineShape = doc.InlineShapes.AddPicture(filePath);
      if (params.width) inlineShape.Width = params.width;
      if (params.height) inlineShape.Height = params.height;
      return ok({});
    } catch (e) {
      return fail('插入图片失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入批注 */
  function addComment(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (!params || !params.text) return invalidParam('缺少 text');
      var app = getApplication();
      doc.Comments.Add(app.Selection.Range, params.text);
      return ok({});
    } catch (e) {
      return fail('添加批注失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入书签 */
  function insertBookmark(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (!params || !params.name) return invalidParam('缺少 name');
      var app = getApplication();
      doc.Bookmarks.Add(params.name, app.Selection.Range);
      return ok({});
    } catch (e) {
      return fail('插入书签失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入页眉 */
  function insertHeader(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var text = params && params.text;
      if (text === undefined || text === null) return invalidParam('缺少 text');
      var section = params.section !== undefined ? parseInt(params.section, 10) : 1;
      if (isNaN(section) || section < 1) section = 1;
      doc.Sections.Item(section).Headers.Item(1).Range.Text = String(text);
      return ok({});
    } catch (e) {
      return fail('插入页眉失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入页脚 */
  function insertFooter(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var text = params && params.text;
      if (text === undefined || text === null) return invalidParam('缺少 text');
      var section = params.section !== undefined ? parseInt(params.section, 10) : 1;
      if (isNaN(section) || section < 1) section = 1;
      doc.Sections.Item(section).Footers.Item(1).Range.Text = String(text);
      return ok({});
    } catch (e) {
      return fail('插入页脚失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 生成目录 */
  function generateTOC() {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var range = doc.Range(0, 0);
      doc.TablesOfContents.Add(range);
      return ok({});
    } catch (e) {
      return fail('生成目录失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 插入分节符 */
  function insertSectionBreak(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var breakType = (params && params.breakType) || 'nextPage';
      var typeMap = { nextPage: 2, continuous: 3, evenPage: 4, oddPage: 5 };
      var type = typeMap[breakType] || 2;
      var app = getApplication();
      app.Selection.InsertBreak(type);
      return ok({});
    } catch (e) {
      return fail('插入分节符失败: ' + (e && e.message ? e.message : e));
    }
  }

  /** 设置页面设置 */
  function setPageSetup(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      if (!params || (params.orientation === undefined && params.topMargin === undefined && params.bottomMargin === undefined && params.leftMargin === undefined && params.rightMargin === undefined && params.pageWidth === undefined && params.pageHeight === undefined)) {
        return invalidParam('请至少指定一个页面设置属性');
      }
      var ps = doc.PageSetup;
      if (params.orientation !== undefined) ps.Orientation = params.orientation === 'landscape' ? 1 : 0;
      if (params.topMargin !== undefined) ps.TopMargin = params.topMargin;
      if (params.bottomMargin !== undefined) ps.BottomMargin = params.bottomMargin;
      if (params.leftMargin !== undefined) ps.LeftMargin = params.leftMargin;
      if (params.rightMargin !== undefined) ps.RightMargin = params.rightMargin;
      if (params.pageWidth !== undefined) ps.PageWidth = params.pageWidth;
      if (params.pageHeight !== undefined) ps.PageHeight = params.pageHeight;
      return ok({ settings: params });
    } catch (e) {
      return fail('设置页面失败: ' + (e && e.message ? e.message : e));
    }
  }

  // ══════════════════════════════════════════════
  // 文档管理（Word）
  // ══════════════════════════════════════════════

  function getOpenDocuments() {
    try {
      var app = getApplication();
      var docs = app.Documents;
      var list = [];
      for (var i = 1; i <= docs.Count; i++) {
        var d = docs.Item(i);
        list.push({ name: d.Name, path: d.FullName, index: i });
      }
      return ok({ documents: list });
    } catch (e) {
      return fail('获取文档列表失败: ' + (e && e.message ? e.message : e));
    }
  }

  function switchDocument(params) {
    try {
      var app = getApplication();
      var docs = app.Documents;
      var target = params && (params.name || params.index);
      var doc = null;
      if (typeof target === 'number') {
        doc = docs.Item(target);
      } else {
        for (var i = 1; i <= docs.Count; i++) {
          if (docs.Item(i).Name === target) { doc = docs.Item(i); break; }
        }
      }
      if (!doc) return fail('未找到文档: ' + target);
      doc.Activate();
      return ok({ name: doc.Name });
    } catch (e) {
      return fail('切换文档失败: ' + (e && e.message ? e.message : e));
    }
  }

  function openDocument(params) {
    try {
      var filePath = params && (params.path || params.filePath);
      if (!filePath) return invalidParam('缺少 path');
      var app = getApplication();
      var doc = app.Documents.Open(filePath);
      return ok({ name: doc.Name, path: doc.FullName });
    } catch (e) {
      return fail('打开文档失败: ' + (e && e.message ? e.message : e));
    }
  }

  function createDocument() {
    try {
      var app = getApplication();
      var doc = app.Documents.Add();
      return ok({ name: doc.Name });
    } catch (e) {
      return fail('创建文档失败: ' + (e && e.message ? e.message : e));
    }
  }

  // ══════════════════════════════════════════════
  // 通用文件操作
  // ══════════════════════════════════════════════

  function save() {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      doc.Save();
      return ok({ message: '保存成功' });
    } catch (e) {
      return fail('保存失败: ' + (e && e.message ? e.message : e));
    }
  }

  function saveAs(params) {
    try {
      var doc = getActiveDoc();
      if (!doc) return fail('没有打开的文档');
      var filePath = params && (params.path || params.filePath || params.outputPath);
      if (!filePath) return invalidParam('缺少 path');
      doc.SaveAs(filePath);
      return ok({ outputPath: filePath });
    } catch (e) {
      return fail('另存为失败: ' + (e && e.message ? e.message : e));
    }
  }

  function openFile(params) {
    try {
      var filePath = params && (params.path || params.filePath);
      if (!filePath) return invalidParam('缺少 path');
      var lower = String(filePath).toLowerCase();
      var appType = null;
      if (/\.xlsx?$/.test(lower)) appType = 'et';
      else if (/\.docx?$/.test(lower)) appType = 'wps';
      else if (/\.pptx?$/.test(lower)) appType = 'wpp';
      else appType = getAppType();

      var docs = null;
      var app = getApplication();
      if (appType === 'et') docs = app.Workbooks;
      else if (appType === 'wps') docs = app.Documents;
      else if (appType === 'wpp') docs = app.Presentations;
      if (!docs) return fail('当前应用不支持打开文件: ' + appType);
      docs.Open(filePath);
      return ok({ path: filePath });
    } catch (e) {
      return fail('打开文件失败: ' + (e && e.message ? e.message : e));
    }
  }

  // ══════════════════════════════════════════════
  // 表格（WPS 表格 / Excel）
  // ══════════════════════════════════════════════

  function getActiveWorkbook() {
    try {
      var app = getApplication();
      var wb = app.ActiveWorkbook;
      if (!wb) return fail('没有打开的工作簿');
      var sheets = [];
      for (var i = 1; i <= wb.Sheets.Count; i++) {
        sheets.push({ name: wb.Sheets.Item(i).Name, index: i });
      }
      var activeSheet = '';
      try { activeSheet = app.ActiveSheet ? app.ActiveSheet.Name : ''; } catch (e) {}
      return ok({
        name: wb.Name,
        path: wb.FullName,
        sheetCount: wb.Sheets.Count,
        sheets: sheets,
        activeSheet: activeSheet,
        activeSheetIndex: 0
      });
    } catch (e) {
      return fail('获取工作簿信息失败: ' + (e && e.message ? e.message : e));
    }
  }

  function getCellValue(params) {
    try {
      var app = getApplication();
      var wb = app.ActiveWorkbook;
      if (!wb) return fail('没有打开的工作簿');
      var sheet = getExcelSheet(wb, params && params.sheet);
      if (!sheet) return fail('未找到工作表: ' + (params && params.sheet));
      var rc = resolveRowCol(params && params.row, params && params.col);
      if (!rc) return fail('无效的行/列参数: row=' + (params && params.row) + ' col=' + (params && params.col) + '（必须为正整数）');
      var cell = sheet.Cells.Item(rc.row, rc.col);
      var value = null;
      try { value = cell.Value2; } catch (e) {}
      return ok({ value: value, text: value !== null ? String(value) : '', formula: '' });
    } catch (e) {
      return fail('读取单元格失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setCellValue(params) {
    try {
      var app = getApplication();
      var wb = app.ActiveWorkbook;
      if (!wb) return fail('没有打开的工作簿');
      var sheet = getExcelSheet(wb, params && params.sheet);
      if (!sheet) return fail('未找到工作表: ' + (params && params.sheet));
      var rc = resolveRowCol(params && params.row, params && params.col);
      if (!rc) return fail('无效的行/列参数: row=' + (params && params.row) + ' col=' + (params && params.col) + '（必须为正整数）');
      sheet.Cells.Item(rc.row, rc.col).Value2 = params.value;
      return ok({});
    } catch (e) {
      return fail('设置单元格失败: ' + (e && e.message ? e.message : e));
    }
  }

  // ══════════════════════════════════════════════
  // 演示文稿（WPS 演示 / PPT）
  // ══════════════════════════════════════════════

  function getActivePresentation() {
    try {
      var app = getApplication();
      var pres = app.ActivePresentation;
      if (!pres) return fail('没有打开的演示文稿');
      return ok({ name: pres.Name, path: pres.FullName, slideCount: pres.Slides.Count, slides: [] });
    } catch (e) {
      return fail('获取演示文稿信息失败: ' + (e && e.message ? e.message : e));
    }
  }

  // ──────────────────────────────────────────────────────────────
  // PPT（演示文稿）方法
  // 移植自 third_party/opencode-wps/opencode-wps-linux/handlers/ppt-handler.js
  // 契约：每方法返回 { success, data, error }（与轮询 /result 一致）。
  // 命名约定：poll.js POLL_ACTION_MAP[action] -> WpsBridge[action]。
  // ──────────────────────────────────────────────────────────────

  var PPT_COLOR_SCHEMES = {
    business: { title: 0x2F5496, body: 0x333333, accent: 0x4472C4 },
    tech: { title: 0x00B0F0, body: 0x404040, accent: 0x0078D7 },
    creative: { title: 0xFF6B6B, body: 0x4A4A4A, accent: 0xE74856 },
    minimal: { title: 0x000000, body: 0x666666, accent: 0x999999 }
  };

  // 当前活动演示文稿；无返回 null
  function getPres() {
    try {
      var app = getApplication();
      if (!app) return null;
      return app.ActivePresentation || null;
    } catch (e) {
      return null;
    }
  }

  // 校验并归一化 slideIndex（正整数且不越界）；非法返回 null
  function resolveSlideIndex(pres, idx) {
    var n = parseInt(idx, 10);
    if (isNaN(n) || n < 1) return null;
    if (n > pres.Slides.Count) return null;
    return n;
  }

  // PPT ForeColor.RGB 需 RGB 顺序（与 Word/Excel BGR 不同）；#RRGGBB / #RGB / 数字
  function toRgb(color) {
    if (typeof color === 'number') return color;
    if (typeof color !== 'string') return null;
    var hex = color.trim();
    if (hex.charAt(0) === '#') hex = hex.substring(1);
    if (hex.length === 3) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    }
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return parseInt(hex, 16);
  }

  // 在指定幻灯片中按名称或序号定位形状；null/undefined -> 第一个
  function findShape(slide, nameOrIndex) {
    if (typeof nameOrIndex === 'number') {
      try { return slide.Shapes.Item(nameOrIndex); } catch (e) { return null; }
    }
    if (nameOrIndex == null) return (slide.Shapes.Count > 0) ? slide.Shapes.Item(1) : null;
    for (var j = 1; j <= slide.Shapes.Count; j++) {
      if (slide.Shapes.Item(j).Name === nameOrIndex) return slide.Shapes.Item(j);
    }
    return null;
  }

  // 在备注页中定位备注占位符：优先 ppPlaceholderBody(2)/ppPlaceholderObject(7)，其次第一个有文本的文本框
  function findNotesShape(shapes) {
    try {
      for (var j = 1; j <= shapes.Count; j++) {
        var s = shapes.Item(j);
        try {
          var pf = s.PlaceholderFormat;
          if (pf && (pf.Type === 2 || pf.Type === 7)) return s;
        } catch (e) {}
      }
      for (var k = 1; k <= shapes.Count; k++) {
        var s2 = shapes.Item(k);
        try { if (s2.HasTextFrame && s2.TextFrame.HasText) return s2; } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  function getOpenPresentations(params) {
    try {
      var app = getApplication();
      var preses = app.Presentations;
      var list = [];
      for (var i = 1; i <= preses.Count; i++) {
        var p = preses.Item(i);
        list.push({ name: p.Name, path: p.FullName, index: i, slideCount: p.Slides.Count });
      }
      return ok({ presentations: list });
    } catch (e) {
      return fail('获取演示文稿列表失败: ' + (e && e.message ? e.message : e));
    }
  }

  function switchPresentation(params) {
    try {
      var app = getApplication();
      var preses = app.Presentations;
      var target = params.name || params.index;
      var found = null;
      if (typeof target === 'number') {
        found = preses.Item(target);
      } else {
        for (var i = 1; i <= preses.Count; i++) {
          if (preses.Item(i).Name === target) { found = preses.Item(i); break; }
        }
      }
      if (!found) return fail('未找到演示文稿: ' + target);
      found.Activate();
      return ok({ name: found.Name });
    } catch (e) {
      return fail('切换演示文稿失败: ' + (e && e.message ? e.message : e));
    }
  }

  function openPresentation(params) {
    try {
      var app = getApplication();
      var filePath = params.path || params.filePath;
      if (!filePath) return invalidParam('缺少 path');
      var pres = app.Presentations.Open(filePath);
      return ok({ name: pres.Name, path: pres.FullName });
    } catch (e) {
      return fail('打开演示文稿失败: ' + (e && e.message ? e.message : e));
    }
  }

  function createPresentation(params) {
    try {
      var app = getApplication();
      var pres = app.Presentations.Add();
      return ok({ name: pres.Name });
    } catch (e) {
      return fail('创建演示文稿失败: ' + (e && e.message ? e.message : e));
    }
  }

  function closePresentation(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      pres.Close();
      return ok({});
    } catch (e) {
      return fail('关闭演示文稿失败: ' + (e && e.message ? e.message : e));
    }
  }

  function addSlide(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var layouts = { title: 1, title_content: 2, blank: 12, two_column: 3 };
      var layoutType = layouts[params.layout] || 2;
      var position = params.position !== undefined ? parseInt(params.position, 10) : (pres.Slides.Count + 1);
      if (isNaN(position) || position < 1 || position > pres.Slides.Count + 1) {
        return fail('无效的插入位置: ' + params.position + '（合法范围 1~' + (pres.Slides.Count + 1) + '）');
      }
      var slide = pres.Slides.Add(position, layoutType);
      var titleFailed = false;
      if (params.title) {
        try {
          if (slide.Shapes.HasTitle) {
            slide.Shapes.Title.TextFrame.TextRange.Text = params.title;
          } else {
            titleFailed = true;
          }
        } catch (e) {
          titleFailed = true;
        }
      }
      var actualIndex = (slide.SlideIndex !== undefined) ? slide.SlideIndex : position;
      if (titleFailed) {
        return ok({ slideIndex: actualIndex, titleFailed: true, warning: '幻灯片已插入但标题设置失败（布局可能无标题占位符）' });
      }
      return ok({ slideIndex: actualIndex });
    } catch (e) {
      return fail('添加幻灯片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function deleteSlide(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || params.index || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + (params.slideIndex || params.index) + '（合法范围 1~' + pres.Slides.Count + '）');
      pres.Slides.Item(idx).Delete();
      return ok({});
    } catch (e) {
      return fail('删除幻灯片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function duplicateSlide(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      pres.Slides.Item(idx).Duplicate();
      return ok({});
    } catch (e) {
      return fail('复制幻灯片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function moveSlide(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var target = params.targetIndex;
      if (target === undefined || target === null) return fail('缺少 targetIndex');
      var targetNum = parseInt(target, 10);
      if (isNaN(targetNum) || targetNum < 1 || targetNum > pres.Slides.Count) {
        return fail('无效的目标位置: ' + target + '（合法范围 1~' + pres.Slides.Count + '）');
      }
      pres.Slides.Item(idx).MoveTo(targetNum);
      return ok({});
    } catch (e) {
      return fail('移动幻灯片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function getSlideCount(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      return ok({ slideCount: pres.Slides.Count, count: pres.Slides.Count });
    } catch (e) {
      return fail('获取幻灯片数量失败: ' + (e && e.message ? e.message : e));
    }
  }

  function getSlideInfo(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || params.index || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + (params.slideIndex || params.index) + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      var shapes = [];
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        shapes.push({ name: s.Name, type: s.Type, left: s.Left, top: s.Top, width: s.Width, height: s.Height });
      }
      return ok({ index: idx, shapeCount: slide.Shapes.Count, shapes: shapes });
    } catch (e) {
      return fail('获取幻灯片信息失败: ' + (e && e.message ? e.message : e));
    }
  }

  function switchSlide(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || params.index || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + (params.slideIndex || params.index) + '（合法范围 1~' + pres.Slides.Count + '）');
      pres.Slides.Item(idx).Select();
      return ok({ slideIndex: idx });
    } catch (e) {
      return fail('切换幻灯片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function getSlideTitle(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      var title = '';
      if (slide.Shapes.HasTitle) {
        title = slide.Shapes.Title.TextFrame.TextRange.Text;
      }
      return ok({ slideIndex: idx, title: title });
    } catch (e) {
      return fail('获取幻灯片标题失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideTitle(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      if (!slide.Shapes.HasTitle) return fail('当前幻灯片无标题占位符（可能使用了空白布局）');
      slide.Shapes.Title.TextFrame.TextRange.Text = params.title;
      return ok({});
    } catch (e) {
      return fail('设置幻灯片标题失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideSubtitle(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (!s.HasTextFrame) continue;
        try {
          var pf = s.PlaceholderFormat;
          if (pf && pf.Type === 15) {
            s.TextFrame.TextRange.Text = params.subtitle;
            return ok({});
          }
        } catch (e) {}
      }
      return fail('未找到副标题占位符');
    } catch (e) {
      return fail('设置幻灯片副标题失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideContent(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (!s.HasTextFrame) continue;
        try {
          var pf = s.PlaceholderFormat;
          if (pf && pf.Type === 2) {
            s.TextFrame.TextRange.Text = params.content || '';
            return ok({ updated: true, via: 'body-placeholder' });
          }
        } catch (e) {}
      }
      for (var j2 = 1; j2 <= slide.Shapes.Count; j2++) {
        var s2 = slide.Shapes.Item(j2);
        if (!s2.HasTextFrame) continue;
        try {
          var pf2 = s2.PlaceholderFormat;
          if (pf2 && (pf2.Type === 13 || pf2.Type === 14 || pf2.Type === 15)) continue;
        } catch (e) {}
        if (s2.TextFrame.TextRange.Text) {
          s2.TextFrame.TextRange.Text = params.content || '';
          return ok({ updated: true });
        }
      }
      return ok({ updated: false });
    } catch (e) {
      return fail('设置幻灯片内容失败: ' + (e && e.message ? e.message : e));
    }
  }

  function addTextBox(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shape = slide.Shapes.AddTextbox(1, params.left || 100, params.top || 100, params.width || 400, params.height || 50);
      shape.TextFrame.TextRange.Text = params.text || '';
      if (params.fontSize) shape.TextFrame.TextRange.Font.Size = params.fontSize;
      if (params.fontName) shape.TextFrame.TextRange.Font.Name = params.fontName;
      return ok({ shapeName: shape.Name });
    } catch (e) {
      return fail('添加文本框失败: ' + (e && e.message ? e.message : e));
    }
  }

  function deleteTextBox(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          slide.Shapes.Item(j).Delete();
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('删除文本框失败: ' + (e && e.message ? e.message : e));
    }
  }

  function getTextBoxes(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var boxes = [];
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.HasTextFrame) {
          boxes.push({ name: s.Name, text: s.TextFrame.TextRange.Text });
        }
      }
      return ok({ textBoxes: boxes });
    } catch (e) {
      return fail('获取文本框列表失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setTextBoxText(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          slide.Shapes.Item(j).TextFrame.TextRange.Text = params.text || '';
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置文本框文本失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setTextBoxStyle(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName && s.HasTextFrame) {
          var tr = s.TextFrame.TextRange;
          if (params.fontName) tr.Font.Name = params.fontName;
          if (params.fontSize) tr.Font.Size = params.fontSize;
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置文本框样式失败: ' + (e && e.message ? e.message : e));
    }
  }

  function addShape(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeTypes = { rectangle: 1, oval: 9, line: 6, arrow: 13, diamond: 4, triangle: 5 };
      var st = shapeTypes[params.shapeType] || 1;
      var shape = slide.Shapes.AddShape(st, params.left || 100, params.top || 100, params.width || 100, params.height || 100);
      if (params.text) {
        shape.TextFrame.TextRange.Text = params.text;
      }
      return ok({ shapeName: shape.Name });
    } catch (e) {
      return fail('添加形状失败: ' + (e && e.message ? e.message : e));
    }
  }

  function deleteShape(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          slide.Shapes.Item(j).Delete();
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('删除形状失败: ' + (e && e.message ? e.message : e));
    }
  }

  function getShapes(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapes = [];
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        shapes.push({ name: s.Name, type: s.Type, left: s.Left, top: s.Top, width: s.Width, height: s.Height });
      }
      return ok({ shapes: shapes });
    } catch (e) {
      return fail('获取形状列表失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeText(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          slide.Shapes.Item(j).TextFrame.TextRange.Text = params.text || '';
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状文本失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapePosition(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          if (params.left !== undefined) s.Left = params.left;
          if (params.top !== undefined) s.Top = params.top;
          if (params.width !== undefined) s.Width = params.width;
          if (params.height !== undefined) s.Height = params.height;
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状位置失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeStyle(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          if (params.fillColor) {
            var fc = toRgb(params.fillColor);
            if (fc === null) return fail('无效的填充颜色: ' + params.fillColor);
            s.Fill.ForeColor.RGB = fc;
            s.Fill.Visible = 1;
          }
          if (params.lineColor) {
            var lc = toRgb(params.lineColor);
            if (lc === null) return fail('无效的线条颜色: ' + params.lineColor);
            s.Line.ForeColor.RGB = lc;
          }
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状样式失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeBorder(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          s.Line.Visible = 1;
          if (params.color) {
            var lc = toRgb(params.color);
            if (lc === null) return fail('无效的边框颜色: ' + params.color);
            s.Line.ForeColor.RGB = lc;
          }
          if (params.weight) s.Line.Weight = params.weight;
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状边框失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeShadow(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          s.Shadow.Visible = (params.visible !== false) ? 1 : 0;
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状阴影失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeTransparency(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          s.Fill.Transparency = params.transparency || 0;
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状透明度失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeZOrder(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          var cmd = params.command || 'forward';
          if (cmd === 'forward' || cmd === 'up') s.ZOrder(1);
          else if (cmd === 'backward' || cmd === 'down') s.ZOrder(2);
          else if (cmd === 'front' || cmd === 'top') s.ZOrder(0);
          else if (cmd === 'bottom' || cmd === 'back') s.ZOrder(3);
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状层级失败: ' + (e && e.message ? e.message : e));
    }
  }

  function groupShapes(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var names = params.shapeNames || [];
      if (names.length < 2) return fail('至少需要两个形状');
      var range = slide.ShapesRange(names);
      var group = range.Group();
      return ok({ groupName: group.Name });
    } catch (e) {
      return fail('组合形状失败: ' + (e && e.message ? e.message : e));
    }
  }

  function duplicateShape(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          var dup = slide.Shapes.Item(j).Duplicate();
          return ok({ shapeName: dup.Name });
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('复制形状失败: ' + (e && e.message ? e.message : e));
    }
  }

  function alignShapes(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var names = params.shapeNames || [];
      if (names.length < 2) return fail('至少需要两个形状');
      var range = slide.ShapesRange(names);
      var align = params.align || 'left';
      var map = { left: 0, center: 1, right: 2, top: 3, middle: 4, bottom: 5 };
      range.Align(map[align] || 0, 0);
      return ok({});
    } catch (e) {
      return fail('对齐形状失败: ' + (e && e.message ? e.message : e));
    }
  }

  function distributeShapes(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var names = params.shapeNames || [];
      if (names.length < 2) return fail('至少需要两个形状');
      var range = slide.ShapesRange(names);
      if (params.direction === 'horizontal') range.Distribute(0, 0);
      else range.Distribute(1, 0);
      return ok({});
    } catch (e) {
      return fail('分布形状失败: ' + (e && e.message ? e.message : e));
    }
  }

  function smartDistribute(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var names = params.shapeNames || [];
      if (names.length < 2) return fail('至少需要两个形状');
      var range = slide.ShapesRange(names);
      range.Align(1, 0);
      range.Distribute(0, 0);
      return ok({});
    } catch (e) {
      return fail('智能分布失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideBackground(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      if (params.color !== undefined) {
        slide.FollowMasterBackground = 0;
        var bg = toRgb(params.color);
        if (bg === null) return fail('无效的背景颜色: ' + params.color);
        slide.Background.Fill.ForeColor.RGB = bg;
        slide.Background.Fill.Visible = 1;
      }
      if (params.imagePath || params.path) {
        var img = params.imagePath || params.path;
        slide.FollowMasterBackground = 0;
        slide.Background.Fill.UserPicture(img);
      }
      return ok({});
    } catch (e) {
      return fail('设置幻灯片背景失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideLayout(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      var layouts = { title: 1, title_content: 2, blank: 12, two_column: 3 };
      var lt = layouts[params.layout] || 2;
      slide.Layout = lt;
      return ok({});
    } catch (e) {
      return fail('设置幻灯片布局失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideNumber(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      slide.HeadersFooters.SlideNumber.Visible = 1;
      return ok({});
    } catch (e) {
      return fail('设置幻灯片编号失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideTransition(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      var types = { fade: 1, push: 2, wipe: 3, split: 4, uncover: 5, cover: 6, zoom: 31 };
      var entryEffect = types[params.type];
      if (entryEffect === undefined) return fail('无效的切换类型: ' + params.type + '（支持 fade/push/wipe/split/uncover/cover/zoom）');
      slide.SlideShowTransition.EntryEffect = entryEffect;
      if (params.speed !== undefined) {
        var speedMap = { slow: 3, medium: 2, fast: 1 };
        var speed = speedMap[params.speed];
        if (speed === undefined) return fail('无效的切换速度: ' + params.speed + '（支持 slow/medium/fast）');
        slide.SlideShowTransition.Speed = speed;
      }
      return ok({});
    } catch (e) {
      return fail('设置幻灯片切换效果失败: ' + (e && e.message ? e.message : e));
    }
  }

  function removeSlideTransition(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      pres.Slides.Item(idx).SlideShowTransition.EntryEffect = 0;
      return ok({});
    } catch (e) {
      return fail('移除幻灯片切换效果失败: ' + (e && e.message ? e.message : e));
    }
  }

  function applyTransitionToAll(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var types = { fade: 1, push: 2, wipe: 3, split: 4, uncover: 5, cover: 6, zoom: 31 };
      var transitionType = types[params.type] || 1;
      for (var i = 1; i <= pres.Slides.Count; i++) {
        pres.Slides.Item(i).SlideShowTransition.EntryEffect = transitionType;
      }
      return ok({});
    } catch (e) {
      return fail('应用全局切换效果失败: ' + (e && e.message ? e.message : e));
    }
  }

  function addAnimation(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          var effectTypes = { fade: 0, flyIn: 1, zoomIn: 64, wipe: 15 };
          var etype = effectTypes[params.animationType || 'fade'] || 0;
          slide.TimeLine.MainSequence.AddEffect(slide.Shapes.Item(j), 0, 0, etype);
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('添加动画失败: ' + (e && e.message ? e.message : e));
    }
  }

  function removeAnimation(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      while (slide.TimeLine.MainSequence.Count > 0) {
        slide.TimeLine.MainSequence.Item(1).Delete();
      }
      return ok({});
    } catch (e) {
      return fail('移除动画失败: ' + (e && e.message ? e.message : e));
    }
  }

  function startSlideShow(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      pres.SlideShowSettings.Run();
      return ok({});
    } catch (e) {
      return fail('开始放映失败: ' + (e && e.message ? e.message : e));
    }
  }

  function endSlideShow(params) {
    try {
      var windows = getApplication().SlideShowWindows;
      if (!windows || windows.Count < 1) return ok({ alreadyStopped: true });
      windows.Item(1).View.Exit();
      return ok({});
    } catch (e) {
      return fail('结束放映失败: ' + (e && e.message ? e.message : e));
    }
  }

  function insertPptImage(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var filePath = params.path || params.imagePath;
      if (!filePath) return invalidParam('缺少 path');
      var pic = slide.Shapes.AddPicture(filePath, false, true, params.left || 0, params.top || 0, params.width || -1, params.height || -1);
      return ok({ name: pic.Name });
    } catch (e) {
      return fail('插入图片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function deletePptImage(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          slide.Shapes.Item(j).Delete();
          return ok({});
        }
      }
      return fail('未找到图片形状: ' + shapeName);
    } catch (e) {
      return fail('删除图片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function insertPptTable(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var rows = params.rows || 3;
      var cols = params.cols || 3;
      var table = slide.Shapes.AddTable(rows, cols, params.left || 100, params.top || 100, params.width || 400, params.height || 200);
      if (params.data) {
        for (var r = 0; r < Math.min(params.data.length, rows); r++) {
          var rowData = params.data[r];
          if (rowData && typeof rowData === 'object' && rowData.length !== undefined) {
            for (var c = 0; c < Math.min(rowData.length, cols); c++) {
              table.Table.Cell(r + 1, c + 1).Shape.TextFrame.TextRange.Text = String(rowData[c]);
            }
          } else if (rowData !== null && rowData !== undefined) {
            table.Table.Cell(r + 1, 1).Shape.TextFrame.TextRange.Text = String(rowData);
          }
        }
      }
      return ok({});
    } catch (e) {
      return fail('插入表格失败: ' + (e && e.message ? e.message : e));
    }
  }

  function findPptTable(slide, tableNameOrIndex) {
    if (typeof tableNameOrIndex === 'number') {
      try {
        var n = 0;
        for (var j = 1; j <= slide.Shapes.Count; j++) {
          var s = slide.Shapes.Item(j);
          if (s.HasTable) { n++; if (n === tableNameOrIndex) return s; }
        }
        return null;
      } catch (e) { return null; }
    }
    if (tableNameOrIndex == null) {
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).HasTable) return slide.Shapes.Item(j);
      }
      return null;
    }
    for (var j = 1; j <= slide.Shapes.Count; j++) {
      var s = slide.Shapes.Item(j);
      if (s.Name === tableNameOrIndex && s.HasTable) return s;
    }
    return null;
  }

  function getPptTableCell(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      var table = findPptTable(slide, (params.tableName !== undefined ? params.tableName : (params.tableIndex || 1)));
      if (!table) return fail('未找到表格形状（需为表格且名称/序号匹配）');
      var cell = table.Table.Cell(params.row, params.col);
      return ok({ text: cell.Shape.TextFrame.TextRange.Text });
    } catch (e) {
      return fail('获取表格单元格失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setPptTableCell(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      var table = findPptTable(slide, (params.tableName !== undefined ? params.tableName : (params.tableIndex || 1)));
      if (!table) return fail('未找到表格形状（需为表格且名称/序号匹配）');
      table.Table.Cell(params.row, params.col).Shape.TextFrame.TextRange.Text = params.text || '';
      return ok({});
    } catch (e) {
      return fail('设置表格单元格失败: ' + (e && e.message ? e.message : e));
    }
  }

  function unifyFont(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var fontName = params.fontName || 'Noto Sans CJK SC';
      var maxShapes = params.maxShapes !== undefined ? parseInt(params.maxShapes, 10) : 500;
      if (isNaN(maxShapes) || maxShapes < 1) return fail('无效的 maxShapes: ' + params.maxShapes + '（必须为正整数）');
      var count = 0;
      var truncated = false;
      outer:
      for (var i = 1; i <= pres.Slides.Count; i++) {
        var slide = pres.Slides.Item(i);
        for (var j = 1; j <= slide.Shapes.Count; j++) {
          try {
            var s = slide.Shapes.Item(j);
            if (s.HasTextFrame && s.TextFrame.HasText) {
              s.TextFrame.TextRange.Font.Name = fontName;
              count++;
              if (count >= maxShapes) { truncated = true; break outer; }
            }
          } catch (e) {}
        }
      }
      return ok({ fontName: fontName, count: count, truncated: truncated, maxShapes: maxShapes });
    } catch (e) {
      return fail('统一字体失败: ' + (e && e.message ? e.message : e));
    }
  }

  function beautifySlide(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var scheme = PPT_COLOR_SCHEMES[params.style] || PPT_COLOR_SCHEMES.business;
      var count = 0;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        try {
          var s = slide.Shapes.Item(j);
          if (s.HasTextFrame && s.TextFrame.HasText) {
            var tr = s.TextFrame.TextRange;
            if (tr.Font.Size >= 24) tr.Font.Color.RGB = scheme.title;
            else tr.Font.Color.RGB = scheme.body;
            count++;
          }
        } catch (e) {}
      }
      return ok({ style: params.style || 'business', count: count });
    } catch (e) {
      return fail('美化幻灯片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function autoBeautifySlide(params) {
    return beautifySlideImpl(params);
  }

  function beautifyAllSlides(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var scheme = PPT_COLOR_SCHEMES[params.style] || PPT_COLOR_SCHEMES.business;
      var total = 0;
      for (var i = 1; i <= pres.Slides.Count; i++) {
        var slide = pres.Slides.Item(i);
        for (var j = 1; j <= slide.Shapes.Count; j++) {
          try {
            var s = slide.Shapes.Item(j);
            if (s.HasTextFrame && s.TextFrame.HasText) {
              var tr = s.TextFrame.TextRange;
              if (tr.Font.Size >= 24) tr.Font.Color.RGB = scheme.title;
              else tr.Font.Color.RGB = scheme.body;
              total++;
            }
          } catch (e) {}
        }
      }
      return ok({ style: params.style || 'business', total: total });
    } catch (e) {
      return fail('全局美化失败: ' + (e && e.message ? e.message : e));
    }
  }

  function beautifySlideImpl(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var scheme = PPT_COLOR_SCHEMES[params.style] || PPT_COLOR_SCHEMES.business;
      var count = 0;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        try {
          var s = slide.Shapes.Item(j);
          if (s.HasTextFrame && s.TextFrame.HasText) {
            if (s.TextFrame.TextRange.Font.Size >= 24) s.TextFrame.TextRange.Font.Color.RGB = scheme.title;
            else s.TextFrame.TextRange.Font.Color.RGB = scheme.body;
            count++;
          }
        } catch (e) {}
      }
      return ok({ style: params.style || 'business', count: count });
    } catch (e) {
      return fail('自动美化失败: ' + (e && e.message ? e.message : e));
    }
  }

  function autoLayout(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var totalW = 0, count = 0;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Width > 50) {
          totalW += slide.Shapes.Item(j).Width;
          count++;
        }
      }
      if (count === 0) return ok({ layouted: 0 });
      var spacing = (slide.Shapes.Item(1).Width - totalW) / (count + 1);
      if (spacing < 10) spacing = 10;
      var curX = spacing;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Width > 50) {
          slide.Shapes.Item(j).Left = curX;
          curX += slide.Shapes.Item(j).Width + spacing;
        }
      }
      return ok({});
    } catch (e) {
      return fail('自动布局失败: ' + (e && e.message ? e.message : e));
    }
  }

  function addArrow(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var startX = params.startX || 100;
      var startY = params.startY || 100;
      var endX = params.endX !== undefined ? params.endX : 200;
      var endY = params.endY !== undefined ? params.endY : 100;
      var width = Math.abs(endX - startX) || 100;
      var height = Math.abs(endY - startY) || 20;
      var shape = slide.Shapes.AddShape(33, Math.min(startX, endX), Math.min(startY, endY), width, height);
      return ok({ shapeName: shape.Name });
    } catch (e) {
      return fail('添加箭头失败: ' + (e && e.message ? e.message : e));
    }
  }

  function addConnector(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shape = slide.Shapes.AddConnector(1, params.startX || 100, params.startY || 100, params.endX || 300, params.endY || 100);
      return ok({ shapeName: shape.Name });
    } catch (e) {
      return fail('添加连接线失败: ' + (e && e.message ? e.message : e));
    }
  }

  function addPptHyperlink(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          slide.Shapes.Item(j).ActionSettings.Item(1).Hyperlink.Address = params.url;
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('添加超链接失败: ' + (e && e.message ? e.message : e));
    }
  }

  function removePptHyperlink(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        if (slide.Shapes.Item(j).Name === shapeName) {
          slide.Shapes.Item(j).ActionSettings.Item(1).Hyperlink.Delete();
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('移除超链接失败: ' + (e && e.message ? e.message : e));
    }
  }

  function findPptText(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var query = params.query || params.text;
      if (!query) return invalidParam('缺少 query');
      var results = [];
      for (var i = 1; i <= pres.Slides.Count; i++) {
        var slide = pres.Slides.Item(i);
        for (var j = 1; j <= slide.Shapes.Count; j++) {
          try {
            var s = slide.Shapes.Item(j);
            if (s.HasTextFrame && s.TextFrame.HasText) {
              var t = s.TextFrame.TextRange.Text;
              if (t.indexOf(query) !== -1) {
                results.push({ slideIndex: i, shapeName: s.Name, text: t.substring(0, 100) });
              }
            }
          } catch (e) {}
        }
      }
      return ok({ query: query, results: results, count: results.length });
    } catch (e) {
      return fail('查找失败: ' + (e && e.message ? e.message : e));
    }
  }

  function replacePptText(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var count = 0;
      for (var i = 1; i <= pres.Slides.Count; i++) {
        var slide = pres.Slides.Item(i);
        for (var j = 1; j <= slide.Shapes.Count; j++) {
          try {
            var s = slide.Shapes.Item(j);
            if (s.HasTextFrame && s.TextFrame.HasText) {
              var tr = s.TextFrame.TextRange;
              if (tr.Text.indexOf(params.findText) !== -1) {
                tr.Text = tr.Text.replace(new RegExp(params.findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), params.replaceText || '');
                count++;
              }
            }
          } catch (e) {}
        }
      }
      return ok({ count: count });
    } catch (e) {
      return fail('替换文本失败: ' + (e && e.message ? e.message : e));
    }
  }

  function getSlideNotes(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      var notes = '';
      try {
        var shape = findNotesShape(slide.NotesPage.Shapes);
        if (shape) notes = shape.TextFrame.TextRange.Text || '';
      } catch (e) {}
      return ok({ slideIndex: idx, notes: notes });
    } catch (e) {
      return fail('获取备注失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideNotes(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var slide = pres.Slides.Item(idx);
      var shape = findNotesShape(slide.NotesPage.Shapes);
      if (!shape) return fail('未找到备注占位符，无法写入备注');
      shape.TextFrame.TextRange.Text = params.notes || '';
      return ok({});
    } catch (e) {
      return fail('设置备注失败: ' + (e && e.message ? e.message : e));
    }
  }

  function exportSlideAsImage(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = resolveSlideIndex(pres, params.slideIndex || 1);
      if (idx === null) return fail('无效的幻灯片索引: ' + params.slideIndex + '（合法范围 1~' + pres.Slides.Count + '）');
      var outputPath = params.outputPath || params.path;
      if (!outputPath) return invalidParam('缺少 outputPath');
      var width = params.width !== undefined ? parseInt(params.width, 10) : 1920;
      if (isNaN(width) || width <= 0) return fail('无效的导出宽度: ' + params.width + '（必须为正数）');
      var height = params.height !== undefined ? parseInt(params.height, 10) : 1080;
      if (isNaN(height) || height <= 0) return fail('无效的导出高度: ' + params.height + '（必须为正数）');
      var format = (params.format || 'PNG').toUpperCase();
      var allowed = { PNG: 'PNG', JPG: 'JPG', JPEG: 'JPG', GIF: 'GIF', BMP: 'BMP' };
      var filterName = allowed[format];
      if (!filterName) return fail('无效的导出格式: ' + params.format + '（支持 PNG/JPG/JPEG/GIF/BMP）');
      var slide = pres.Slides.Item(idx);
      slide.Export(outputPath, filterName, width, height);
      return ok({ slideIndex: idx, outputPath: outputPath, format: filterName });
    } catch (e) {
      return fail('导出幻灯片为图片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function applyColorScheme(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var scheme = PPT_COLOR_SCHEMES[params.style] || PPT_COLOR_SCHEMES.business;
      var count = 0;
      for (var i = 1; i <= pres.Slides.Count; i++) {
        var slide = pres.Slides.Item(i);
        for (var j = 1; j <= slide.Shapes.Count; j++) {
          try {
            var s = slide.Shapes.Item(j);
            if (s.HasTextFrame && s.TextFrame.HasText) {
              var tr = s.TextFrame.TextRange;
              if (tr.Font.Size >= 24) tr.Font.Color.RGB = scheme.title;
              else tr.Font.Color.RGB = scheme.body;
              count++;
            }
          } catch (e) {}
        }
      }
      return ok({ style: params.style || 'business', count: count });
    } catch (e) {
      return fail('应用配色方案失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setMasterBackground(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var master = pres.SlideMaster;
      if (params.color !== undefined) {
        var bg = toRgb(params.color);
        if (bg === null) return fail('无效的背景颜色: ' + params.color);
        master.Background.Fill.ForeColor.RGB = bg;
        master.Background.Fill.Visible = 1;
      }
      return ok({});
    } catch (e) {
      return fail('设置母版背景失败: ' + (e && e.message ? e.message : e));
    }
  }

  function getSlideMaster(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var master = pres.SlideMaster;
      return ok({ name: master.Name, width: master.Width, height: master.Height });
    } catch (e) {
      return fail('获取母版信息失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setPptFooter(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var hf = pres.SlideMaster.HeadersFooters;
      hf.Footer.Visible = 1;
      hf.Footer.Text = params.text || '';
      return ok({});
    } catch (e) {
      return fail('设置页脚失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setPptDateTime(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var hf = pres.SlideMaster.HeadersFooters;
      hf.DateAndTime.Visible = 1;
      if (params.format === 'auto') hf.DateAndTime.UseFormat = true;
      else hf.DateAndTime.Text = params.text || '';
      return ok({});
    } catch (e) {
      return fail('设置日期时间失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setImageStyle(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          if (params.width !== undefined) s.Width = params.width;
          if (params.height !== undefined) s.Height = params.height;
          if (params.borderColor) {
            var bc = toRgb(params.borderColor);
            if (bc === null) return fail('无效的边框颜色: ' + params.borderColor);
            s.Line.Visible = 1;
            s.Line.ForeColor.RGB = bc;
          }
          if (params.borderWidth) s.Line.Weight = params.borderWidth;
          return ok({});
        }
      }
      return fail('未找到图片: ' + shapeName);
    } catch (e) {
      return fail('设置图片样式失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setBackgroundColor(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var bg = toRgb(params.color);
      if (bg === null) return fail('无效的背景颜色: ' + params.color + '，支持 #RRGGBB/RRGGBB/数字');
      slide.FollowMasterBackground = 0;
      slide.Background.Fill.ForeColor.RGB = bg;
      slide.Background.Fill.Visible = 1;
      return ok({});
    } catch (e) {
      return fail('设置背景颜色失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setBackgroundImage(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var filePath = params.path || params.imagePath;
      if (!filePath) return invalidParam('缺少 path');
      var slide = pres.Slides.Item(idx);
      slide.FollowMasterBackground = 0;
      slide.Background.Fill.UserPicture(filePath);
      return ok({});
    } catch (e) {
      return fail('设置背景图片失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setBackgroundGradient(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      slide.FollowMasterBackground = 0;
      slide.Background.Fill.OneColorGradient(1, 1, 0.5);
      return ok({});
    } catch (e) {
      return fail('设置渐变背景失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeGradient(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          s.Fill.OneColorGradient(1, 1, 0.5);
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状渐变失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeFullStyle(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          if (params.fillColor) {
            var fc = toRgb(params.fillColor);
            if (fc === null) return fail('无效的填充颜色: ' + params.fillColor);
            s.Fill.ForeColor.RGB = fc;
            s.Fill.Visible = 1;
          }
          if (params.lineColor) {
            var lc = toRgb(params.lineColor);
            if (lc === null) return fail('无效的线条颜色: ' + params.lineColor);
            s.Line.ForeColor.RGB = lc;
            s.Line.Visible = 1;
          }
          if (params.lineWeight) s.Line.Weight = params.lineWeight;
          if (params.shadow) { s.Shadow.Visible = 1; }
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状完整样式失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeRoundness(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var idx = params.slideIndex || 1;
      var slide = pres.Slides.Item(idx);
      var shapeName = params.shapeName || params.name;
      for (var j = 1; j <= slide.Shapes.Count; j++) {
        var s = slide.Shapes.Item(j);
        if (s.Name === shapeName) {
          if (s.Type !== 5 && s.AutoShapeType !== 5) {
            return fail('仅支持对圆角矩形设置圆角，当前形状类型: ' + s.Type);
          }
          try {
            s.Adjustments.Item(1, params.roundness || 0.2);
          } catch (adjE) {
            return fail('设置圆角失败: ' + (adjE && adjE.message ? adjE.message : adjE));
          }
          return ok({});
        }
      }
      return fail('未找到形状: ' + shapeName);
    } catch (e) {
      return fail('设置形状圆角失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setFontColor(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var slideIndex = params.slideIndex || 1;
      var slide = pres.Slides.Item(slideIndex);
      var shape = findShape(slide, (params.shapeIndex !== undefined ? params.shapeIndex : params.shapeName));
      if (!shape) return fail('未找到形状');
      var textRange = shape.TextFrame.TextRange;
      var color = toRgb(params.color);
      if (color === null) return fail('无效的颜色值: ' + params.color + '，支持 #RRGGBB/RRGGBB/数字');
      textRange.Font.Color.RGB = color;
      if (params.size) textRange.Font.Size = params.size;
      if (params.bold !== undefined) textRange.Font.Bold = params.bold;
      return ok({});
    } catch (e) {
      return fail('设置字体颜色失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideSize(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      if (params.width !== undefined) {
        var w = parseInt(params.width, 10);
        if (isNaN(w) || w <= 0) return fail('无效的幻灯片宽度: ' + params.width + '（必须为正数）');
        pres.PageSetup.SlideWidth = w;
      }
      if (params.height !== undefined) {
        var h = parseInt(params.height, 10);
        if (isNaN(h) || h <= 0) return fail('无效的幻灯片高度: ' + params.height + '（必须为正数）');
        pres.PageSetup.SlideHeight = h;
      }
      return ok({});
    } catch (e) {
      return fail('设置幻灯片大小失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setShapeFill(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var slideIndex = params.slideIndex || 1;
      var slide = pres.Slides.Item(slideIndex);
      var shape = findShape(slide, (params.shapeIndex !== undefined ? params.shapeIndex : params.shapeName));
      if (!shape) return fail('未找到形状');
      if (params.fillColor !== undefined) {
        var color = toRgb(params.fillColor);
        if (color === null) return fail('无效的填充颜色: ' + params.fillColor + '，支持 #RRGGBB/RRGGBB/数字');
        shape.Fill.ForeColor.RGB = color;
      }
      if (params.transparency !== undefined) shape.Fill.Transparency = params.transparency;
      if (params.gradient !== undefined) shape.Fill.OneColorGradient(params.gradient.style, params.gradient.variant || 1, params.gradient.degree || 1);
      return ok({});
    } catch (e) {
      return fail('设置形状填充失败: ' + (e && e.message ? e.message : e));
    }
  }

  function setSlideTheme(params) {
    try {
      var pres = getPres();
      if (!pres) return fail('没有打开的演示文稿');
      var theme = params.theme;
      if (typeof pres.ApplyTemplate === 'function') {
        pres.ApplyTemplate(theme);
      } else if (typeof pres.ApplyTheme === 'function') {
        pres.ApplyTheme(theme);
      } else {
        return fail('此 WPS 版本不支持 ApplyTemplate/ApplyTheme');
      }
      return ok({});
    } catch (e) {
      return fail('设置主题失败: ' + (e && e.message ? e.message : e));
    }
  }

  /**
   * 通用方法执行：解析 Application.<path> 属性链（仅供 wps_execute_method 白名单路径）。
   * 白名单与 mcp-server 侧一致：仅允许 Application.ActiveDocument / ActiveWorkbook / ActivePresentation 前缀。
   * 额外防护（addon 侧为实际解析执行点，必须收紧）：
   *   1. 拒绝 .Application / .Parent 回引段——任意 WPS 对象都能经 .Application/.Parent 回到完整
   *      Application 对象，前缀白名单会被 `Application.ActiveDocument.Application.*` 绕过；
   *   2. 拒绝 __proto__ / constructor / prototype 原型链段——防原型污染越权到 JS 内建对象。
   */
  function executeMethod(method, params) {
    try {
      if (!method || typeof method !== 'string') return invalidParam('method 不能为空');
      // 白名单前缀
      var allowPrefixes = ['Application.ActiveDocument', 'Application.ActiveWorkbook', 'Application.ActivePresentation'];
      var allowed = false;
      for (var i = 0; i < allowPrefixes.length; i++) {
        if (method.indexOf(allowPrefixes[i]) === 0) { allowed = true; break; }
      }
      if (!allowed) return fail('method "' + method + '" is not allowed. Only Application.ActiveDocument / ActiveWorkbook / ActivePresentation are permitted.');
      // 黑名单段
      var blockedPrefixes = ['CreateObject', 'Shell', 'Exec', 'Run', 'WScript', 'ScriptControl', 'Eval', 'Execute'];
      var segments = method.split('.');
      for (var bi = 0; bi < blockedPrefixes.length; bi++) {
        for (var bj = 0; bj < segments.length; bj++) {
          if (String(segments[bj]).toLowerCase().indexOf(blockedPrefixes[bi].toLowerCase()) === 0) {
            return fail('method "' + method + '" is blocked for security reasons');
          }
        }
      }
      // 回引/原型链段拒绝（第 0 段固定为 'Application' 入口，从其后的段开始检查）
      var blockedSegments = { 'application': 1, 'parent': 1, '__proto__': 1, 'constructor': 1, 'prototype': 1 };
      for (var sj = 1; sj < segments.length; sj++) {
        if (blockedSegments[String(segments[sj]).toLowerCase()]) {
          return fail('method "' + method + '" contains forbidden segment: ' + segments[sj]);
        }
      }
      // 解析属性链
      var obj = getApplication();
      if (!obj) return fail('属性解析失败: Application 不可用');
      var parts = method.split('.').slice(1); // 去掉开头的 'Application'
      for (var pi = 0; pi < parts.length; pi++) {
        if (obj === null || obj === undefined) return fail('属性解析失败: ' + parts.slice(0, pi).join('.') + ' 为 null');
        obj = obj[parts[pi]];
      }
      return ok({ value: obj, path: method });
    } catch (e) {
      return fail('执行方法失败: ' + (e && e.message ? e.message : e));
    }
  }

  // ══════════════════════════════════════════════
  // 对外接口
  // ══════════════════════════════════════════════
  return {
    // 连接/信息
    isReady: isReady,
    ping: ping,
    wireCheck: wireCheck,
    getAppInfo: getAppInfo,
    getAppType: getAppType,
    getActiveDocumentInfo: getActiveDocumentInfo,
    getDocIdentity: getDocIdentity,

    // 阶段 2 编辑命令（轮询命令分发用）
    getActiveDocument: getActiveDocument,
    getSelectedText: getSelectedTextCmd,
    setSelectedText: setSelectedText,
    insertText: insertText,
    getDocumentText: getDocumentText,
    getDocumentTextByRange: getDocumentTextByRange,
    getDocumentParagraphs: getDocumentParagraphs,
    findReplace: findReplace,
    findInDocument: findInDocument,
    smartFillField: smartFillField,
    replaceBookmarkContent: replaceBookmarkContent,
    setFont: setFont,
    setTextColor: setTextColor,
    setParagraph: setParagraph,
    setLineSpacing: setLineSpacing,
    applyStyle: applyStyle,
    insertTable: insertTable,
    insertPageBreak: insertPageBreak,
    insertImage: insertImage,
    addComment: addComment,
    insertBookmark: insertBookmark,
    insertHeader: insertHeader,
    insertFooter: insertFooter,
    generateTOC: generateTOC,
    insertSectionBreak: insertSectionBreak,
    setPageSetup: setPageSetup,

    // 文档管理
    getOpenDocuments: getOpenDocuments,
    switchDocument: switchDocument,
    openDocument: openDocument,
    createDocument: createDocument,

    // 通用文件
    save: save,
    saveAs: saveAs,
    openFile: openFile,

    // 表格/演示
    getActiveWorkbook: getActiveWorkbook,
    getCellValue: getCellValue,
    setCellValue: setCellValue,
    getActivePresentation: getActivePresentation,

    // 通用方法（wps_execute_method 白名单路径）
    executeMethod: executeMethod,

    // PPT（演示文稿）方法 —— 参见 poll.js POLL_ACTION_MAP PPT 段
    createPresentation: createPresentation,
    getOpenPresentations: getOpenPresentations,
    switchPresentation: switchPresentation,
    openPresentation: openPresentation,
    closePresentation: closePresentation,
    addSlide: addSlide,
    deleteSlide: deleteSlide,
    duplicateSlide: duplicateSlide,
    moveSlide: moveSlide,
    getSlideCount: getSlideCount,
    getSlideInfo: getSlideInfo,
    switchSlide: switchSlide,
    getSlideTitle: getSlideTitle,
    setSlideTitle: setSlideTitle,
    setSlideSubtitle: setSlideSubtitle,
    setSlideContent: setSlideContent,
    addTextBox: addTextBox,
    deleteTextBox: deleteTextBox,
    getTextBoxes: getTextBoxes,
    setTextBoxText: setTextBoxText,
    setTextBoxStyle: setTextBoxStyle,
    addShape: addShape,
    deleteShape: deleteShape,
    getShapes: getShapes,
    setShapeText: setShapeText,
    setShapePosition: setShapePosition,
    setShapeStyle: setShapeStyle,
    setShapeBorder: setShapeBorder,
    setShapeShadow: setShapeShadow,
    setShapeTransparency: setShapeTransparency,
    setShapeZOrder: setShapeZOrder,
    groupShapes: groupShapes,
    duplicateShape: duplicateShape,
    alignShapes: alignShapes,
    distributeShapes: distributeShapes,
    smartDistribute: smartDistribute,
    setSlideBackground: setSlideBackground,
    setSlideLayout: setSlideLayout,
    setSlideNumber: setSlideNumber,
    setSlideTransition: setSlideTransition,
    removeSlideTransition: removeSlideTransition,
    applyTransitionToAll: applyTransitionToAll,
    addAnimation: addAnimation,
    removeAnimation: removeAnimation,
    startSlideShow: startSlideShow,
    endSlideShow: endSlideShow,
    insertPptImage: insertPptImage,
    deletePptImage: deletePptImage,
    insertPptTable: insertPptTable,
    getPptTableCell: getPptTableCell,
    setPptTableCell: setPptTableCell,
    unifyFont: unifyFont,
    beautifySlide: beautifySlide,
    autoBeautifySlide: autoBeautifySlide,
    beautifyAllSlides: beautifyAllSlides,
    autoLayout: autoLayout,
    addArrow: addArrow,
    addConnector: addConnector,
    addPptHyperlink: addPptHyperlink,
    removePptHyperlink: removePptHyperlink,
    findPptText: findPptText,
    replacePptText: replacePptText,
    getSlideNotes: getSlideNotes,
    setSlideNotes: setSlideNotes,
    exportSlideAsImage: exportSlideAsImage,
    applyColorScheme: applyColorScheme,
    setMasterBackground: setMasterBackground,
    getSlideMaster: getSlideMaster,
    setPptFooter: setPptFooter,
    setPptDateTime: setPptDateTime,
    setImageStyle: setImageStyle,
    setBackgroundColor: setBackgroundColor,
    setBackgroundImage: setBackgroundImage,
    setBackgroundGradient: setBackgroundGradient,
    setShapeGradient: setShapeGradient,
    setShapeFullStyle: setShapeFullStyle,
    setShapeRoundness: setShapeRoundness,
    setFontColor: setFontColor,
    setSlideSize: setSlideSize,
    setShapeFill: setShapeFill,
    setSlideTheme: setSlideTheme
  };
})();
