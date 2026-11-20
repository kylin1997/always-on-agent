# always-on-agent

一个**本机常驻 agent**：大部分时间休眠，被事件唤醒，干完活存状态，再睡回去。消息、提醒、审批都能唤醒它；它用本地模型思考、用工具做事、把结果写进收件箱给你看。全程离线、零 API key。

> 基于 Anthropic 的文章 [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) 实现。
>
> 文章讲的&#x662F;**：别写一个永远跑着的 agent，而是给一次次短 run 套一层持久化外壳**。项目名里的 "always-on" 说的是体验，不是进程——agent 绝大多数时间不耗 token。  
> 中文译文：[硅基老张《构建常驻 Agent》](https://kylin1997.github.io/2026/11/18/building-always-on-agents/)



---

## 它能做什么

打开网页，发一句话，agent 会真的思考并回复。试试这些：

- `现在几点` → 它调用 `get_time` 工具，把当前时间告诉你
- `20 秒后提醒我喝水` → 它设一个定时器，20 秒后主动给你发提醒，**不需要你再发消息**
- `发邮件给老板说我今天请假` → 高风险操作挂起，网页弹出**待审批卡片**；你点"批准"，它才继续（且只是本地模拟，不会真发邮件）
- `请记住：我的项目编号是 AOA-42` → 过一会儿问它"我记得什么？"，它会答出 AOA-42
- 连发多条消息 → 合并成一次 run，只回一次；重复同一个事件 ID → 自动去重

消息、审批结果、定时器到期，都是**事件**。事件进收件箱 → worker 唤醒 agent → 结果投递到网页。

## 30 秒跑起来

**前提**：Node.js ≥ 22.19、已安装并启动 [Ollama](https://ollama.com/)、拉好小模型。

```bash
npm ci                                    # 安装依赖
ollama pull qwen3.5:4b                    # 拉模型（约 3.4GB，只需一次）
ollama serve                              # 另开一个终端启动（若未自动运行）
npm start                                 # 启动服务
```

浏览器打开 **<http://127.0.0.1:8787>** ，在消息框里打字发送即可。终端会显示一个本地脚本令牌；用 curl 直接调 API 时要带上它。

没有 Ollama 也想玩？用内置规则脑：`MODEL_PROVIDER=faux npm start`，能体验时间、提醒和审批全流程，回复是预设的、不是真模型。

> 首次初始化、环境变量、模型切换、常见问题，见 [本地上手指南](docs/GETTING_STARTED.md)。

---

## 架构：五个持久原语

pi（`@earendil-works/pi-*`）只负责**一次 run 内**的 agent loop：收消息 → 调模型 → 调工具 → 循环。真正要建的是外围五层持久化外壳：

| 原语              | 作用                                          | 本项目实现                                     |
| --------------- | ------------------------------------------- | ----------------------------------------- |
| **Event inbox** | 所有触发源先进持久队列；handler 快应答，单 worker 批量消费，可崩溃重放 | `events` 表 + `POST /events` + `worker.js` |
| **Timers**      | follow-up（agent 自己设的提醒）与 schedule（用户设的周期任务） | `timers` 表 + `scheduler.js`               |
| **Memory**      | 只存别处查不到的东西：指令、笔记、历史、进度                      | `data/memory/` 文件 + `mem_index` 索引        |
| **Permissions** | 凭证不进 transcript；高危操作挂起等审批                   | `permissions.js` + `deferred_requests` 表  |
| **Outbox**      | run 的产出先落库，再由 dispatcher 投递                 | `outbox` 表 + file/log/console dispatcher  |

```
 POST /events ──> [Inbox] ──> [Worker] ──> [Runtime + pi] ──> [Outbox] ──> [Dispatcher] ──> Web
      ^               ^             │            │  │
      │               └── 标记 done  │            │  └── 写 session / memory
   用户回复        Timer 触发     批量取事件  权限拦截
      └──── 审批结果 / timer 到期 ────── 作为新事件回到 inbox ──────┘
```

**关键行为**：handler 202 快应答（实测 3.6ms）；一个 inbox 同时只有一个 worker（DB 租约 + 心跳）；事件去重、批量合并；run 在审批处真正结束并保存 session，用户批准后作为新事件续跑。

完整设计见 [设计文档 v4](docs/DESIGN.md)。

## 项目结构

```
src/       运行时：config / db / events / worker / scheduler / timers /
           memory / permissions / outbox / model / tools / runtime / server / index
web/       单页测试界面（发消息 + 实时显示 outbox 与审批卡片）
config/    默认配置（端口、模型、轮询、风险规则）
docs/      设计文档、本地上手指南
data/      运行时产物：SQLite 库、memory 文件、outbox.log（已 gitignore）
.workbuddy/skills/  pstack 工程 skill + 本项目验证 skill
```

## 模型

默认本地 Ollama `qwen3.5:4b`（离线、零 key）。可用 `OLLAMA_MODEL` 换模型，`MODEL_PROVIDER=faux` 切内置规则脑，`MODEL_PROVIDER=openai-compatible` 接在线模型（需 key，会把上下文发到外部服务）。探测不到 Ollama 时自动降级到 faux，`/status` 会显示当前 provider。

> 实测：4b 工具调用可靠，但它是思考型模型，简单回复约 20 秒、多轮审批约 50 秒。追求速度可换更小的模型，追求响应质量可换 `qwen3.5:9b`。

## 验证

项目内置 pstack 风格的验证 skill，用真实页面与 HTTP 接口驱动完整闭环，并留下证据：见 [verify-always-on-agent](.workbuddy/skills/verify-always-on-agent/SKILL.md)。设计文档 §9 记录模型接入、审批恢复与崩溃注入的验收场景。
