# always-on-agent 设计文档 v4

> 目标：按 Anthropic《Building always-on agents》实现一套可运行的常驻 agent，agent loop 运行时用 pi（`@earendil-works/pi-*`），外围自建五个持久原语。
> 状态：v4 已按 v3 独立评审修订，首版代码已落地，运行验收待执行。
> 版本说明：v4 补齐 timer 生效、审批失败退出、记忆写入接管和 session 换代规则，并统一 API 与验收口径。pi 接入验收仍以 §9 spike 为准。

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

附加约束：运行时为 Node.js ≥ 22.19 / ESM，pi 锁定 1.5.2，验收计划采用 Node 内置 `node:test`。
运行环境前提：ollama 已装但服务当前未启动；启动时探测 `localhost:11434`，未起则提示 `ollama serve` 并切换到 faux。设置 `MODEL_PROVIDER=faux` 可直接选择降级模式。

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
  memory.js          四类记忆的**单一写入门面**（原子替换文件 + 可重建索引）；加载与写回；上下文裁剪
  permissions.js     auto mode 规则分类器（可替换接口）、credential proxy、deferred 请求的持久与恢复
  outbox.js          outbox 表 + dispatcher（file/log/console，按渠道定义投递保证，接口预留 webhook/IM）
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
| `events` | id, user_id, source, source_id(NOT NULL), type, session_id, payload(JSON), status(pending/processing/waiting_approval/done/failed), attempts, batch_id, locked_by, lock_epoch, lease_until, created_at, updated_at | inbox；**复合唯一 `(user_id, source, source_id)` 去重**（原文建议 per-user inbox，避免跨用户 source_id 碰撞）；带 lease 实现崩溃重放 |
| `sessions` | id, user_id, version, status(active/deferred/closed), messages(JSON=pi transcript), created_at, updated_at | 保存 pi 的 session，支持跨 run 续接与 deferred 中途恢复；超长时按 §5.3 裁剪 |
| `timers` | id, user_id, kind(follow_up/schedule), due_at, recurrence(JSON), payload(JSON), status(pending/done), session_id, created_at | follow-up 由 agent 设、schedule 由用户设；recurrence 为空（一次性）或 `{everySeconds}`（正整数秒） |
| `deferred_requests` | id, batch_id, session_id, user_id, tool_call_id, tool_name, args(JSON), decision(pending/approved/rejected), execution_state(waiting/result_saved), operation_key(唯一), result(JSON), created_at, resolved_at | 审批决定、执行进度和工具结果独立持久化 |
| `outbox` | id, user_id, kind(message/approval/notice), payload(JSON), delivery_key(唯一), status(pending/delivered/failed), created_at, delivered_at | 发件箱；Web 按 delivery_key 展示唯一消息，其他渠道见 §5.5 |
| `mem_index` | user_id, category, path, summary, updated_at | notes/progress 的索引（文件内容存 `data/memory/`，索引入 DB 便于加载）；由 memory.js 从文件生成，可重建 |

补充表：`worker_lock` 持久记录互斥锁、单调递增 epoch 和租约截止时间。`batches` 保存稳定 batch_id、按序事件 ID、固定 session_id、起始 session 版本及 processing/deferred/done/failed 状态。`operations` 记录需要跨重试去重的副作用，保存稳定操作键及结果。`memory_updates` 保存唯一更新键、用户、变更内容及应用状态。

Memory 采用**文件目录**为真相（对齐文档：`instructions.md`、`index.md`、`reported.md` + `notes/`、`progress/`），`mem_index` 只加速索引。所有状态存 SQLite/文件，worker 重启后 memory 与 session 都还在。

---

## 5. 五个原语的关键设计

### 5.1 Event inbox

**三个组件**（对齐原文）：
1. **持久化的事件列表**：`events` 表（见 §4），每个事件追加为一行，带 status 与复合唯一 `(user_id, source, source_id)` 去重。
2. **handler**：HTTP 端点 `POST /events`（`server.js`），把事件写入该列表。
3. **worker**：后台服务（`worker.js`），从该列表读取并处理。

