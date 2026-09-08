/**
 * ribbon.js — ribbon 上下文：taskpane 创建/切换（从 main.js 拆出）
 *
 * 模块边界（ARCHITECTURE §4.2）：ribbon 回调（OnAddinLoad / OnShowTaskPane /
 * OnStatusClick）与 CreateTaskPane 生命周期。仅注册全局回调，不 init 业务。
 * 依赖：QP（app-state.js，QPLog 与 ribbonUI 状态）。IIFE 包裹：WPS_Enum/
 * TASKPANE_DOCK_POSITION/taskpaneIdCache 及全部辅助函数为模块私有（不落全局）；
 * 仅向 window 暴露 WPS 要求的三个回调（OnAddinLoad/OnShowTaskPane/OnStatusClick）。
 */
(function () {
  'use strict';

  var WPS_Enum = { msoCTPDockPositionRight: 2 };
  var TASKPANE_DOCK_POSITION = WPS_Enum.msoCTPDockPositionRight;
  // ribbon 上下文私有状态（仅 ribbon 回调使用）
  var taskpaneIdCache = '';

  function GetUrlPath() {
    // 实测确认：WPS CreateTaskPane 用相对路径即可
    // 相对路径相对于插件目录（manifest.xml 所在目录）
    // 注意：不能加前导 '/'，否则会被解析为根目录
    return '';
  }

  function getTaskPaneUrl() {
    // v0.8 定论：WPS Linux CreateTaskPane 加载本地文件路径空白，必须 HTTP URL。
    // 由 acp-bridge :8766 静态文件服务托管（/ui/*），与 ACP 轮询同源，无 CORS 问题。
    return 'http://127.0.0.1:8766/ui/taskpane.html';
  }

  function errMsg(e) {
    return (e && e.message ? e.message : e);
  }

  function setTaskPaneDockPosition(tp) {
    if (!tp) return false;
    try {
      tp.DockPosition = TASKPANE_DOCK_POSITION;
      return true;
    } catch (e) {
      console.error('[main] 设置任务窗格停靠位置失败: ' + errMsg(e));
      return false;
    }
  }

  function createTaskPane() {
    QPLog('main', 'createTaskPane: 尝试创建任务窗格 url=' + getTaskPaneUrl());
    try {
      var tp = window.Application.CreateTaskPane(getTaskPaneUrl());
      if (!tp) {
        QPLog('main', 'createTaskPane: CreateTaskPane 返回空对象');
        console.error('[main] 创建任务窗格失败: CreateTaskPane 返回空对象');
        return null;
      }
      if (tp.ID) {
        taskpaneIdCache = tp.ID;
        QPLog('main', 'createTaskPane: 创建成功 ID=' + tp.ID);
        try {
          window.Application.PluginStorage.setItem('taskpane_id', tp.ID);
        } catch (e) {
          console.error('[main] 保存 taskpane_id 失败: ' + errMsg(e));
        }
      }
      if (!setTaskPaneDockPosition(tp)) {
        console.error('[main] 任务窗格停靠校正失败（窗格仍可用）');
      }
      try {
        tp.Visible = true;
      } catch (e) {
        console.error('[main] 设置任务窗格可见失败: ' + errMsg(e));
      }
      return tp;
    } catch (e) {
      QPLog('main', 'createTaskPane 异常: ' + errMsg(e));
      console.error('[main] 初始化任务窗格失败: ' + errMsg(e));
      return null;
    }
  }

  // 自动打开侧边栏（用户需求：点击进入插件时自动打开侧边栏）。
  // v0.11 教训：WPS 启动瞬间（无文档/CEF 未就绪）CreateTaskPane 会得到空白窗格并被缓存。
  // 因此仅在"活动文档就绪"后才创建；无文档时延迟重试（有限次数），文档出现后自动打开一次。
  // autoOpenDone 仅在 createTaskPane 成功后置位（失败可重试），并防止与手动打开重复。
  var autoOpenDone = false;
  var AUTO_OPEN_MAX_RETRIES = 60; // 60s 上限：无文档且用户不操作时停止自旋

  function docReady() {
    try {
      var app = (typeof window !== 'undefined' && window.WPS && window.WPS.Application)
        || (typeof window !== 'undefined' && window.Application)
        || (typeof Application !== 'undefined' ? Application : null);
      if (!app) return false;
      return !!(app.ActiveDocument || app.ActiveWorkbook || app.ActivePresentation);
    } catch (e) {
      return false;
    }
  }

  function autoOpenSidebarWhenReady(attempt) {
    if (autoOpenDone) return;
    if (docReady()) {
      autoOpenDone = true; // 置位防并发重入；失败则下方恢复以便重试
      var okPane = false;
      try {
        // 同步创建窗格：成功（返回非空且已可见）才视为完成；失败恢复 autoOpenDone 以便后续重试
        var tp = createTaskPane();
        okPane = !!(tp && tp.ID);
      } catch (e) {
        okPane = false;
      }
      if (!okPane) {
        autoOpenDone = false;
        QPLog('main', '自动打开侧边栏失败，稍后重试');
        scheduleAutoOpen(attempt + 1);
        return;
      }
      QPLog('main', '自动打开侧边栏（进入插件时）');
      return;
    }
    scheduleAutoOpen(attempt + 1);
  }

  function scheduleAutoOpen(attempt) {
    if (autoOpenDone || (attempt || 0) >= AUTO_OPEN_MAX_RETRIES) return;
    setTimeout(function () { autoOpenSidebarWhenReady(attempt); }, 1000);
  }

  // ribbon onLoad 回调
  window.OnAddinLoad = function (ui) {
    QP.state.ribbonUI = ui;
    QPLog('main', '加载项已加载 (ribbon)');
    console.log('[main] WPS QwenPaw AI 加载项已加载 (ribbon)');
    // 自动打开侧边栏：仅在文档就绪后执行（避免 v0.11 启动空白窗格被缓存的问题）；
    // 无文档时轮询等待（有限次数），用户新建/打开文档后自动打开一次。
    autoOpenSidebarWhenReady(0);
    return true;
  };

  // 按钮：打开/切换侧边栏
  // 总是新建正确的对话窗格（不复用可能为空白/失效的旧窗格）；先隐藏旧窗格避免堆积。
  window.OnShowTaskPane = function () {
    autoOpenDone = true; // 用户手动打开后不再自动打开（防重复建窗格）
    if (taskpaneIdCache) {
      try {
        var old = window.Application.GetTaskPane(taskpaneIdCache);
        if (old) { old.Visible = false; }
      } catch (e) {}
    }
    createTaskPane();
    if (QP.state.ribbonUI) {
      try { QP.state.ribbonUI.Invalidate(); } catch (e) {}
    }
    return true;
  };

  // 按钮：状态（只读诊断，不创建/切换窗格；打开侧边栏请用"AI 侧边栏"按钮）
  window.OnStatusClick = function () {
    var info = '=== QwenPaw AI 状态 ===\n\n';
    info += '侧边栏 URL: ' + getTaskPaneUrl() + '\n';
    info += '侧边栏 ID 缓存: ' + (taskpaneIdCache || '(无)') + '\n';
    info += '任务窗格上下文: ' + (QP.state.isTaskpane ? '是' : '否') + '\n';
    try {
      var existing = null;
      if (taskpaneIdCache) {
        existing = window.Application.GetTaskPane(taskpaneIdCache);
      }
      info += 'GetTaskPane(缓存): ' + (existing ? '存在' : '不存在/无效') + '\n';
    } catch (e) {
      info += 'GetTaskPane 异常: ' + errMsg(e) + '\n';
    }
    info += 'ActiveDocument: ' + (window.Application && window.Application.ActiveDocument ? '存在' : '不存在') + '\n\n';
    info += '提示：点击 ribbon 的「AI 侧边栏」按钮打开对话侧边栏。';
    alert(info);
    return true;
  };
})();
