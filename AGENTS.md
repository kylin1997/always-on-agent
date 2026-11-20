# AGENTS.md

## 项目概述

- **always-on-agent** 是基于 Node.js 的本机常驻 agent：被事件唤醒、跑一次短 run、存状态、再休眠。
- pi 1.5.2 负责单次 run 内的 agent loop；SQLite 和本地文件承载 event inbox、timers、memory、permissions、outbox 五个持久原语。
- 运行时 Node.js ≥ 22.19、ESM。小模块、单一职责、错误显式处理。

## 文档索引

| 需求 | 去看哪里 |
| --- | --- |
| 项目是什么、能做什么、30 秒上手 | [README.md](README.md) |
| 本机环境初始化、模型准备、配置、HTTP API、常见问题 | [本地上手指南](docs/GETTING_STARTED.md) |
| 架构与五个原语、技术决策、验收场景 | [设计文档 v4](docs/DESIGN.md) |
| 如何端到端验证、feature map | [verify-always-on-agent](.workbuddy/skills/verify-always-on-agent/SKILL.md) |

## 常用命令

`npm ci` 安装，`npm start` 启动（`http://127.0.0.1:8787`），`npm run dev` 监听模式。`MODEL_PROVIDER=faux npm start` 用内置规则脑，无需 Ollama。完整配置与环境变量见[上手指南](docs/GETTING_STARTED.md#5-配置)。

## 关键约束

- 默认模型本地 Ollama `qwen3.5:4b`，零 key；探测不到服务时降级 faux，`/status` 显示实际 provider。
- 运行时状态只写 `DATA_DIR`（默认 `data/`，已 gitignore）；凭证可放 `DATA_DIR/credentials.json`。
- 验证必须走真实页面与 HTTP 接口并留证据，不能只跑单测就宣称可用。验收场景见设计文档 §9。
