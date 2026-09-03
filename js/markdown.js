/**
 * markdown.js — 轻量 Markdown 渲染器（零依赖，转义安全）
 *
 * 模块边界（ARCHITECTURE §4.2）：纯文本 → HTML 字符串，不碰 DOM、不碰协议、不碰文档。
 * 阶段 3 批 2（docs/DEV-PLAN-Phase3.md §1 P10）：AI 回复 Markdown 渲染升级。
 *
 * 安全设计（P10 验收「HTML 不注入」）：
 *   - 先对整个源文本做 HTML 转义（& < > " '），再在其上叠加结构标签；
 *     因此源文本里的 `<script>`、`<img onerror=...>` 等一律是惰性文本，不会执行/注入。
 *   - 链接 href 只放行 http/https/mailto，其余（javascript: 等）降级为纯文本。
 *
 * 渲染子集（覆盖 AI 回复 90% 场景）：
 *   - 标题 # ~ ######
 *   - 加粗 **x** / 斜体 *x* 与 _x_（下划线斜体要求词边界，避免 foo_bar 误伤）
 *   - 行内代码 `x`
 *   - 围栏代码块 ```lang ... ```
 *   - 无序列表 - / * 、有序列表 1.
 *   - 引用 > 行
 *   - 表格 | a | b |  + 分隔行 |---|
 *   - 链接 [文本](url)
 *   - 分隔线 ---
 *   - 段落（连续非空行合并为 <p>）
 *
 * 对外接口：
 *   - MarkdownRenderer.render(text) -> HTML 字符串
 *   - MarkdownRenderer.hasBlock(text) -> boolean（是否含块级结构，供行内样式判断）
 */
