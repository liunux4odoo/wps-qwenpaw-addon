# 文档中心

| 文档 | 读者 | 说明 |
|---|---|---|
| [INSTALL.md](./INSTALL.md) | 使用者 | 安装部署全流程（环境、AI 后端二选一、opencode-wps、bridge、插件 + 一键脚本） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 开发者 | 完整架构方案 v0.25 — 目标、架构、约束、验收、阶段划分、决策历史 |
| [PROJECT-STRUCTURE.md](./PROJECT-STRUCTURE.md) | 开发者 | 项目结构与模块边界 |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | 开发者/code agent | 开发维护规则、硬约束、submodule 管理、验证命令 |
| [DEPENDENCIES.md](./DEPENDENCIES.md) | 开发者 | 依赖版本注记（opencode-wps 提交、wps-office-mcp v1.5.2、qwenpaw 2.1.0） |
| [PROGRESS.md](./PROGRESS.md) | 开发者 | 开发阶段与当前状态 |
| [DEV-PLAN-Phase3.md](./DEV-PLAN-Phase3.md) | 开发者 | 阶段 3 体验打磨计划（P1-P15） |
| [acp-servers/opencode.md](./acp-servers/opencode.md) | 开发者 | opencode ACP 能力表（唯一计划内替代后端，Phase 0 实测输出） |

> **ACP server 支持范围（2026-09-07 决策）**：**qwenpaw 为主目标，opencode 为替代**（用户无法/不愿安装 QwenPaw 时可完整体验本项目功能）；claudecode / kimicode / qcoder 等其它 code agent **暂不支持**，兼容到此为止，等有需要再扩展（见 [ARCHITECTURE.md](./ARCHITECTURE.md) §6.3）。

## 阅读顺序建议

- **普通使用者**：`README.md` → `docs/INSTALL.md`
- **新加入的开发者**：`README.md` → `docs/ARCHITECTURE.md` → `docs/DEVELOPMENT.md` → `docs/PROGRESS.md`
- **code agent**：`AGENTS.md`（最小指引）→ 按需深入 `docs/DEVELOPMENT.md` / `docs/ARCHITECTURE.md`