**认领与批次**：HTTP 在 SQLite 提交后返回 202，唤醒只是提示，轮询从 inbox 取实际状态。按用户与明确指定的 session 分组，无 session 的普通消息可合为一批并分配新 session。审批事件独立成批。普通批次在首次认领前按 §5.3 选择 session。首次认领事务验证所选 session 版本，并持久保存批次成员、顺序和 session。重试使用原批次及原输入版本，run 期间新增事件进入下一批。按最早可处理事件选批，限制单批大小与重试次数，超限标记失败并记录原因。

**租约与接管**：每次获得过期 worker 锁时递增 epoch。认领、续租及提交均校验所有者和 epoch。旧 epoch 无权提交，即使旧进程在新 worker 接管后恢复。提交事务同时验证批次事件认领、有效租约及预期 session 版本。接管优先恢复该 session 未完成的原批次。v1 模拟操作的恢复遵循 §5.4。

**提交边界**：一次 SQLite 事务保存 session 版本与 transcript、最终消息或审批卡片、审批记录、该 run 的 timer 草稿和批次及事件状态。正常完成时事件标 done。遇到审批时整批标 deferred，事件保留 batch_id 并标 waiting_approval。批准或拒绝后的续跑提交再将原批与续跑批完成。若续跑再次要求审批，则原批保持挂起、新审批关联原批，本次审批事件完成。提交前崩溃重放原批，提交后从已提交状态继续。只有归属匹配的审批事件能恢复 deferred session。普通消息与 timer 事件留在 inbox，等待该 session 解挂，其他 session 可继续工作。

**审批续跑终止**：重试耗尽或必需上下文超限时，在同一事务将原批、续跑批及其关联事件标 failed，关闭 session，写入失败通知，保留已有审批及工具结果供查询。后续普通消息与 timer 事件按 §5.3 路由到新 session。失败通知说明已保存的审批执行结果，避免用户误以为操作未发生。

### 5.2 Timers + Scheduler
- 独立 `timers` 表；inbox 只放"现在就能干"的事件。
- `set_timer` 工具让 agent 在 run 内生成 follow-up 草稿（如"30 秒后检查回复"）；Web 端点 `POST /timers` 让用户建 schedule（如每天某时）。
- scheduler 在一个 SQLite 事务内读取到期 timer、以 timer ID 与原定 due_at 生成稳定 source_id、写 inbox 并标完成或推进下次时间。提交后唤醒 worker。周期 timer 停机期间的多个到期合并为一次，下一次按原始周期推进到当前时间之后。
- v1 支持一次性 timer 和 interval recurrence（`{everySeconds}`），时间以 UTC 存储，间隔须为正整数秒。cron 列入后续版本。

