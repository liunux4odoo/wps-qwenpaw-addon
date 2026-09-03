# 项目结构

```
wps-qwenpaw-addon/
├── README.md                ← 使用者入口（是什么/怎么装/怎么用）
├── AGENTS.md                ← code agent 最小指引（开发规则 + docs 引用）
├── manifest.xml             ← WPS 加载项清单
├── ribbon.xml               ← WPS 功能区（QwenPaw AI 标签）
├── index.html               ← WPS Linux 加载项入口页
├── taskpane.html            ← 侧边栏 UI 骨架
├── bridge/                  ← ACP 桥接服务
│   ├── acp-bridge.py        ← HTTP/WebSocket ↔ stdio 双向转发桥（HTTP :8766 + WS :8765）
│   ├── test_bridge.py       ← Python 自动化端到端验证脚本（WebSocket）
│   └── test-page.html       ← 浏览器手动测试页
├── js/                      ← 加载项 JS 模块
│   ├── acp-client.js        ← ACP 协议客户端（HTTP 轮询 transport）
│   ├── wps-bridge.js        ← WPS JS API 轻量封装
│   ├── chat-ui.js           ← 聊天界面渲染
│   ├── wps-poll-client.js   ← wps-office-mcp 轮询执行端
│   └── main.js              ← 入口胶水层（唯一耦合点）
├── css/
│   └── taskpane.css         ← 样式
├── scripts/
│   ├── install.sh           ← 一键安装/配置脚本（见 docs/INSTALL.md）
│   ├── wps-auto-noop.sh     ← wps-mcp 应用切换 noop 脚本（部署到 opencode-wps-linux/wps-auto.sh）
│   └── start-wps-mcp-http.sh← （已废弃 v0.16 http 化，留档勿用）
├── third_party/
│   └── opencode-wps/        ← git submodule（固定提交 6b8b33c），内含 wps-office-mcp
│       └── wps-office-mcp/  ← WPS 操作的 MCP Server（v1.5.2）
└── docs/
    ├── README.md            ← 文档中心索引
    ├── ARCHITECTURE.md      ← 完整架构方案（v0.22）
    ├── INSTALL.md           ← 安装部署全流程
    ├── DEPENDENCIES.md      ← 依赖版本注记
    ├── PROJECT-STRUCTURE.md ← 本文件
    ├── DEVELOPMENT.md       ← 开发维护规则
    ├── PROGRESS.md          ← 开发阶段与当前状态
    └── DEV-PLAN-Phase3.md   ← 阶段 3 打磨计划
```

## 模块边界速览

- **`js/main.js`**：入口胶水层，知道所有其他模块；其他模块互不依赖（架构约束 §4.2）
- **`bridge/acp-bridge.py`**：纯传输层转发（HTTP/WS ↔ stdio），不实现任何 ACP 业务逻辑
- **`js/wps-bridge.js`**：WPS JS API 封装，所有文档操作经此（角色 B 执行代理）
- **`js/acp-client.js`**：与 bridge 的 HTTP 轮询客户端（角色 A 聊天通道）
- **`js/wps-poll-client.js`**：与 wps-office-mcp 轮询端口的执行端（角色 B 通道）
