# always-on-agent 设计文档 v2

> 目标：按 Anthropic《Building always-on agents》实现一套可运行的常驻 agent，agent loop 运行时用 pi（`@earendil-works/pi-*`），外围自建五个持久原语。
> 状态：设计讨论完成，待确认后开工。
> 版本说明：v2 根据 GLM5.3 独立评审（基于本机 pi 1.5.2 源码事实）修订。需求符合性（五原语 + event inbox 原文要点）评审确认完整，未改动；技术设计硬伤已修，三项决策按推荐定稿（见 §11）。

---

## 1. 需求对照（lock）

| # | 确认项 | 落地决定 |
|---|--------|----------|
| 1 | 持久化 | SQLite（`better-sqlite3`，本地单文件，零运维） |
| 2 | 事件入口 | 本地 HTTP 端点 `POST /events`，快速 ACK |
| 3 | 投递渠道 | 先写文件 + log + 控制台打印；抽象 `Dispatcher` 接口，后续可挂 webhook/IM |
| 4 | Web 界面 | 单页：左侧发消息测 `POST /events`，右侧实时显示 outbox 消息（含审批卡片） |
| 5 | 第一版范围 | 五原语全做最小可用：deferred 挂起、去重、批处理、timer 续跑全实现；auto mode 分类器与 dreaming 为**规则式实现 + 可替换模型接口**（口径见 §11 决策 2），先跑通闭环 |
| 6 | 默认模型 | 本地 ollama `qwen3.5:4b`（3.4GB，零 key、离线）；`qwen3.5:0.8b` 降级为可选实验；faux 用于单测/无服务降级；env 可切 |

附加约束：项目当前为空壳（Node v22.22.2 / ESM，AGENTS.md 里的 v26 记录有误待改），pi 依赖 1.5.2，测试用 Node 内置 `node:test`。
运行环境前提：ollama 已装但服务当前未启动；启动时探测 `localhost:11434`，未起则提示 `ollama serve`，并保留 faux 降级开关以便无服务时仍能跑通闭环。

---

## 2. 总体架构

pi 只负责 **一次 run 内的 agent loop**（消息→模型→工具→循环）。五个原语是外围的持久化外壳，让 agent 大部分时间休眠、被事件唤醒、干完存状态、再睡。

```
                         ┌──────────────────────────── 一次 run ────────────────────────────┐
  HTTP POST /events ──> [Event inbox] ──> [Worker] ──> [Runtime + pi Agent] ──> [Outbox] ──> [Dispatcher]
        ^                    ^  ↑              │                │  │                              │
        │                    │  └──── 标记 done  │                │  └──> 写 messages/状态          └──> Web UI / 文件 / log
   Web 发消息          Timer 触发事件        批量取事件     读/写 Memory                       
        │                    │                                    │
        └──── 用户回复/deferred 审批 ───────────────────────────────┘（作为新事件回到 inbox）
                             ▲
                        [Scheduler] ── 轮询到期的 [Timers]（follow-up / schedule）
```

**闭环**：事件入 inbox → worker 单实例批量取 → 判定续接/新建 session → runtime 加载 memory 并跑 pi → 工具调用（受 permissions 约束，高危走 deferred）→ run 结束写 outbox + 回写 memory + 存 session → dispatcher 投递 → Web 显示。run 内可设 timer、可 deferred 请求审批；用户回复/审批/定时器到期都变成新事件回到 inbox，循环往复。

**术语区分**（避免混淆）：本文的 **deferred tool call** = 高危工具挂起等待用户审批（§5.4）。pi faux provider 自带的 `DeferredHandle` / `fetchDeferred` 是"异步模型响应"机制，两者无关，实现时不要用错 API。

---

## 3. 模块划分与职责

