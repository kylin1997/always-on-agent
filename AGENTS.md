# AGENTS.md

## 项目概述

- **always-on-agent** 是一个基于 Node.js 的本机常驻 agent。
- pi 1.5.2 负责单次 run 的 agent loop，SQLite 和本地文件承载 event inbox、timers、memory、permissions 与 outbox。架构详见 [设计文档 v4](docs/DESIGN.md)。
- 运行时使用 Node.js ≥ 22.19 和 ESM。代码按模块划分，错误显式处理。

## 本地运行

| 命令 | 说明 |
| --- | --- |
| `npm ci` | 安装锁定的依赖 |
| `npm start` | 启动本机服务，默认地址为 `http://127.0.0.1:8787` |
| `npm run dev` | 启动文件监听模式 |
| `MODEL_PROVIDER=faux npm start` | 使用内置规则响应，可体验时间、提醒和模拟审批 |

配置默认值见 [config/default.json](config/default.json)。用 `PORT`、`DATA_DIR`、`POLL_MS` 和 `LEASE_MS` 覆盖相应设置。Ollama 默认模型为 `qwen3.5:4b`，可用 `OLLAMA_MODEL` 和 `OLLAMA_URL` 覆盖。Ollama 无法连接时会切换到 faux。

`MODEL_PROVIDER=openai-compatible` 需要 `ONLINE_BASE_URL`（HTTPS）、`ONLINE_MODEL` 和 `ONLINE_API_KEY`。密钥可从环境变量或数据目录下的 `credentials.json` 读取。在线模式会将本次请求上下文发送到配置的模型服务。

本地脚本向 `POST /events` 或 `POST /timers` 提交 JSON 时，用启动终端显示的令牌设置 `X-Local-Token`。消息体使用 `{ "sourceId": "client-event-id", "text": "现在几点" }`。schedule 使用 UTC 毫秒时间戳 `dueAt`，可选正整数秒数 `everySeconds` 和提醒文本 `text`。

`DREAM_EVERY_SECONDS` 启用定期记忆去重，默认关闭。运行数据默认写入 `data/`。

## 验收

模型接入、审批恢复和崩溃注入的验收场景见设计文档 §9。
