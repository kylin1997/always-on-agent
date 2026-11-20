# 本地上手指南

面向第一次在自己机器上跑这个项目的人。目标是：从零开始，10 分钟内看到 agent 通过网页回你第一句话。

---

## 1. 环境要求

| 依赖 | 版本 / 说明 | 检查命令 |
|---|---|---|
| Node.js | **≥ 22.19**（项目用 22.22.2 验证过，ESM） | `node -v` |
| npm | 随 Node 安装即可 | `npm -v` |
| Ollama | 已安装且服务在运行 | `ollama --version` |
| 模型 | `qwen3.5:4b`（约 3.4GB） | `ollama list` |

`better-sqlite3` 是原生模块，`npm ci` 时需要能编译（macOS 需 Xcode command line tools，Linux 需 build-essential）。若预编译包可用则无需编译。

**没有 Ollama 也能跑**：用内置的 faux 规则脑（`MODEL_PROVIDER=faux`），能完整体验消息、工具、提醒和审批流程，但回复是预设的，不是真模型。适合先跑通链路再接模型。

---

## 2. 安装与初始化

```bash
# 1) 进入项目目录
cd always-on-agent

# 2) 安装锁定版本的依赖
npm ci

# 3) 准备本地模型（只需一次）
ollama pull qwen3.5:4b

# 4) 确认 Ollama 服务在运行
curl -s http://localhost:11434/api/tags | head -c 200
```

如果第 4 步没输出或报错，启动服务：

```bash
ollama serve
```

保持这个终端开着。macOS / Windows 上若 Ollama 是桌面应用，通常已在后台运行，跳过此步。

---

## 3. 启动

```bash
npm start
```

看到下面两行就成功了：

```
Always On Agent: http://127.0.0.1:8787 (ollama)
Local script token (X-Local-Token): <一长串随机字符串>
```

`(ollama)` 表示走的是真模型。若显示 `(faux)`，说明探测不到 Ollama 服务，已自动降级——检查服务是否启动。

浏览器打开 **http://127.0.0.1:8787**。页面底部状态栏应显示 `Worker online · Scheduler online · Dispatcher online · ollama`。

在消息框输入 `你好` 并发送，约 20 秒后会看到 agent 的回复（`qwen3.5:4b` 是思考型模型，首轮较慢）。

---

## 4. 快速体验清单

按顺序试，能覆盖所有核心行为：

1. **基础对话**：发 `你好，用一句话介绍自己` → 收到模型回复
2. **工具调用**：发 `现在几点` → agent 调用 `get_time` 返回时间
3. **定时器**：点页面上的「定时」按钮（或发 `15 秒后提醒我喝水`）→ 15 秒后自动收到提醒，不需要再发消息
4. **审批**：点「模拟发邮件」→ 出现「待审批 · 模拟外发」卡片，点「批准」→ agent 完成并记录（本地模拟，不真发）
5. **记忆**：发 `请记住：我的项目编号是 AOA-42`，等回复后再发 `我记得什么？` → 答出 AOA-42
6. **去重**：用 curl 重复发送同一个 `sourceId`，返回 `duplicate:true`，不会多一次回复

---

## 5. 配置

默认值在 [config/default.json](../config/default.json)，可用环境变量覆盖：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP 端口 |
| `DATA_DIR` | `data` | 运行时数据目录（SQLite 库、memory、日志） |
| `MODEL_PROVIDER` | `ollama` | `ollama` / `faux` / `openai-compatible` |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Ollama 模型名 |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama 地址 |
| `POLL_MS` | `500` | worker / scheduler 轮询间隔 |
| `LEASE_MS` | `30000` | worker 租约时长（崩溃后事件重新入队） |
| `DREAM_EVERY_SECONDS` | `0`（关闭） | 定期记忆去重 |
| `RISK_RULES` | 见配置文件 | 工具风险规则 JSON，如 `{"send_external":"block"}` |

几个常用变体：

```bash
# 换更大的模型（质量更好，更慢）
OLLAMA_MODEL=qwen3.5:9b npm start

# 换端口 + 独立数据目录（可并行跑两个实例）
PORT=8788 DATA_DIR=/tmp/aoa-demo npm start

# 完全离线、没有 Ollama
MODEL_PROVIDER=faux npm start
```

### 在线模型（可选）

```bash
MODEL_PROVIDER=openai-compatible \
ONLINE_BASE_URL=https://your-endpoint/v1 \
ONLINE_MODEL=your-model \
ONLINE_API_KEY=your-key \
npm start
```

密钥也可放在 `DATA_DIR/credentials.json` 里（键名 `ONLINE_API_KEY`），避免出现在命令行历史中。注意：在线模式会把本次请求的上下文发送到配置的模型服务，不是离线运行。

---

## 6. 用 HTTP API 调用

网页是主要入口，也可以直接用 curl。本地脚本请求需要带启动终端打印的令牌：

```bash
TOKEN='<启动时打印的 X-Local-Token>'

# 发消息
curl -s -H 'Content-Type: application/json' \
  -H "X-Local-Token: $TOKEN" \
  -d '{"sourceId":"my-first-event","text":"现在几点"}' \
  http://127.0.0.1:8787/events

# 查看投递给用户的消息（网页就是这个接口的轮询结果）
curl -s http://127.0.0.1:8787/outbox?after=0

# 查看状态、事件、记忆
curl -s http://127.0.0.1:8787/status
curl -s http://127.0.0.1:8787/events
curl -s http://127.0.0.1:8787/memory
```

从浏览器发起的请求靠同源校验（带 `Origin` 头），不需要令牌。

---

## 7. 常见问题

**`(faux)` 而不是 `(ollama)`**：Ollama 探测失败。确认 `curl http://localhost:11434/api/tags` 有输出，模型已 `ollama pull`。

**回复很慢**：`qwen3.5:4b` 是思考型模型，简单回复约 20 秒、多轮工具调用可达 50 秒。换 `qwen3.5:9b` 质量更好但更慢；要快可用 `qwen3.5:0.8b`（工具调用可能不稳）或 faux。

**审批卡片一直 pending**：检查是否用了页面上的「批准/拒绝」按钮，或用 curl 提交 `{"type":"deferred_response","requestId":"<id>","decision":"approved"}` 到 `/events`。审批期间 worker 不会阻塞，可以处理别的事件。

**端口被占用**：`PORT=8788 npm start`。

**想清空所有数据重来**：停掉服务，删除 `data/` 目录（这是唯一运行时状态存放处），重新启动。

**原生模块编译失败**：`better-sqlite3` 需要编译工具链；macOS 执行 `xcode-select --install`，Ubuntu/Debian 安装 `build-essential` 和 `python3`。

---

## 8. 深入阅读

- [README.md](../README.md) — 项目定位与 30 秒上手
- [设计文档 v4](DESIGN.md) — 架构、五个原语、技术决策、验收场景（§9）
- [验证 skill](../.workbuddy/skills/verify-always-on-agent/SKILL.md) — 如何用真实页面与 API 驱动完整闭环并留证据
- 原文：[Building always-on agents](https://claude.com/resources/articles/building-always-on-agents)
- 译文：[硅基老张《构建常驻 Agent》](https://kylin1997.github.io/2026/11/18/building-always-on-agents/)