```
src/
  config.js          配置加载（config/default.json + 环境变量覆盖：端口、路径、轮询间隔、模型、风险规则）
  db.js              SQLite 连接、建表、迁移；单例导出
  events.js          inbox 数据访问：append(去重) / listPending / claim(带 lease) / markDone / markFailed / 回收过期 lease
  worker.js          单 active worker（带 heartbeat + 锁过期）；poll + 事件唤醒；批量合并；驱动 run；崩溃重放
  timers.js          timer CRUD：follow-up / schedule（含 recurrence）
  scheduler.js       定时轮询到期 timer → 写 inbox 事件（follow-up 标 done，schedule 推进下次时间）
  memory.js          四类记忆的**单一写入门面**（原子写文件 + 索引）；加载与写回；上下文裁剪
  permissions.js     auto mode 规则分类器（可替换接口）、credential proxy、deferred 请求的持久与恢复
  outbox.js          outbox 表 + dispatcher（file/log/console，投递幂等，接口预留 webhook/IM）
  model.js           构建 pi Models 集合：默认接本地 ollama（createProvider + openAICompletionsApi），env 可切 faux/在线 provider
  faux-brain.js      faux 用的动态响应工厂：单测与无 ollama 时的降级；多轮工具循环按需补响应
  tools.js           AgentTool 定义（含 label/parameters/execute/replay；见 §6）
  runtime.js         一次 run 的编排：构建 Agent、注入 memory、run 内 prompt injection 深校验、跑 session、处理 deferred、持久化、写 outbox
  server.js          HTTP 端点 + 静态 Web 托管
  index.js           bootstrap：初始化 DB、启动 worker/scheduler/dispatcher/server、优雅退出
web/                 index.html / app.js / styles.css
data/                运行时产物：always-on.db、memory/<userId>/、outbox.log、credentials.json（.gitignore）
test/                *.test.mjs（含 spike / 崩溃注入 / 批准拒绝双路径）
```

---

## 4. 数据模型（SQLite 表）

| 表 | 关键字段 | 说明 |
|----|----------|------|
| `events` | id, user_id, source, source_id, type, session_id, payload(JSON), status(pending/processing/done/failed), attempts, locked_by, lease_until, created_at, updated_at | inbox；**复合唯一 `(user_id, source_id)` 去重**（原文建议 per-user inbox，避免跨用户 source_id 碰撞）；带 lease 实现崩溃重放 |
| `sessions` | id, user_id, status(active/deferred/closed), messages(JSON=pi transcript), created_at, updated_at | 保存 pi 的 session，支持跨 run 续接与 deferred 中途恢复；超长时按 §5.3 裁剪 |
| `timers` | id, user_id, kind(follow_up/schedule), due_at, recurrence(JSON), payload(JSON), status(pending/done), session_id, created_at | follow-up 由 agent 设、schedule 由用户设；recurrence 存 cron-like 规则 |
| `deferred_requests` | id, session_id, user_id, tool_call_id, tool_name, args(JSON), status(pending/approved/rejected), created_at, resolved_at | 挂起的审批请求；恢复时 `tool_call_id` 必须与 transcript 中的 toolCall.id 严格一致 |
| `outbox` | id, user_id, kind(message/approval/notice), payload(JSON), delivery_key(幂等), status(pending/delivered/failed), created_at, delivered_at | 发件箱；dispatcher 按 delivery_key 幂等投递，重放不重复发 |
| `mem_index` | user_id, category, path, summary, updated_at | notes/progress 的索引（文件内容存 `data/memory/`，索引入 DB 便于加载）；与文件由 memory.js 原子双写 |

Memory 采用**文件目录**为真相（对齐文档：`instructions.md`、`index.md`、`reported.md` + `notes/`、`progress/`），`mem_index` 只加速索引。所有状态存 SQLite/文件，worker 重启后 memory 与 session 都还在。

---

## 5. 五个原语的关键设计

### 5.1 Event inbox

**三个组件**（对齐原文）：
1. **持久化的事件列表**：`events` 表（见 §4），每个事件追加为一行，带 status 与复合唯一 `(user_id, source_id)` 去重。
2. **handler**：HTTP 端点 `POST /events`（`server.js`），把事件写入该列表。
3. **worker**：后台服务（`worker.js`），从该列表读取并处理。

**主流程**（对齐原文）：新事件到来 → handler 写入 inbox 并唤醒 worker → worker 读取**所有待处理**内容并启动一次 run → 延续此前工作的事件（如用户回复，`session_id` 指向 active session）恢复已有 session，其他事件新建 session → worker 把事件交给 agent 循环（runtime + pi），等待 run 结束，并把相应事件**标记为 done**。

