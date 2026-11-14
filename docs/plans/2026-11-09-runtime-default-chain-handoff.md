# 新链默认化交接（2026-11-09）

> 生命周期：**历史交付快照**。下文“代码未提交”描述交接当时；该文档随提交 `2a528311`（`feat(runtime): 新 runtime 链默认化与提示词/归属对齐`）进入仓库。当前是否又有 WIP、各入口默认值和验收范围仍须看当前 Git、源码与测试，不继承当时状态。

状态：四条入口已全部默认走 `packages/agent-runtime` 新链，旧编排器保留为回滚路径。
代码未提交，工作树里同时有你的其它并行改动。

---

## 1. 回滚（先看这节）

任一变设置即整条入口回旧编排器，**不需要 revert 代码或重新构建**（改完重启应用生效）：

| 入口 | 变量 | 回滚值 |
| --- | --- | --- |
| 桌面点发送 | `PROFER_RUNTIME_DESKTOP` | `0` |
| 飞书 / push（headless） | `PROFER_RUNTIME_HEADLESS` | `0` |
| 定时任务 | `PROFER_RUNTIME_AUTOMATION` | `0` |
| 手机端 Pocket（remote） | `PROFER_RUNTIME_REMOTE` | `0` |

全部回滚：

```bash
export PROFER_RUNTIME_DESKTOP=0
export PROFER_RUNTIME_HEADLESS=0
export PROFER_RUNTIME_AUTOMATION=0
export PROFER_RUNTIME_REMOTE=0
```

判断口径：**枚举的是「关闭」，不是「开启」**。未设置 = 新链，只有精确的 `0` 才回旧链，
`false` / 空串都不会关闭。

Goal 相关输入无论开关如何都走旧链（回调面没下沉，见 §5）。

---

## 2. 这次改了什么

按问题组织，不是按文件。

### 2.1 提示词与上下文（S1）

新链原来把用户消息直接当系统提示词、也没有动态上下文。现在复用旧链**同一份**
`assembleAgentSystemPrompt`，不复制提示词文本：

- 系统提示词：策略快照 + 会话元数据 + 工作区 + 模型 → 同一 builder；
- 用户消息侧依次拼：运行来源 → `@` 工具（按**实际加载**的 MCP 过滤）→ `@` 会话 → 动态上下文 → 历史回填；
- 历史回填与 resume 互斥（有 `runtimeSessionId` 时不回填，否则模型看到两份时间线）；
- 动态上下文放 user 侧而不是 system，保证 system 前缀稳定（Claude prefix cache）。
- Pi 的提示词要等工具装配完才能定型，走 `resolvePromptForTools(toolNames)` 延迟计算，绝不描述未注册的工具。

### 2.2 文件回退归属（S2）

- 写入证据规则收敛成一份 `workspace-shadow-write-evidence.ts`，新旧两条链共用（否则同一写入会判出不同来源，回退的合并方向就反了）；
- 新链 run 前 `beginWorkspaceShadowTurn`、终态 `finally` 里 `endWorkspaceShadowTurn`；
- 证据来源：assistant `tool_use` + Pi 受控写回调，草稿区（会话私有存储）不计入。

### 2.3 杂项对齐（S3）

- `/compact` 原样透传（包上上下文就变成普通文本了）；
- light 模式：新会话无上下文的短问候走精简 system，不拼动态上下文/引用/历史，资源端口不加载 MCP / Skill；
  只有 light 才写 `promptMode` 字段，standard 的 metadata 形状零变动；
- skill catalog：Pi 会拿到 `<skill_catalog>`（Claude 由 SDK 自己发现，与旧链一致）。

### 2.4 默认链翻转（S4）

四个开关的默认值从「opt-in」改成「默认开、显式 0 关闭」。

### 2.5 验收中发现并修掉的 4 个问题

这几条决定你该重点测什么。

**① `permissionModeOverride` 在新链里丢失（阻断级）**

- 现象：Agent 调 Write 后永久停在「等待批准」；
- 三层原因：入口没把字段传进 query → 权限服务本身不看模式（只区分只读/其它）→ Pi 工具是本地包装，
  装了 `canUseTool` 就一定回调（Claude SDK 在 bypass 下会自己跳过，Pi 不会）；
- 影响面：定时任务、飞书 bridge **本来就显式传了 bypass**（注释写着「否则无人值守时写操作会因权限弹窗永久阻塞」），
  一旦切新链就会死锁；
