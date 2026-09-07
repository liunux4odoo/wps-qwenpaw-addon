# 开发维护规则

本文档面向开发者与 code agent，说明本仓库的开发协作规则。普通使用者无需阅读。

## 架构层决策的变更控制

- 架构层决策的变更**必须先回到 discuss agent 重启讨论**，不能由 code agent 自行修改
- code agent 实施时如发现某条约束不可行，**先暂停、再讨论**，不要绕过
- 方案版本在 `docs/ARCHITECTURE.md` §0 记录，变更须同步更新版本号与变更历史

## 硬约束（不允许的改动方向）

完整清单见 `docs/ARCHITECTURE.md` §6，要点：

- 不允许修改 wps-office-mcp 源码逻辑（外部依赖零 fork）；**唯一例外**：`wps-client.ts:46` 的 `POLL_PORT` 支持 `WPS_POLL_PORT` 环境变量（1 行加法改动，默认行为不变）
- 不允许修改 QwenPaw 主干；配置走标准 MCP 客户端配置
- 所有文档操作必须经 QwenPaw → MCP → wps-office-mcp 路径，加载项角色 B 只是执行代理
- 不允许在加载项里实现 LLM 调用 / 记忆系统（归 QwenPaw 管）
- 不允许 acp-bridge 实现任何 ACP 业务逻辑（纯传输层转发）
- 不允许 acp-bridge 绑定 0.0.0.0 或暴露到局域网（只绑 `127.0.0.1`）
- 不允许绕过 wps-mcp 应用切换的 noop 脚本替换（缺失会导致 WPS 被强杀）
- **不允许新增 ACP server adapter 或为其它 code agent 做适配**（2026-09-07 定案：qwenpaw 为主目标，opencode 为替代，兼容到此为止；claudecode / kimicode / qcoder 等推迟，见 ARCHITECTURE.md v0.25 / §6.3）

## 依赖管理（submodule）

- `third_party/opencode-wps/` 是 **git submodule**，固定提交 `6b8b33c`（见 `docs/DEPENDENCIES.md`）
- 更新方式：`git submodule update --init --recursive`；换版本须同步更新 `docs/DEPENDENCIES.md`
- **POLL_PORT 补丁**：submodule 钉定的上游提交不含 `WPS_POLL_PORT` 支持（仍为 `const POLL_PORT = 58891;`），`scripts/install.sh` 会在构建时幂等打补丁 + rebuild（详见 `docs/INSTALL.md` §安装 wps-office-mcp）。**不要**把补丁改动提交进 submodule 的 git
- wps-mcp 的 noop 脚本（`scripts/wps-auto-noop.sh`）是强制部署配套，缺失会导致 WPS 强杀

## 部署约定

- 加载项最终安装到 `~/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_/`（WPS Linux）
- `js/main.js`、`js/wps-bridge.js` 与全部控制器模块（`app-state.js`、`doc-state.js`、`bridge-config.js`、`session.js`、`agents.js`、`acp-events.js`、`watchdog.js`、`actions.js`、`poll.js`、`ribbon.js`）**必须一起**同步到已安装 addon 目录并**完全重启 WPS** 才生效（原子耦合，见 ARCHITECTURE §4.1）
- 一键安装/更新请用 `scripts/install.sh`，不要手动零散拷贝

## 验证命令

```bash
# Python（桥接服务）
conda run -n py312 python -m py_compile bridge/acp-bridge.py
conda run -n py312 python bridge/test_bridge.py

# JS（加载项）
node --check js/*.js
node bridge/test_frontend_race.js   # 前端行为验证（vm sandbox 按 manifest 顺序加载控制器模块，A-F 场景）

# wps-office-mcp（submodule 内，安装时自动执行）
cd third_party/opencode-wps/wps-office-mcp && npm run build && npm test
```