**最佳实践**（逐条对齐原文）：
- **handler 尽快确认**：只做轻量校验 + 写库 + 唤醒，立即返回 202；webhook 提供方把慢响应视为失败，故更深入的验证（如 prompt injection 检查）留到 run 期间，作为 runtime 内一个独立的校验步骤执行（黑名单挡不住自然语言注入）。
- **inbox 是唯一事实来源**：worker 被唤醒时首先从 inbox 重新拉取最新事件，不信任事件携带的状态；若 worker 在 run 中途挂掉，带 **lease/TTL** 的 claim 会过期，另一个 worker 可回收 `processing` 事件并按 `attempts` 重试——不会死锁、不会永久卡住。
- **一个 inbox 同一时间只有一个 active worker**：DB 层 `worker_lock` 行（带 heartbeat + 过期释放）+ 进程内锁双保险，避免两次 run 重复劳动或相互覆盖。新事件在 run 中途到达时的处理策略可配（三选一）：推给下一次 run / 并入当前 run（默认，折叠进 follow-up 队列）/ 中断并重启。
- **worker 批量合并待处理事件**：同一 user 连续发送的多条消息合并成一次 run，agent 只需回复一次。
- **批处理与 deferred 的边界**：若一批事件中某条触发 deferred，把该条单独剥离挂起，其余重新入 pending；一批内最多产生一个 deferred 请求，避免多工具同时挂起导致 transcript 状态错乱。
- **deferred session 的恢复入口收窄**：只有携带匹配 `deferred_response`（request_id 匹配）的事件能 resume `status=deferred` 的 session；等待期间其他事件即使带同一 session_id 也不得触发并发 resume（原文 §129 要防的竞争 runs）。

### 5.2 Timers + Scheduler
- 独立 `timers` 表；inbox 只放"现在就能干"的事件。
- `set_timer` 工具让 agent 在 run 内创建 follow-up（如"30 秒后检查回复"）；Web 端点 `POST /timers` 让用户建 schedule（如每天某时）。
- scheduler 固定间隔轮询：扫描 due → follow-up 标 done / schedule 按 recurrence 推进 due_at → 写一条事件进 inbox → 唤醒 worker。timer 本身不直接起 run。
- 先实现 interval 型 recurrence（`{everySeconds}`）+ 一次性 cron 表达式预留。备选：可用 durable execution engine 替代自研 scheduler。

### 5.3 Memory
- 每次 run 开头加载：`instructions.md`（用户指令）、`index.md`（notes/progress 索引）、`reported.md`（已告诉用户的内容，防重复）——保持精简，控制上下文开销。
- 按需加载：`notes/<id>.md`、`progress/<id>.md`——agent 通过工具读具体文件；`mem_index` 提供摘要。
- **写入门面**：所有 memory 写入必须经 `memory.js` 单一门面，原子地同时落文件与 `mem_index`，禁止绕过，避免双写漂移。
- 用户指令录入：`instructions.md` 由管理员直接编辑文件（不提供 agent 工具写入，防止自改指令）；或后续加 config 入口。
- 写入时机：run 中 agent 用 `save_note` / `update_progress` 写；run 结束 runtime 抽取"本次新事实"追加到 `reported.md`。
- 只存不可再查到的信息；已有系统的东西存指针（system prompt 里明确此规则）。
- **上下文管理**：sessions 表存完整 transcript，但用 pi 的 `transformContext` 钩子做基于 token 估算的旧消息裁剪（compact）；超限时另起 session，关键点先写 memory（原文 §153）。否则小上下文会被 system prompt + 工具定义 + memory 挤爆。
- **Dreaming**（v1 规则式）：由 schedule timer 周期性触发（默认关闭，配置开启），规则式蒸馏/替换过时 notes、发现跨 run 模式，可选接模型做摘要（接口预留）。真模型梦境列 v2。

### 5.4 Permissions
- **Credential store + proxy**：凭证存 `data/credentials.json`（或 env），由 proxy 在工具发请求时注入，agent 与 transcript 永不接触明文。**诚实标注**：v1 凭证与 proxy 同进程、同文件系统，是演示级隔离，不是生产安全模型；生产需独立进程/独立凭据域。
- **Auto mode 分类器**（v1 规则式）：`classifyRisk(toolName, args)` → allow / ask / block，用高风险工具名/参数黑名单；接口留好接真实模型分类器。block 直接拦截，ask 走 deferred。
- **Deferred tool call**：`beforeToolCall` 命中 ask → 写 `deferred_requests` + 写 outbox 审批卡片 → run 结束、session 存为 deferred。**硬约束**：run 必须在 deferred 处真正结束、session 中途存盘，worker 才能去处理别的事件。
  - pi 的 `beforeToolCall` 返回 `{block:true}` 时工具不执行，pi 会写一条 error 类型 tool_result 进 transcript。
  - `terminate` 只是提示，**仅当整批工具全部 terminate 才真结束**（源码事实）。因此第一版 `toolExecution` 固定为 `"sequential"`，且保证高风险工具所在批次只有它一个（或用 `finishTurn` 返回 `{action:"end"}` 强制收尾），确保 run 真停。
