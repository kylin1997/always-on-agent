# AGENTS.md

## 项目概述

- **always-on-agent** 是一个基于 Node.js 的常驻 agent 项目。
- 核心依赖开源库 **pi**（npm 命名空间 `@earendil-works/pi-*`，常用包如 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`）。
- pi 依赖约定使用**最新稳定版**：`pi-agent-core` / `pi-ai` / `pi-coding-agent` 当前为 `1.5.2`（2026-11-19 经 npm registry 确认）。
- 需求与架构详见 `docs/DESIGN.md`（v2 已定稿）：pi 只负责单次 run 内的 agent loop，外围自建 event inbox / timers / memory / permissions / outbox 五个持久原语。
- 当前状态：设计已确认，依赖已安装，尚未开始编码。

## 常用命令

> 注意：`package.json` 已创建，但 dev / test 脚本尚未定义（当前 `test` 为占位），编码阶段补齐。

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装依赖（初始化后生效） |
| `npm run dev` | 本地开发运行（脚本待定义） |
| `npm test` | 运行测试（脚本待定义） |

## 代码规范

- 使用 **ESM** 模块系统（`"type": "module"`）。
- 运行时：Node.js ≥ 22.19（本机实测 v22.22.2；pi 要求 ≥ 22.19）。
- 保持小模块、单一职责；错误显式处理，不吞异常。
- 详细规范待项目成型后补充。

## 测试方式

- 测试框架尚未选定；推荐优先考虑 Node 内置 **`node:test`**（与 pi 仓库自身测试选择一致，避免过早引入额外依赖）。
- 测试文件建议放在 `test/` 目录，命名 `*.test.mjs`。
- 具体测试方案待需求明确后确定。
