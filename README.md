# WPS-QwenPaw AI 助手

在 WPS 里用自然语言让 AI 帮你编辑 Word / Excel / PPT 文档，体验类似 Cursor。

直接在 WPS 侧边栏对话，AI（QwenPaw）会调用 WPS 的 MCP 工具完成文档读写、查找替换、排版、插图、批注等操作。

## 特性

- 🗨️ **侧边栏对话** — 在 WPS 里打开「QwenPaw AI」侧边栏，用自然语言下达指令
- 📝 **文档编辑** — AI 经 wps-office-mcp 直接读写文档（插入文本、查找替换、设置字体/段落、插入表格/图片、批注/书签/页眉页脚/TOC 等 40+ 命令）
- 🎯 **支持三端** — Word / Excel / PPT（manifest 声明 wps/et/wpp）
- 🔌 **跨进程架构** — acp-bridge 桥接 WPS 加载项与 ACP server（默认 QwenPaw），wps-office-mcp 作为 MCP 工具执行文档操作

## AI 后端（ACP Server）

- **主目标：QwenPaw** — 默认后端，完整体验（工具自动批准、中止、历史恢复、agent 切换）。安装时 `bridge` 以 `--acp-server qwenpaw` 启动（默认值）。
- **替代：opencode** — 面向**无法安装或不愿安装 QwenPaw** 的用户，已能**完整体验本项目功能**（对话、WPS 工具调用、多窗口隔离、历史恢复）。在侧边栏设置面板（⚙）或 `--acp-server opencode` 选择。
- **其它 code agent（claudecode / kimicode / qcoder 等）**：**暂不支持**。ACP server 兼容到此为止，等有需要再扩展（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §6.3）。

## 快速开始

```bash
# 1. 克隆（含 submodule）
git clone --recurse-submodules <repo-url>
cd wps-qwenpaw-addon

# 2. 一键安装（环境自检 + 构建 + 部署 + 启动）
./scripts/install.sh
```

> 环境要求：Linux、WPS Office（Linux 版）、Node.js ≥ 18、Python 3.12。完整步骤见 **[docs/INSTALL.md](docs/INSTALL.md)**。
> AI 后端二选一：**QwenPaw v2.1.0**（主目标，默认）或 **opencode ≥ 1.18**（替代，详见 [docs/INSTALL.md](docs/INSTALL.md) §AI 后端选择）。

安装完成后：

1. 启动 WPS 并打开一个文档
2. 功能区点击 **QwenPaw AI** → **AI 侧边栏**
3. 输入指令，如：「把第三段润色一下」

## 文档

| 文档 | 说明 |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | 安装部署全流程（含一键脚本说明） |
| [docs/README.md](docs/README.md) | 文档中心索引 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 完整架构方案（开发者） |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 开发阶段与当前状态 |

## 架构速览

```
WPS 加载项 (taskpane)
   │   HTTP 短轮询 :8766（ACP 聊天通道）
   ▼
acp-bridge ──▶ ACP server（qwenpaw acp 默认 / opencode acp 替代，stdio）
   │   MCP stdio（每会话一个 wps-mcp 子进程，WPS_POLL_PORT 59000+）
   ▼
wps-office-mcp ──反向轮询──▶ WPS 加载项（角色 B，执行代理）
```

- **acp-bridge**：传输层桥（HTTP/WS ↔ stdio），连接 WPS 与 ACP server（默认 QwenPaw）
- **ACP server**：智能体后端（记忆、技能、工具调用循环）——**qwenpaw 为主目标**，**opencode 为替代**（用户无法/不愿安装 QwenPaw 时）
- **wps-office-mcp**：WPS 操作 MCP Server（v1.5.2，14 直连工具 + 250+ Gateway 工具），作为 submodule 固定在 `third_party/opencode-wps/`

## 相关项目与版本

| 项目 | 版本/提交 | 说明 |
|---|---|---|
| [opencode-wps](https://github.com/lnxsun/opencode-wps) | `6b8b33c`（submodule） | 内含 wps-office-mcp |
| wps-office-mcp | v1.5.2 | WPS 操作 MCP Server |
| QwenPaw | v2.1.0 | 智能体后端（主目标，默认） |
| opencode | ≥ 1.18 | 替代后端（无法/不愿装 QwenPaw 时，能力表见 [docs/acp-servers/opencode.md](docs/acp-servers/opencode.md)） |

详细依赖与补丁说明见 [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)。

## License

MIT
