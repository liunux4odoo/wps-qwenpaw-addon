/**
 * main.js — 入口胶水层（唯一耦合点，最末加载）
 *
 * 模块边界（ARCHITECTURE §4.2）：知道所有其他模块，其他模块互不依赖。
 * 本文件仅保留：initTaskpane（回调接线）、对外接口（init/sendUserMessage/closeSession）、
 * DOMContentLoaded 触发与 window.QwenPawAddon 暴露。业务逻辑已按域拆出：
 *
 *   app-state.js    全局状态容器（QP）+ 常量 + QPLog + localStorage 持久化
 *   doc-state.js    P8 文档隔离 / P15 历史缓存 / P16 环境上下文
 *   bridge-config.js bridge /config 拉取 + 路线 P poll 端口分配
 *   session.js      ACP 会话生命周期 + 会话建立看门狗
 *   agents.js       P3 agent / Phase 3 server 选择与设置面板
 *   acp-events.js   ACP 响应 / 流式 / 服务端请求处理
 *   watchdog.js     P2 中断恢复看门狗
 *   actions.js      用户动作（发送/停止/清空/重试/重建/附件）与 UI 状态
 *   poll.js         角色 B 轮询命令分发
 *   ribbon.js       ribbon 上下文（taskpane 创建/切换）
 *
 * 双上下文运行：
 *   - ribbon 上下文（index.html 加载）：注册 OnAddinLoad / OnShowTaskPane / OnStatusClick（ribbon.js）
 *   - taskpane 页面上下文（taskpane.html 加载）：初始化聊天 UI + ACP 客户端 + 轮询客户端
 *
 * IIFE 包裹：`var S = QP.state` 仅本文件闭包内可见；仅通过 window.QwenPawAddon 暴露
 * init/sendUserMessage/closeSession 三个对外接口（ARCHITECTURE §4.3）。
 */
(function () {
  'use strict';
  var S = QP.state;

  // ══════════════════════════════════════════════
  // taskpane 上下文：聊天 + ACP + 轮询
  // ══════════════════════════════════════════════
  function initTaskpane() {
    QPLog('main', 'initTaskpane: 初始化聊天 UI + ACP + 轮询客户端');
    // 1. 聊天 UI
    ChatUi.init({
      onSend: onUserSend,
      onStop: onStop,
      onRetry: onRetry,
      onRebuild: onRebuild,
      onClearCommand: clearCurrentSession
    });
    // P3：agent 下拉切换（localStorage 记住）；P14：清空对话按钮
    var agentSelect = document.getElementById('agentSelect');
    if (agentSelect) {
      agentSelect.addEventListener('change', function () {
        if (agentSelect.value && agentSelect.value !== S.agentCached) {
          switchAgent(agentSelect.value);
        }
      });
    }
    bindClearButton();
    bindAttachButton(); // P6：附件上传
    bindSettingsUI();   // Phase 3：设置按钮 + server/model/effort 下拉绑定
    tryAutoExpand();    // P7：自动展开侧边栏（尽力而为）
    // P1：初始状态（启动握手：ACP 连接中 + WPS 未激活）
    updateStatus();
    // P21：初始会话未建 → 发送按钮禁用（ACP 连接 + 会话建立后自动启用）
    updateSendAvailability();

    // P8/P15：确定当前文档 id，恢复该文档的历史消息（前端缓存）
    S.currentDocId = getDocId();
    var cachedMsgs = QP.loadHistory(S.currentDocId);
    if (cachedMsgs && cachedMsgs.length) {
      ChatUi.restore(cachedMsgs);
      QPLog('P15', '恢复文档 ' + S.currentDocId + ' 历史 ' + cachedMsgs.length + ' 条');
    } else {
      ChatUi.showEmptyHint();
    }
    startDocCheck();

    // 2. 从 bridge 拉取确定性配置（wps-mcp 入口），完成后再分配 poll 端口 + 连接 ACP，
    //    保证 ensureSession 用到的 MCP_SERVERS 路径已就绪
    loadBridgeConfig(function () {
      // 3. 路线 P：异步分配 poll 端口（与 ACP 连接并行）。bridge 是唯一分配者且幂等：
      //    即使 session/new 先于分配完成发出，bridge 也会按该 client 幂等分配同一端口，无竞态。
      allocatePollPort(function (alloc) {
        WpsPollClient.init({
          serverUrl: 'http://127.0.0.1:' + alloc.port,
          handler: onPollCommand,
          onStatus: onPollStatus
        });
        WpsPollClient.start();
        QPLog('main', 'initTaskpane: WpsPollClient.start() 已调用 (poll=' + alloc.port + ')');
      });

      // P3：加载可用 agent 列表（从 bridge /agents），初始化下拉选择
      loadAgentList();

      // Phase 3：加载可用 ACP server 列表（/servers）并填充设置面板下拉；
      // 记住的上次选择与 bridge 当前不一致时自动切换（A7 配置持久化）
      loadServerList();

      // 4. ACP 客户端：连接 + 会话管理
      AcpClient.onConnectionChange(onAcpConnChange);
      AcpClient.onResponse(onAcpResponse);
      AcpClient.onSessionUpdate(onAcpSessionUpdate);
      AcpClient.onRequest(onAcpRequest);
      AcpClient.connect();
      QPLog('main', 'initTaskpane: AcpClient.connect() 已调用');
    });
  }

  // ══════════════════════════════════════════════
  // 对外接口（ARCHITECTURE §4.3）
  // ══════════════════════════════════════════════
  function init() {
    if (S.isTaskpane) {
      initTaskpane();
    }
  }

  function sendUserMessage(text) {
    onUserSend(text);
  }

  function closeSession() {
    if (S.acpSessionId) {
      AcpClient.send('session/close', { sessionId: S.acpSessionId });
    }
    WpsPollClient.stop();
    AcpClient.disconnect();
    releasePollPort();
  }

  // taskpane 页面 DOM 就绪后初始化；ribbon 环境则只注册回调
  if (S.isTaskpane) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // 暴露到全局供 WPS / 调试使用
  window.QwenPawAddon = {
    init: init,
    sendUserMessage: sendUserMessage,
    closeSession: closeSession
  };
})();