### 5.3 Memory
- 每次 run 开头加载：`instructions.md`（用户指令）、`index.md`（notes/progress 索引）、`reported.md`（已告诉用户的内容，防重复）——保持精简，控制上下文开销。
- notes/progress 文件和摘要由 runtime 管理。v1 每次从索引选取有限条相关摘要及正文并注入上下文，完整内容的按需读取工具留到后续版本。
- **写入门面**：同一 SQLite 写事务充当跨进程互斥锁。memory.js 在 `BEGIN IMMEDIATE` 后校验当前 epoch、重新读取文件、合并一条待应用更新并同步原子替换文件，再更新索引及完成标记后提交。worker 接管也必须获得该写锁，因此不能在文件替换期间发布新 epoch。锁内仅做有界的本地文件与 SQLite 操作。进程崩溃释放数据库锁，已替换的文件按稳定更新键幂等重放。启动时及加载前可在同一互斥机制下重建 mem_index 和 index.md。
- 用户指令录入：`instructions.md` 由管理员直接编辑文件（不提供 agent 工具写入，防止自改指令）；或后续加 config 入口。
- 写入时机：run 提交时在同一 SQLite 事务记录待应用的记忆更新，按批次与更新类型生成稳定键。runtime 在下一次加载前应用待更新记录，以确定性文件路径或条目 ID 合并，文件写完后再标完成。`reported.md` 只从已提交的用户可见消息生成。v1 按明确的用户记忆指令提取事实，供后续 run 使用。
- 只存不可再查到的信息；已有系统的东西存指针（system prompt 里明确此规则）。
- **上下文管理**：sessions 表存完整 transcript，但用 pi 的 `transformContext` 钩子做基于 token 估算的旧消息裁剪（compact），保留完整工具调用与结果组以及待恢复审批关联消息；普通批次首次认领前估算 system prompt、工具、memory、事件输入和回复预算。裁剪仍超预算时，先按记忆写入协议保存关键点，再在认领事务中关闭旧 session，为该批选择新 session。明确引用已关闭 session 的普通消息和 timer 事件进入新会话，保留原引用供追溯。选定后重试沿用原绑定。审批续跑固定使用原 session，裁剪时保留审批所需的调用及结果组。必要内容仍超预算时按 §5.1 终止。
- **Dreaming**（v1 规则式）：由 schedule timer 周期性触发（默认关闭，配置开启），规则式蒸馏/替换过时 notes、发现跨 run 模式，可选接模型做摘要（接口预留）。真模型梦境列 v2。

### 5.4 Permissions
- **Credential store + proxy**：凭证存 `data/credentials.json`（或 env），由 proxy 在工具发请求时注入，agent 与 transcript 永不接触明文。**诚实标注**：v1 凭证与 proxy 同进程、同文件系统，是演示级隔离，不是生产安全模型；生产需独立进程/独立凭据域。
- **Auto mode 分类器**（v1 规则式）：`classifyRisk(toolName, args)` → allow / ask / block，用高风险工具名/参数黑名单；接口留好接真实模型分类器。block 直接拦截，ask 走 deferred。
- **挂起**：beforeToolCall 命中 ask 时，由应用层记录本次唯一审批候选并拦截该调用。同一轮工具批次中候选后的调用全部拦截，已经执行的调用保留结果。收尾钩子结束 run，保存完整工具结果组。sequential 用于逐个检查，实际钩子调用顺序、阻断和停止语义由 §9 spike 验证。审批请求、session 和卡片按 §5.1 一起提交。
- **决定**：在事务中按 request ID 读取记录并校验归属。已有相同决定时返回原受理结果，相反决定返回 409。仅对仍匹配当前挂起 session 和批次的 pending 记录写入首个决定，同时创建唯一审批事件。
- **执行**：拒绝时持久保存拒绝结果。批准时只执行审批记录中冻结的工具与参数，使用持久 operation_key，经同一受控执行入口校验当前授权。执行成功后先保存结果，再继续模型。v1 仅执行下述 SQLite 模拟操作。接入真实外部渠道时另行定义结果未知时的查证、人工确认与续跑协议。
- **续跑**：从持久结果重建 transcript，用原 tool_call_id 替换挂起结果，保留同批其他工具结果，再创建 Agent 并调用 continue()。若工具结果已保存，重试仅复用结果。批准只授权这一次既有调用，后来生成的工具调用重新分类。
- **v1 副作用**：`set_timer` 返回本次 run 的内存草稿标识。同一 run 内相同规范化参数合并为一个草稿，草稿在 run 提交为 done 或 deferred 时同事务写入可调度 timer，due_at 以激活时刻为基准。提交前崩溃或批次失败时丢弃尚未激活的草稿。已提交的草稿随所属 run 留存，审批续跑失败时也保留。模拟 `send_external` 使用 request ID 去重，在校验 epoch 的同一 SQLite 事务保存模拟操作及审批工具结果，再继续模型。

