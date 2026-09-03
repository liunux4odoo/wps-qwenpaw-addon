# 依赖版本注记

开发与部署使用的相关项目版本。**改动依赖版本时须同步更新本文件。**

## 版本清单（2026-09-03 实测）

| 组件 | 版本/提交 | 说明 |
|---|---|---|
| **opencode-wps**（submodule） | 固定提交 `6b8b33c`（`third_party/opencode-wps/`） | GitHub: `lnxsun/opencode-wps`，上游 HEAD |
| **wps-office-mcp**（opencode-wps 内） | v1.5.2 | 14 个直连工具 + 250+ Gateway 工具（包版本号见其 `package.json`） |
| **QwenPaw** | v2.1.0 | `qwenpaw acp` 对外提供 ACP（纯 stdio）；py312 conda 环境 |
| **Node.js** | ≥ 18.0.0（wps-office-mcp `engines` 要求） | 本机以 node 直接运行 wps-mcp |
| **Python** | 3.12（py312 conda 环境） | acp-bridge 运行环境 |
| **websockets** | 15.0.1（py312） | acp-bridge 依赖 |

## 依赖关系与获取方式

```
wps-qwenpaw-addon/
└── third_party/opencode-wps/          ← git submodule（git clone GitHub 仓库）
    └── wps-office-mcp/                ← npm install + npm run build
```

- **submodule 初始化**：`git submodule update --init --recursive`
- **wps-office-mcp 构建**：`cd third_party/opencode-wps/wps-office-mcp && npm install && npm run build`

## 为什么要固定 opencode-wps

`js/main.js` 的 ACP `session/new` 需注入 wps-office-mcp 的 stdio 入口路径。若用手写绝对路径，不同机器路径不同，无法复现。将 opencode-wps 作为 **submodule** 钉定提交后，入口路径可由 `acp-bridge` 依据仓库根确定为：

```
<仓库根>/third_party/opencode-wps/wps-office-mcp/dist/index.js
```

（加载项通过 bridge 的 `GET /config` 获取该路径，不硬编码。）

## 需要手动打的补丁（install.sh 自动完成）

钉定的上游提交（6b8b33c）**不含** 路线 P 的 `WPS_POLL_PORT` 支持（`wps-client.ts` 仍是 `const POLL_PORT = 58891;`）。安装脚本会幂等打补丁 + rebuild：

```diff
--- a/wps-office-mcp/src/client/wps-client.ts
+++ b/wps-office-mcp/src/client/wps-client.ts
@@
-const POLL_PORT = 58891;
+const POLL_PORT = Number(process.env.WPS_POLL_PORT) || 58891;
```

> 该改动是 ARCHITECTURE §6.1 允许的唯一 wps-office-mcp 加法改动（默认行为不变）。**不要**提交进 submodule git；仅作为安装时补丁保留在 `scripts/patches/`。

## noop 脚本（部署配套）

`scripts/wps-auto-noop.sh` 需部署到 submodule 内 `opencode-wps-linux/wps-auto.sh`（防 wps-mcp 强杀 WPS）。install.sh 自动完成。