- **恢复（四步链路，批准/拒绝都要单测）**：
  1. 从 `deferred_requests` 取 `tool_call_id` / `tool_name` / `args`；
  2. 批准 → 手动调用 `tool.execute()` 拿真实结果；拒绝 → 构造"用户拒绝"错误结果；
  3. 在 transcript 中定位那条 error tool_result，按**原 `tool_call_id`** 替换 content / isError（否则 OpenAI 兼容协议报 "tool_use without matching result"）；
  4. 新建 Agent（`initialState.messages` 灌入恢复后的 transcript，`beforeToolCall` 放行该工具）→ `agent.continue()`。旧实例直接 continue 不成立；transcript 末条必须是 user/tool_result。

### 5.5 Outbox + Dispatcher
- run 三种结局：发消息 / 静默 / deferred 请求审批。
- dispatcher 轮询 outbox pending → 写 `data/outbox.log` + 控制台打印 + 更新状态；`DeliveryChannel` 接口预留 webhook/IM。
- **投递幂等**：dispatcher 按 `delivery_key` 投递，`markDelivered` 与投递在同一事务语义下处理，崩溃重放不重复发消息（对齐原文 outbox 的"recover from errors"价值）。
- Web UI 通过 `GET /outbox?userId=` 拉取消息展示；审批卡片带 approve/deny 按钮。
- 消息节奏：配置 `minIntervalMs` 做最小节流；文档建议"先安静"，默认不主动打扰，只在有结果或需审批时投递。evals 找节奏平衡点列 v2。

---

## 6. 运行时（pi 接入）与工具集

**pi 用法（已验证的 API）**：
- `new Agent({ initialState: { systemPrompt, model, tools }, streamFn, beforeToolCall, afterToolCall, toolExecution: "sequential" })`。
- `streamFn` 构造：`(model, ctx, opts) => models.streamSimple(model, ctx, opts)`（`models.streamSimple.bind(models)` 亦可）。
- `AgentTool` 必填 `name` / `label` / `parameters`（用 pi-schema 的 `obj/str` 构造）/ `execute`；可选 `replay: "never"|"safe"`、`executionMode`。副作用工具标 `replay:"never"` + 幂等键，防止重放重复执行。
- `agent.subscribe(e => ...)` 收集 assistant 文本与工具事件；`await agent.prompt(...)` / `await agent.continue()`；`agent.state.messages` 即 transcript，序列化进 `sessions.messages`。

**默认模型：本地 ollama**（按 pi 1.5.2 真实签名，已用本地源码验证）：
```js
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const model = {
  id: 'qwen3.5:4b',
  name: 'Qwen3.5 4B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768,
  maxTokens: 4096,
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
};
const ollama = createProvider({
  id: 'ollama',                 // 是 id，不是 provider
  baseUrl: 'http://localhost:11434/v1',
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [model],              // compat 写在 model 上，不写在 provider 顶层
  api: openAICompletionsApi(),  // ProviderStreams 对象，不是字符串
});
const models = createModels();
models.setProvider(ollama);
// models.getModel('ollama', 'qwen3.5:4b')
```
> 三个务必正确的点：`createProvider` 用 `id` 字段；`api` 是 `openAICompletionsApi()` 返回值；`compat` 在 model 级。开工 spike 先验证 `getModel(...)` 非空且能成功 `streamSimple` 一次。

模型 ID 走 config/env（`OLLAMA_MODEL`，默认 `qwen3.5:4b`）；`qwen3.5:0.8b`（1.0GB，已装）仅作可选实验，不进默认路径。

**faux 降级**（测试 / 无 ollama 时）：`fauxProvider()` + `createModels()`，取模型用 `faux.getModel()`。faux 队列式：每次请求 `shift()` 一个响应，队列空则报 `"No more faux responses queued"`。一个"用户消息 → tool_call → tool_result → 续答"至少消费 2 个响应，故 runtime 在 `tool_execution_end` 订阅事件里按需 `appendResponses([factory])` 续补，不能只补一个。集成测试必须覆盖 faux 下的多轮工具循环。

**Demo 工具集** v1 砍到 3 个（降低小模型选错工具概率，参数用字符串标量）：
| 工具 | 行为 | 参数 | 风险 |
|------|------|------|------|
| `get_time` | 返回当前时间 | `timezone?: string` | 低，allow |
| `set_timer` | 创建 follow-up | `seconds: string` | 低，allow |
| `send_external` | 模拟对外发邮件/发消息（带幂等键 = source_id） | `message: string` | **高，ask → deferred** |

`save_note`/`get_progress`/`call_protected_api` 等留接口，v1 不接小模型。用户自然语言："现在几点"→get_time；"30 秒后提醒我"→set_timer；"发邮件给老板"→send_external → 审批卡片。