### 5.5 Outbox + Dispatcher
- run 三种结局：发消息 / 静默 / deferred 请求审批。
- dispatcher 轮询 outbox pending → 写 `data/outbox.log` + 控制台打印 + 更新状态；`DeliveryChannel` 接口预留 webhook/IM。
- **投递保证**：Web 直接读取已提交的 outbox 行，按 delivery_key 去重呈现。日志与控制台采用至少一次尝试，崩溃后可能重复，输出携带 delivery_key。持续失败按配置重试并记录终止错误；后续渠道按接收端是否支持幂等键定义保证。
- Web UI 通过 `GET /outbox` 拉取消息展示；审批卡片带 approve/deny 按钮。
- 消息节奏：配置 `minIntervalMs` 做最小节流；文档建议"先安静"，默认不主动打扰，只在有结果或需审批时投递。evals 找节奏平衡点列 v2。

---

## 6. 运行时（pi 接入）与工具集

**pi 用法（已验证的 API）**：
- `new Agent({ initialState: { systemPrompt, model, tools }, streamFn, beforeToolCall, afterToolCall, toolExecution: "sequential" })`。
- `streamFn` 构造：`(model, ctx, opts) => models.streamSimple(model, ctx, opts)`（`models.streamSimple.bind(models)` 亦可）。
- `AgentTool` 必填 `name` / `label` / `parameters`（用 pi-schema 的 `obj/str` 构造）/ `execute`；可选 `replay: "never"|"safe"`、`executionMode`。副作用工具标 `replay:"never"`，跨进程重放按 §5.4 的持久操作键处理。
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

**faux 降级**（测试 / 无 ollama 时）：`fauxProvider()` + `createModels()`，取模型用 `faux.getModel()`。faux 队列式：每次请求 `shift()` 一个响应，队列空则报 `"No more faux responses queued"`。一个"用户消息 → tool_call → tool_result → 续答"至少消费 2 个响应，故每次模型请求前按需调用 `appendResponses([factory])`。集成测试必须覆盖 faux 下的多轮工具循环。

**Demo 工具集** v1 砍到 3 个（降低小模型选错工具概率，参数用字符串标量）：
| 工具 | 行为 | 参数 | 风险 |
|------|------|------|------|
| `get_time` | 返回当前时间 | `timezone?: string` | 低，allow |
| `set_timer` | 创建 follow-up | `seconds: string` | 低，allow |
| `send_external` | 模拟对外发邮件/发消息（按审批 operation_key 去重） | `message: string` | **高，ask → deferred** |

`save_note`/`get_progress`/`call_protected_api` 等留接口，v1 不接小模型。用户自然语言："现在几点"→get_time；"30 秒后提醒我"→set_timer；"发邮件给老板"→send_external → 审批卡片。

---