- 修复：入口透传 + 权限端口加 `isBypassPermissions` 短路（bypass 直接 allow 且不产生审批请求）+ Pi 在 bypass 下不装 `canUseTool`。

**② 消息气泡里的文件改动 chip 没有消费者**

旧链会把「这个 tool_result 写了哪些文件」挂到 block 的 `proferFileChanges` 上随消息落盘，
渲染层据此出 chip，历史回放也靠它恢复。新链没有这段。
修复：新增 `agent-file-write-chips.ts`，在 `provider-bridge` 的唯一出口装饰消息，桌面与 headless 同时生效。

**③ 回退后「文件改动」面板残留**

面板读的是渲染层内存累积表，全仓没有清理点 —— 文件删了它还写着「新建」。
与新旧链无关，两条链都有。修复：回退成功后按 `deleted` / `restored` 剔除，`conflicts` 保留。

**④ 工作区名取不到**（S1 验收中修）：`workspaceName` 只看了 `input.workspaceId`，
改为同时看会话元数据，否则动态上下文里不出现「工作区: xxx」。

---

## 3. 验收清单

### 3.1 桌面（重点）

每条都给了「失败时先看什么」，方便你一句话定位到我这边。

| # | 操作 | 期望 | 失败先看 |
| --- | --- | --- | --- |
| 1 | 新会话发一句普通消息 | 流式正常、无重复、无空白气泡 | 会话是否已结束、是否有 `waiting` 的 run |
| 2 | 新会话只发「你好」 | 回复很快，不走工具 | 这是 light 模式，属预期 |
| 3 | 同一会话再问一个需要上下文的问题 | 记得上一轮内容（动态上下文回来了） | 第二轮是否仍是 light |
| 4 | 让它写一个文件（**project 模式工作区**） | 消息气泡里出现文件改动 chip | 写入路径是否落在会话目录（§5 第 1 条） |
| 5 | 生成中途点停止 | 状态收束，不残留「生成中」 | 是否有 pending 审批卡住 run |
| 6 | 回退到会话开始 | 文件消失 + 右侧「文件改动」清空 + 会话里出现回退提示 | 面板是否残留（②的回归） |
| 7 | 回退后继续发消息 | 模型知道「上一轮被回退」，不会假装没发生 | notice 是否注入到下一轮提示词 |
| 8 | 一次写多个文件的重活 | 归属全部 `confirmed`，没有莫名 `unconfirmed` | 用 `/attributions` 看每轮 changes |
| 9 | 跑完一轮后看会话列表 | 未读计数正确 | `forwardHeadlessAgentCompletion` |
| 10 | 给会话挂一个附加目录，让它在那里写文件 | 归属记录里的路径正确 | 附加目录是否进了 shadow baseline |
| 11 | **bypass 会话里让它写文件** | 不应弹审批，直接执行 | 本次修复的核心，若弹了立刻告诉我 |
| 12 | **默认/auto 会话里让它写文件** | **应该**弹审批（不能变成全放行） | 安全回归，若没弹立刻告诉我 |

第 11、12 是一对：修 bypass 死锁时最容易把「该问的也不问了」，这条必须验。

### 3.2 飞书

发一条需要写文件的指令 → 有回复、不卡审批、文件真的写出来。
失败先看：会话是否停在 `waiting`；那说明 bypass 没生效。

### 3.3 定时任务

手动触发一次 → 有 run 记录、状态 success、文件写入成功。
失败先看：`agent-runs.json` 里该 run 的 `status` 是不是 `waiting`。

### 3.4 手机端 Pocket

手机上发一条 → 收到完整回复（不是只有「执行出错」）。

> 3.2–3.4 我没有真机验证过，只有单测和桌面/headless 的真机证据。它们走的是同一个
> `runAgentRuntimeHeadless`，风险主要在各自的入口投影，不在链本身。

---

## 4. 怎么判断走的是哪条链

两条链的提示词、工具、事件格式都一样，肉眼看不出来。可靠的判断方式只有两种：

1. **对照法**：同一个操作，设 `PROFER_RUNTIME_DESKTOP=0` 再跑一次，行为若不同说明确实切过去了；
2. **看归属/提示词产物**：新链的 turn 归属由 Shadow Git 产生（`/attributions` 有 `beforeCommitId`/`afterCommitId`），
   并且 light 模式下系统提示词是精简版。

