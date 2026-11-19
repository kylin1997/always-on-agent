# AGENTS.md

## 项目概述

- **always-on-agent** 是一个基于 Node.js 的常驻 agent 项目。
- 核心依赖开源库 **pi**（npm 命名空间 `@earendil-works/pi-*`，常用包如 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`）。
- pi 依赖约定使用**最新稳定版**：`pi-agent-core` / `pi-ai` / `pi-coding-agent` 当前为 `1.5.2`（2026-11-19 经 npm registry 确认）。
- 需求细节待补充：当前仅完成项目初始化说明，尚未创建 `package.json`，也未安装依赖。

## 常用命令

> 注意：`package.json` 尚未创建，以下为初始化后的预期命令，暂不可直接运行。

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装依赖（初始化后生效） |
| `npm run dev` | 本地开发运行（脚本待定义） |
| `npm test` | 运行测试（脚本待定义） |

## 代码规范

- 使用 **ESM** 模块系统（`"type": "module"`）。
- 运行时：Node.js v26（本机 v26.7.0；pi 要求 Node ≥ 22.19）。
- 保持小模块、单一职责；错误显式处理，不吞异常。
- 详细规范待项目成型后补充。

## 测试方式

- 测试框架尚未选定；推荐优先考虑 Node 内置 **`node:test`**（与 pi 仓库自身测试选择一致，避免过早引入额外依赖）。
- 测试文件建议放在 `test/` 目录，命名 `*.test.mjs`。
- 具体测试方案待需求明确后确定。