## 7. HTTP 端点

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/events` | 发事件（用户消息 / deferred_response）；返回 202 |
| GET | `/outbox` | 拉取投递消息（Web 轮询） |
| GET | `/approval-status?id=…` | 更新审批卡片状态 |
| GET | `/status` | 查询运行状态与模型提供方 |
| GET | `/events` | 调试：查看事件状态 |
| POST | `/timers` | 用户创建一次性或正整数秒间隔 schedule |
| GET | `/memory` | 调试：查看记忆 |
| GET | `/` | Web 测试界面 |

所有端点仅监听 loopback（v1 单用户），服务端固定身份 `default`，客户端提供的身份字段拒收，事件来源由服务端按入口分配。Web 写请求校验 Host 和同源 Origin，仅收 JSON，禁用跨域授权。无 Origin 的本地脚本写请求须携带启动时生成的本机令牌。审批和 session 引用仍须校验记录归属。普通事件必须提交非空 sourceId。相同来源及 sourceId 的相同请求返回原事件，复用该键提交不同内容返回 409。

---

## 8. Web 界面（最小可用）

单页、无构建工具（原生 HTML/CSS/JS）：
- 左栏：textarea + 发送按钮 → `POST /events`；每次新发送生成 sourceId，重试沿用同一 ID，可手动指定 ID 演示去重；快捷按钮（时间 / 定时 / 发邮件）。
- 右栏：定时轮询 `GET /outbox`，时间线展示 agent 消息；审批类消息渲染成卡片，带"批准 / 拒绝"按钮 → `POST /events`（deferred_response）。
- 底部：状态条显示 worker / scheduler / dispatcher 是否在线。

---

## 9. 测试策略（node:test）

- **spike（准入门禁，先于业务代码）**：要求 Ollama 连通，并用固定配置在 10 个独立会话中发送「现在几点」。至少 9 次须生成且执行一次通过 schema 校验的 `get_time`，并在读到工具结果后给出答复。批准与拒绝续跑须各自通过。用 faux 构造同一轮候选前后均有工具的情况，验证拦截顺序、run 退出、批准与拒绝 transcript，以及真实 Ollama 可消费恢复后的消息。
- 单测：事件去重（复合唯一）、lease 崩溃重放、批量合并、单 worker 锁、timer 到期推进（follow-up vs schedule）、memory 索引重建及重复应用、auto mode 分类、deferred 批准/拒绝双路径、outbox Web 去重及日志重试。
- **崩溃注入测试**：覆盖 SQLite 提交前后、旧 worker 在新 epoch 接管后恢复、审批决定写入后、工具结果保存后、审批续跑重试耗尽、timer 草稿提交前崩溃后重放改参数及批次最终失败、timer 推进，以及旧 worker 暂停在记忆文件替换前的接管竞争。另覆盖审批回包丢失与相反决定并发、缺省 sourceId、普通会话换代及审批上下文超限。验证不漏掉 timer 和已提交消息，副作用按渠道约定恢复。
- 集成：起真实服务 + SQLite 临时库，端到端 `POST /events` → worker → pi run（faux + ollama 各一遍）→ outbox → dispatcher；覆盖 timer 唤醒与 deferred 审批恢复；覆盖 faux 多轮工具循环，并验证用户明确要求保存的事实能在新 session 中被读取。
- 手动：Web 发消息，观察闭环。

---

## 10. 实施顺序（spike 前置为准入门禁）

0. **准入 spike**：createProvider/getModel/streamSimple 连通；4b 工具调用合法率；deferred 停止与续跑。任一不过 → 调整默认模型/工具集后再往下。
1. 骨架 + config + db + 表结构（含迁移与唯一约束）
2. events + worker（lease/TTL + 单 worker 锁；先用桩 runtime 跑通 inbox→run→outbox）
3. model + tools + runtime（pi 接 ollama 4b；faux 降级与多轮补响应；transformContext 裁剪）
4. outbox + dispatcher + server + Web（端到端可见，按渠道验证投递保证）
5. timers + scheduler
6. memory + 规则式 dreaming（单一写入门面）
7. permissions（凭证代理标注 + 规则分类器 + deferred 停止、执行与续跑）
8. 单测 + 集成测试 + 崩溃注入 + 手动验证闭环

---

## 11. 决策定稿（按推荐）

1. **模型**：默认 `qwen3.5:4b`；`0.8b` 降级可选实验；v1 工具集砍到 3 个、参数用字符串标量。理由：0.8B 多工具 function calling 不可靠是已知短板，4b 高一个量级；省掉"先 spike 再定"的往返。
2. **实现深度**：auto mode 分类器 = 规则式 + 可替换模型接口；dreaming = 规则蒸馏 + 可选模型摘要。不写"全实现"；真模型分类/梦境列 v2。
3. **deferred 硬约束**：按 §5.4 验证真正结束 run、原批挂起及批准／拒绝续跑，执行结果独立持久化。

**v4 验收重点**：§5.1 的提交与接管、§5.4 的审批状态机，以及跨 SQLite、文件和投递渠道的恢复行为。

> 本稿已纳入 v3 独立评审发现。§9 保留为后续运行验收计划。