不要用「日志里有没有某句话」判断 —— 大量日志（工具注入、会话对账）是两条链共用的。

---

## 5. 已知边界（别当 bug）

1. **managed 模式下看不到文件 chip**：写会话目录属于草稿区，按既有语义过滤，旧链也一样。
   要看 chip 请在 project 模式工作区里写项目文件。
2. **Bash 写入归属是 `unconfirmed`**：从命令行文本猜路径会把非受控改动伪装成受控写入，所以不猜。
   旧链对照同样 `unconfirmed`，不是回归。
3. **两个测试失败与我无关**：`remote-service-send-message.test.ts` 里「缺省时不出现 uuid」的两条，
   原因是你在 `remote-service.ts` 里改成缺省生成 `uuid`（`randomUUID()`），测试断言还没更新。要不要改测试你定。
4. **S3.1 未做**：`routeSkillsForTask` 的任务级选型提示没下沉。当前模型能看到完整 catalog 并自己读 SKILL.md，不影响使用。
5. **Goal 输入仍走旧链**（GAP-6）。
6. **automation / remote 两条入口没有真机验证**，只有单测覆盖路由与 fixture 行为。
7. **代码未提交**。

---

## 6. 改动位置

### 6.1 新增

```text
apps/electron/src/main/lib/agent-runtime-turn-prompt.ts        系统提示词装配映射
apps/electron/src/main/lib/workspace-shadow-write-evidence.ts   写入证据规则（两链共用）
apps/electron/src/main/lib/agent-file-write-chips.ts            文件改动 chip 账本
apps/electron/src/main/lib/debug-channel.ts                     调试通道（7791）
docs/plans/2026-11-09-runtime-default-chain-plan.md             分期计划与验收记录
+ 5 个测试文件（turn-prompt / entry-shadow / file-write-chips / desktop-switch / session-file-changes / pi-delayed-prompt）
```

### 6.2 修改（关键几处）

```text
agent-runtime-entry.ts               query 构造：透传 permissionModeOverride；turn 结束 dropSession
agent-runtime-host.ts                permission port 注入 isBypassPermissions（run facts + 会话元数据）
agent-runtime-provider-preparation.ts onFileWrite 始终注册 + 草稿区过滤
agent-runtime-permission-port.ts     bypass 短路
agent-service.ts                     开关默认值 + adapter 出口装 mapMessage
automation-scheduler.ts              开关默认值
remote-service.ts                    开关默认值
packages/agent-runtime/src/provider-bridge.ts      出口装饰器 mapMessage
packages/agent-provider-pi/src/pi-agent-adapter.ts bypass 下不装 canUseTool
renderer/components/agent/AgentView.tsx            回退后清面板记录
renderer/lib/session-file-changes.ts               dropRewoundSessionFileChanges
```

### 6.3 数据在哪

| 内容 | 路径 |
| --- | --- |
| 会话消息（managed） | `~/.profer-dev/agent-sessions/<sessionId>.jsonl` |
| 会话消息（project） | `<项目根>/.profer/sessions/<sessionId>/messages.jsonl` |
| 会话索引 | `~/.profer-dev/agent-sessions.json` |
| 运行账本 | `~/.profer-dev/agent-runs.json`（看 `status` / `waitingFor`） |
| Shadow Git | `~/.profer-dev/workspace-shadow/` |
| 调试通道 token | `~/.profer-dev/debug-channel.json` |

---

## 7. 出问题时给我什么

一条消息就够，包含：

1. 会话标题或 sessionId；
2. 你做了什么、看到什么（截图最好）；
3. 有没有设那四个环境变量；
4. 如果是卡住：告诉我 `~/.profer-dev/agent-runs.json` 里对应 run 的 `status` 和 `waitingFor`。

**卡在 `waiting` + `waitingFor.type === 'request'`** = 权限请求没人应答，优先怀疑 bypass 链路（§2.5 ①）。

调试通道（我复现时用，只监听本机、需 token）：

```text
GET  /health
GET  /sessions
POST /sessions           建会话（可带 permissionMode）
POST /send               发消息
GET  /attributions?sessionId=   每轮归属
POST /rewind             回退（{target:{kind:'session-start'},mode:'both',execute:true}）
POST /restore-shadow     还原单个 turn
```
