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
    executeMethod: executeMethod
  };
})();