var MarkdownRenderer = (function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeUrl(url) {
    var u = String(url || '').trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    return '';
  }

  function inline(text) {
    if (!text) return '';
    // 行内代码先用占位符保护，内部不再被加粗/斜体/链接误处理
    var codeSpans = [];
    text = text.replace(/`([^`]+)`/g, function (m, code) {
      var idx = codeSpans.length;
      codeSpans.push('<code>' + code + '</code>');
      return '\u0000C' + idx + '\u0000';
    });
    // 顺序敏感：链接 → 加粗 → 斜体
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var safe = sanitizeUrl(url);
      return safe ? '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[\s>])_([^_\n]+)_([\s<.,!?]|$)/g, '$1<em>$2</em>$3');
    text = text.replace(/(^|[\s>])\*([^*\n]+)\*([\s<.,!?]|$)/g, '$1<em>$2</em>$3');
    // 还原代码占位符
    text = text.replace(/\u0000C(\d+)\u0000/g, function (m, idx) {
      return codeSpans[parseInt(idx, 10)] || '';
    });
    return text;
  }

  // 表格行 -> 单元格数组（按未转义的 | 分割，跳过首尾空）
  function splitRow(line) {
    var parts = [];
    var cur = '';
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '|') {
        parts.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    parts.push(cur);
    // 去掉首尾空单元格（表格常以 | 开头结尾）
    if (parts.length > 0 && parts[0].trim() === '') parts.shift();
    if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
    return parts;
  }

  function isTableSep(line) {
    var trimmed = line.trim();
    if (trimmed.charAt(0) !== '|') return false;
    var cells = splitRow(trimmed);
    if (cells.length < 2) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!/^:?-{3,}:?$/.test(cells[i].trim())) return false;
    }
    return true;
  }

  function renderTable(rows) {
    var html = '<div class="md-table-wrap"><table>';
    for (var r = 0; r < rows.length; r++) {
      var cells = splitRow(rows[r]);
      html += '<tr>';
      for (var c = 0; c < cells.length; c++) {
        var tag = (r === 0) ? 'th' : 'td';
        html += '<' + tag + '>' + inline(cells[c].trim()) + '</' + tag + '>';
      }
      html += '</tr>';
    }
    return html + '</table></div>';
  }

  var isSpecial = (function () {
    var reList = /^(\s*[-*]\s|\s*\d+\.\s)/;
    var reHead = /^#{1,6}\s/;
    var reQuote = /^&gt;\s?/;
    var reFence = /^```/;
    var reHr = /^\s*-{3,}\s*$/;
    return function (line) {
      return reList.test(line) || reHead.test(line) || reQuote.test(line) ||
             reFence.test(line) || reHr.test(line) || line.indexOf('|') !== -1;
    };
  })();

  function render(text) {
    if (!text) return '';
    var src = escapeHtml(text);
    var lines = src.split('\n');
    var out = [];
    var i = 0;
    var n = lines.length;

    while (i < n) {
      var line = lines[i];

      // 围栏代码块
      if (/^```/.test(line)) {
        var langMatch = /^```(\S*)\s*$/.exec(line);
        var lang = langMatch ? langMatch[1] : '';
        var buf = [];
        i++;
        while (i < n && !/^```/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 跳过结束围栏
        out.push('<pre class="code"><code' + (lang ? ' data-lang="' + lang + '"' : '') + '>' +
                 buf.join('\n') + '</code></pre>');
        continue;
      }

      // 表格块：当前行含 | 且下一行是分隔行
      if (line.indexOf('|') !== -1 && i + 1 < n && isTableSep(lines[i + 1])) {
        var tbl = [line];
        i += 2; // 跳过表头与分隔行
        while (i < n && lines[i].indexOf('|') !== -1 && lines[i].trim() !== '') {
          tbl.push(lines[i]);
          i++;
        }
        out.push(renderTable(tbl));
        continue;
      }

      // 引用块
      if (/^&gt;\s?/.test(line)) {
        var quote = [];
        while (i < n && /^&gt;\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^&gt;\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>');
        continue;
      }

      // 列表
      var ulMatch = /^(\s*)[-*]\s+(.*)$/.exec(line);
      var olMatch = /^(\s*)\d+\.\s+(.*)$/.exec(line);
      if (ulMatch || olMatch) {
        var isOl = !!olMatch;
        var items = [];
        while (i < n) {
          var mU = /^(\s*)[-*]\s+(.*)$/.exec(lines[i]);
          var mO = /^(\s*)\d+\.\s+(.*)$/.exec(lines[i]);
          if (isOl && mO) { items.push(mO[2]); i++; }
          else if (!isOl && mU) { items.push(mU[2]); i++; }
          else if (lines[i].trim() === '') { i++; break; }
          else break;
        }
        var tag = isOl ? 'ol' : 'ul';
        var inner = '';
        for (var k = 0; k < items.length; k++) inner += '<li>' + inline(items[k]) + '</li>';
        out.push('<' + tag + '>' + inner + '</' + tag + '>');
        continue;
      }

      // 标题
      var head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        var lvl = head[1].length;
        out.push('<h' + lvl + '>' + inline(head[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*-{3,}\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }

      // 段落：收集连续非空、非特殊行
      if (line.trim() !== '') {
        var para = [];
        while (i < n && lines[i].trim() !== '' && !isSpecial(lines[i])) {
          para.push(lines[i].trim());
          i++;
        }
        // 兜底：当前行非空但被 isSpecial 误判（如含 | 却不是表格）→ 至少消费当前行，防死循环
        if (para.length === 0) {
          para.push(line.trim());
          i++;
        }
        out.push('<p>' + inline(para.join(' ')) + '</p>');
        continue;
      }

      i++; // 空行跳过
    }

    return out.join('\n');
  }

  function hasBlock(text) {
    if (!text) return false;
    return /```|\n\s*[-*]\s|\n\s*\d+\.\s|^#{1,6}\s|\|.*\|\s*\n\s*\|?\s*:?-{3,}/m.test(text);
  }

  return {
    render: render,
    hasBlock: hasBlock,
    _escapeHtml: escapeHtml
  };
})();