---

## 7. HTTP 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/events` | 发事件（用户消息 / deferred_response）；返回 202 |
| GET | `/outbox?userId=` | 拉取投递消息（Web 轮询） |
| GET | `/events?userId=` | 调试：查看事件状态 |
| POST | `/timers` | 用户创建 schedule |
| GET | `/memory?userId=` | 调试：查看记忆 |
| GET | `/` | Web 测试界面 |

所有端点带最小入参校验；`userId` 默认 `default`。

---

## 8. Web 界面（最小可用）

单页、无构建工具（原生 HTML/CSS/JS）：
- 左栏：textarea + 发送按钮 → `POST /events`；可填 sourceId 演示去重；快捷按钮（时间 / 定时 / 发邮件）。
- 右栏：定时轮询 `GET /outbox`，时间线展示 agent 消息；审批类消息渲染成卡片，带"批准 / 拒绝"按钮 → `POST /events`（deferred_response）。
- 底部：状态条显示 worker / scheduler / dispatcher 是否在线。

---

## 9. 测试策略（node:test）

- **spike（准入门禁，先于业务代码）**：① ollama `getModel` + `streamSimple` 连通；② 4b 真实 tool_call 合法率（10 次"现在几点"）；③ deferred 四步恢复链路。
- 单测：事件去重（复合唯一）、lease 崩溃重放、批量合并、单 worker 锁、timer 到期推进（follow-up vs schedule）、memory 双写一致性、auto mode 分类、deferred 批准/拒绝双路径、outbox 幂等投递。
- **崩溃注入测试**：模拟 worker 在 run 中途挂掉，验证事件被回收重放、不死锁、副作用工具不重复执行。
- 集成：起真实服务 + SQLite 临时库，端到端 `POST /events` → worker → pi run（faux + ollama 各一遍）→ outbox → dispatcher；覆盖 timer 唤醒与 deferred 审批恢复；覆盖 faux 多轮工具循环。
- 手动：Web 发消息，观察闭环。

---

## 10. 实施顺序（spike 前置为准入门禁）

0. **准入 spike**：createProvider/getModel/streamSimple 连通；4b 工具调用合法率；deferred 恢复四步。任一不过 → 调整默认模型/工具集后再往下。
1. 骨架 + config + db + 表结构（含修正 AGENTS.md 的 Node 版本）
2. events + worker（lease/TTL + 单 worker 锁；先用桩 runtime 跑通 inbox→run→outbox）
3. model + tools + runtime（pi 接 ollama 4b；faux 降级与多轮补响应；transformContext 裁剪）
4. outbox + dispatcher + server + Web（端到端可见，投递幂等）
5. timers + scheduler
6. memory + 规则式 dreaming（单一写入门面）
7. permissions（凭证代理标注 + 规则分类器 + deferred 四步恢复 + 硬约束收尾）
8. 单测 + 集成测试 + 崩溃注入 + 手动验证闭环

---

## 11. 决策定稿（按推荐）

1. **模型**：默认 `qwen3.5:4b`；`0.8b` 降级可选实验；v1 工具集砍到 3 个、参数用字符串标量。理由：0.8B 多工具 function calling 不可靠是已知短板，4b 高一个量级；省掉"先 spike 再定"的往返。
2. **实现深度**：auto mode 分类器 = 规则式 + 可替换模型接口；dreaming = 规则蒸馏 + 可选模型摘要。不写"全实现"；真模型分类/梦境列 v2。
3. **deferred 硬约束**：run 必须在 deferred 处真正结束（toolExecution=sequential + 高风险批次单工具 / finishTurn={action:"end"}）、session 中途存盘、worker 才能处理别的事件；恢复按四步链路，批准/拒绝双路径单测。

**评审其余问题已在正文修复**：createProvider 三字段（§6）、复合唯一与 lease/TTL（§4/§5.1）、批处理与 deferred 边界（§5.1）、deferred session 恢复入口收窄（§5.1）、prompt injection run 内深校验（§5.1/§3）、session compact（§5.3）、凭证代理隔离标注（§5.4）、memory 单一写入门面（§5.3）、instructions 录入（§5.3）、outbox 投递幂等（§5.5）、streamFn/AgentTool 必填字段（§6）、faux 多轮补响应（§6）、副作用工具幂等（§6）、术语区分（§2）、evals/prompt caching 列 v2（§5.5/§1）、scheduler 备选 durable engine（§5.2）。

> 设计已定稿。回复"开工"即开始编码；要改哪条直接说。
