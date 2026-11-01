# 真实任务来源与会话派工设计

> 日期：2026-10-30（GMT+8）；基础模型修订：2026-11-01
> 状态：产品原则与轻量基础模型已在讨论中确认；本文合并为设计基线，剩余工程接入与验收要求不代表已实现。
> 范围：真实任务来源、Session/Task/Trigger/Run 基础契约、宿主无关的运行边界，以及同会话接续、子会话/独立会话派工、定时任务绑定。
> 非范围：无目标主动闲聊、跨设备执行、跨实例派工实现、新权限系统、自动扩大任务权限。
>
> 阅读顺序：第 2—6 节是产品行为；第 13—18 节是本轮收敛的基础设计、参考依据与验收要求。第 7 节只陈述已读取源码的事实，其他部分不得解释为现有能力。

## 1. 背景与目标

Profer 当前的对话记录主要围绕“用户输入 → 模型回应”组织。实际上，任务也可能由另一个模型会话提出，或由定时任务框架触发。如果这些任务仍然保存成普通用户消息，用户和后续模型就难以辨认：是谁写了任务、为何启动、依据什么授权。

本次设计让任务的真实来源成为产品事实，同时允许模型在获得任务授权后，自主决定工作如何组织：继续当前会话、委派子会话、创建独立工作会话，以及串行或并行执行。

目标体验：在一个会话中讨论并确认方案后，模型可以把工作交接给合适的执行者；执行者清楚知道任务来自哪个会话，用户可以追溯、接管和继续讨论。定时任务同样以框架触发的身份进入对话，不伪装成用户刚刚发送了一条消息。

## 2. 已确认的产品决策

以下内容来自本轮用户确认，是后续实现的约束。

| 事项 | 决策 |
|---|---|
| 讨论转执行 | 用户只要求讨论时，不自行扩展为实现；已有明确指令、父任务范围或持续任务依据时直接执行，不设置统一的批准前置流程。 |
| 基础建设 | 一次确定完整但轻量的事实模型；复用现有权限机制，不另建 Grant/Decision 等第二套安全系统。 |
| 宿主边界 | Runtime/Fabric 是可移植内核；Electron 只是宿主适配器，换壳不改变来源、运行和任务语义。 |
| 方案依据 | 先参考已有 Agent 的官方文档或源码，再结合 Profer 实现提出设计；外部事实与产品选择分别说明。 |
| 工作组织 | 任务获准后，模型自主决定当前会话接续、子会话或独立会话，以及串行或并行，不为组织方式增加固定确认步骤。 |
| 用户明确指定 | 用户指定会话或执行方式时优先遵循，不由模型静默覆盖。 |
| 默认承接位置 | 不规定所有任务默认留在原会话，也不规定必须新建会话。模型按任务判断，用户可主动指定。 |
| 手动创建定时任务 | 提供“在指定会话中执行”的勾选项；勾选后选择目标会话，后续按此绑定运行。 |
| 模型创建定时任务 | 模型自行判断会话安排，也自行决定是否询问用户；不设一律询问的流程。 |
| 智能判断开关 | 不新增一个要求用户选择的“智能判断”配置。没有明确指定的事项交由模型判断。 |
| 真实发起身份 | 模型派工记录为模型发起，定时触发记录为框架发起，不冒充用户消息。 |
| 权限边界 | 自主安排工作不产生额外授权，不扩大任务范围，不绕过现有能力与权限门禁。 |

“模型决定是否问用户”适用于未指定的会话安排等取舍。已有明确指令、父任务范围、定时任务持续依据或外部入口策略足够时直接执行；仅有讨论意图时，不自行扩展工作范围。是否需要具体操作确认，继续由现有权限与能力门禁判断。

## 3. 概念模型

### 3.1 会话、任务、触发与执行轮次

- **Session（会话）**：持续的上下文与用户可阅读记录；不是 Electron 窗口或 Provider 原生 Session ID。
- **Task（任务，可选）**：需要持续跟踪的工作目标，保存来源与父子关系；普通聊天不强制建 Task。
- **Trigger（触发）**：一次输入或调度事件，解释为什么启动、继续或恢复执行。
- **Run（执行轮次）**：一次逻辑执行过程，包含模型/工具循环、内部重试与恢复，不等于一次模型请求或一个进程。

一个 Session 可以承载多个 Task 和 Run；一个 Task 可以由多个 Run 推进。新触发不必一律新建 Run：追加输入与恢复可关联已有 Run，已结束后重新执行才建新 Run。模型循环的 Provider Turn 不作为 Profer 顶层对象。详细字段和边界见第 13 节。

### 3.2 分别保存作者、触发者和授权依据

| 概念 | 回答的问题 | 例子 |
|---|---|---|
| 消息作者 | 谁产生了这段内容？ | 用户、来源会话中的 Agent、任务框架。 |
| 运行触发者 | 谁导致这一轮开始？ | 用户发送、会话派工、定时调度。 |
| 授权依据 | 为什么允许做这件事？ | 用户消息中的首肯、创建定时任务时授予的持续授权。 |
| 执行者 | 由谁完成工作？ | 某个 Agent 实例及其岗位预设、模型。 |

例如：用户批准方案；讨论会话中的 Agent 编写交接任务；框架创建执行会话并启动工程 Agent。用户是授权者，不因此成为交接正文的作者。

作者身份应能定位到来源会话和相应消息或运行。模型型号可作为执行信息，但不宜单独充当作者身份，因为同一会话可能切换模型。

### 3.3 归属、并发和权限是不同维度

| 维度 | 可表达的含义 |
|---|---|
| 承接位置与归属 | 当前会话、附属于原任务的子会话、独立工作会话。 |
| 执行组织 | 串行、并行、前后依赖。 |
| 工作权限 | 调研、读取、修改、验证，以及现有门禁约束的其他行为。 |

“并行会话”是一种运行安排，不是与子会话、独立会话互斥的第三类归属。子会话和独立会话都可能并行。

子会话不等于只读，独立会话也不天然拥有修改权限。用户提到子会话通常承担调研，是使用倾向，不应固化成权限判断。

## 4. 工作组织与用户交互

### 4.1 讨论后派工

1. 讨论会话形成可执行的目标、方案和范围。
2. 使用已有明确执行指令或其他有效启动依据；只有尚未获得执行意图时才确认，不重复批准。
3. 模型自主决定承接位置、执行岗位及串并行关系。
4. 框架检查现有权限和能力，生成真实来源记录并启动工作。
5. 原会话留下任务交接与去向；承接处显示来源，结果可追溯。

不增加“模型决定拆成几个任务后，再请用户批准拓扑”的固定流程。模型可以用一句话告知安排，然后执行；用户可以纠正。用户主动指定“就在这里做”或“开新会话”时，遵从该指定。

### 4.2 当前会话内接续或委派

同一条可见时间线允许不同执行者接手工作，或承载子任务的进度与结果。需要明确显示是谁在执行，避免用户把不同执行者误认为同一主体。

建议采用“可见时间线统一、执行上下文按任务隔离”的实现方向：子 Agent 获取必要交接材料，完整过程保留在任务执行记录中，原会话展示交接、关键进度和结果。是否把全部工具过程展开，由后续交互设计确定，不要求为了保留记录而新增侧栏会话。

同会话内有多个任务时，消息和工具结果必须关联到对应任务与运行，不能交叉拼接。多个执行者修改同一项目时，仍需处理文件冲突；少开会话不等于消除了并发冲突。

### 4.3 子会话与独立工作会话

- **子会话**：主要服务原任务的某项分工，结果由原任务接收；保留父子关系。
- **独立工作会话**：可以被用户单独跟进和持续推进；保留来源链接，但不因为存在来源就被当作子会话。

建议独立工作会话不随来源会话的普通停止操作级联取消。子任务的取消与父任务停止、会话停止之间如何对应，应在实现前明确，不能把“停止本轮生成”误当成取消全部关联工作。

## 5. 定时任务

### 5.1 用户手动创建

创建界面增加一个明确能力：

```text
☑ 在指定会话中执行
  目标会话：[选择会话]
```

勾选时，保存并遵循目标会话绑定；未勾选时，不强行解释为“每次新建”“固定专属会话”或“必须询问”。其余行为接入现有任务创建与路由规则，后续实现时核对现状。

本轮未确认“固定专属会话 / 每次新建 / 智能判断”的完整设置矩阵，不应顺带加入这些产品选项。

### 5.2 模型自主创建

模型可根据任务目的、上下文连续性和已有会话选择运行位置，也可在必要时询问用户。是否询问由模型判断，不要求每次确认会话绑定。

“自主创建”仍须处于用户授权的任务范围。例如用户已要求“每周汇总一次进展”，模型可以安排定时执行；不能仅因为技术上能创建任务，就把一次性讨论自行扩展为长期执行授权。

### 5.3 后续触发

每次运行均记录对应定时任务及本次触发身份。用户设置任务时授予的持续授权可覆盖约定范围内的后续运行，无需每次重复首肯。

任务绑定到指定会话时，框架将本轮工作路由到该会话，并显示真实触发来源。会话忙碌、被删除、权限变化等异常不能静默改变用户绑定，处理原则见第 9 节。

## 6. 来源消息的呈现

以下是说明信息关系的文案示例，不是最终 UI 稿。

模型派工：

```text
任务交接 · 来自「会话发起机制设计」
发起者：研发统筹 Agent
授权依据：用户已同意按方案执行
任务：实现已确认的第一阶段方案……
[查看原讨论] [查看确认记录]
```

定时触发：

```text
定时任务 · 每周项目进展
触发时间：2026-10-30 17:00
任务：汇总本周进展及未完成事项
[查看任务]
```

真实来源应进入持久化记录，并被会话展示、搜索、导出及后续模型读取共同使用，不能只更换头像或标题。引用源被删除时，保留可理解的来源摘要并标明不可访问，不伪造链接或身份。

## 7. 当前代码中已核对的基础

以下是本轮有限源码核对的事实，不是全链路审计。

| 位置 | 已核对事实 | 对本设计的影响 |
|---|---|---|
| `packages/shared/src/types/agent.ts` | 存在 `AgentRunInitiator`，用于未读行为；包括 user、automation、external、goal、delegation。 | 已有运行来源信号，但注释明确其产品口径是未读产生与清除，不能直接当作完整作者模型。 |
| 同上，`AgentSendInput` | 有 `userMessage`、`initiator`，并存在 Goal 内部提示入口。 | 真实来源与 Provider 输入可逐步解耦，具体契约需要设计。 |
| `apps/electron/src/main/lib/agent-collaboration-tools.ts` | `startDelegation` 创建真实子会话、保存父子元数据，并用 `userMessage: prompt`、`triggeredBy: 'delegation'` 启动。 | 委派关系已有记录，任务正文仍走用户消息输入路径。 |
| `apps/electron/src/main/lib/agent-orchestrator.ts` | 未抑制用户消息持久化时，把输入正文保存为 `SDKMessage` 的 `type: 'user'`。 | 当前消息格式会把委派正文存入用户消息槽，作者语义需要补充。 |
| `agent-collaboration-tools.ts` | 有停止父会话时级联停止子会话的实现。 | 独立会话不能只靠去掉树形展示来实现，生命周期也需区分。 |

定时任务与路由在 2026-11-01 补充核对：当前 `Automation.sessionMode` 有 `daily/reuse`；`sourceSessionId` 表示创建来源，不是指定执行目标；scheduler 创建或复用任务自己的会话，表单隐藏 sessionMode 控件，尚无本文要求的指定既有会话绑定。当前忙碌处理以跳过/延后为主，第 9 节可见排队属于目标行为。

基础实现也已核对：`agent-fabric` 有 Task/Gateway/事件/策略/幂等与文件存储端口；`agent-runtime` 有 coordinator、ownership、PermissionPort、SessionPort 和 Provider adapter 边界。现有 Run/outcome 多为执行期状态，不能据此宣称已有本文持久化 Run 账本。内部委派和 automation 尚未统一进入 Fabric Task 流。

搜索投影在 `agent-session-search.ts` 和 `session-core` 已有限核对，当前仍以消息 role/正文提取为主。前端全量分组、导出全路径、编辑重发及 Pocket 同步未完成端到端核验，保留为验收范围。Claude/Pi 与轻量授权的具体对照见第 17—18 节。

## 8. 推荐技术方向与方案取舍

本节是工程建议，具体类型名、工具名和存储字段未定稿。

### 8.1 推荐：独立表达来源，适配层转换协议

在 Profer 自有记录中表达真实作者、触发来源、授权引用、任务与运行关系，再由 Provider 适配层转换成模型接口所需的消息角色。

模型 API 可能要求用 `user` 角色承载任务输入。这是协议角色，不等于产品中的真实作者。转换时向执行模型明确说明任务来自另一个 Agent 或框架，转换不能反向覆盖原始身份。

来源字段由受信运行上下文生成和校验，不能让模型仅靠提交“我是用户”“已经批准”等字符串获得身份或权限。授权引用应指向实际用户操作或已保存任务授权，不以模型自述替代。

建议优先复用已有任务和会话契约，避免为本功能再造一套互不关联的调度系统。

### 8.2 备选与取舍

| 方案 | 优点 | 问题与结论 |
|---|---|---|
| 仅修改头像和来源标签 | 改动小。 | 底层仍误记作者，搜索导出和后续模型无法可靠辨认，不满足目标。 |
| 来源作为独立事实，按 Provider 适配 | 保留真实身份，兼容不同协议，支持渐进落地。 | 需要贯通存储与投影；推荐。 |
| 全部重写为自有消息与任务协议 | 长期统一程度高。 | 范围过大，容易把会话、调度和 Provider 重构捆在一起，不作为首步。 |

历史记录不批量猜测作者。只能从可靠元数据恢复来源的记录才可补充标记；其余保留原记录并按旧版本处理。用户编辑重发一段历史交接文字时，新发送内容的作者是用户，原来源可作为引用，不能继续冒用原 Agent 身份。

## 9. 调度、异常与恢复建议

- **目标会话忙碌**：进入可见待执行状态，复用或扩展现有调度能力；不要把新触发文本插入正在进行的工具执行而混淆任务。
- **重复触发或事件重放**：用任务触发标识与运行标识去重，避免重复派工和重复写入。
- **目标会话不存在或不可访问**：保留失败或待处理状态，说明原因；不静默换到其他会话。
- **预设或权限变化**：启动时重新按有效权限校验；无法执行则报告受阻，不自行恢复关闭能力。
- **应用重启**：从持久化关系恢复任务归属、来源和状态，不能仅凭旧的 running 标记推断仍在运行。
- **取消与停止**：区分停止当前运行、取消某项任务与取消关联子任务。独立会话与子会话采用明确不同的生命周期语义。
- **并发修改**：按实际文件与项目资源协调；同会话和不同会话都需要避免冲突。

异常是否需要用户选择由具体情况与模型判断决定；不额外引入一套“所有异常都先审批”的流程。

## 10. 分阶段落地与所有权

这是一份设计交接顺序，不是已经执行的实施计划。

| 阶段与所有者 | 输入 | 产出 | 依赖与验证证据 |
|---|---|---|---|
| A：Fabric 契约与纯 Runtime | 第 13—18 节基础设计、现有任务与执行契约。 | 统一 Task/Trigger/Run、来源和启动依据、Run 事件及宿主端口；保留旧协议兼容。 | 先补纯契约、幂等/恢复与 Claude/Pi 生命周期测试；新能力不依赖 Electron。 |
| B：存储与 Provider 接入 | A 的版本化契约，现有存储和两端适配器。 | 可持久化事实与消息关联，旧数据兼容，Claude/Pi 统一终态。 | 先通过无 Electron 的最小 headless host；检查两端重试、追加输入、后台续轮。 |
| C：Electron 宿主与派工 | A、B 的端口及既有委派入口。 | 当前会话/子会话/独立会话路由和生命周期；Renderer 接收安全投影。 | 验证来源保存、开始/停止、结果回传与去重；UI 仅负责显示，不拥有事实。 |
| D：定时与来源投影 | 统一运行与消息契约、现有 scheduler。 | 持续任务启动依据、绑定既有会话；搜索导出与 Pocket 一致展示。 | 验证绑定失效、忙碌、重复触发、编辑重发与删除来源。 |
| E：整体验收 | 前述阶段实现。 | 统一事实、双 Provider 等价与换壳证据。 | 按第 17 节分层报告；不把单测等同真实渠道/桌面验收。 |

本次仅更新设计，不改变当前会话预设、不启动工程实现、不创建工作子会话、不修改实际定时任务。基础契约完整设计，适配分步落地；实施前输出文件级计划，复核工作树与相关项目约束。

## 11. 行为验收场景

### 场景 1：用户首肯后自主派工

Given 用户已同意执行明确方案；When 模型决定拆为独立工程会话和并行审查子任务；Then 无需再次批准组织方式，各任务在授权范围内启动，来源和去向可追溯。

### 场景 2：只有讨论意图

Given 用户仅要求讨论方案，且没有已有执行指令或其他持续依据；When 模型认为方案已经成熟；Then 不因自主派工能力而直接开始实现，先确认执行意图。有已存在的有效依据则直接继续，不一律请求批准。

### 场景 3：用户指定当前会话

Given 用户说“就在当前会话做”；When 任务启动；Then 遵从指定，来源与执行者仍可区分，不静默创建独立工作会话。

### 场景 4：同会话子任务

Given 当前会话派出一个调研任务；When 子 Agent 执行并回传；Then 主时间线可看进度和结果，不要求多占一个侧栏会话，完整执行记录仍可定位，工具结果不串任务。

### 场景 5：手动绑定定时任务

Given 用户勾选“在指定会话中执行”并选定会话；When 后续触发；Then 工作进入所选会话，触发消息标记为对应定时任务，不冒充用户，也不重复请求已经授予的持续授权。

### 场景 6：模型创建定时任务

Given 用户已授权周期性工作，未指定承接会话；When 模型创建任务；Then 模型自主确定会话安排及是否询问用户，无需先让用户开启“智能判断”。

### 场景 7：身份贯通

Given 任务由来源 Agent 编写并发起；When 存储、重载、搜索、导出或供后续模型读取；Then 作者仍可识别为该 Agent，用户只作为对应授权者；Provider 使用 user 协议角色不会改变此事实。

### 场景 8：授权与来源不能伪造

Given 模型提交一段声称“用户已批准”的文字但没有有效依据；When 系统校验；Then 文字不能产生用户身份或授权，任务仍受现有权限约束。

### 场景 9：目标忙碌与重复触发

Given 目标会话正在运行且收到同一触发的重复投递；When 调度处理；Then 仅保留一次有效待执行任务，不打乱当前运行，也不重复修改。

### 场景 10：独立生命周期

Given 模型已创建独立工作会话；When 来源会话停止当前生成；Then 独立工作不因父子级联逻辑而自动被取消。子任务取消行为应符合明确设计的规则。

## 12. 实施前的文件级核对

产品原则不再重复问卷；以下是工程计划需落到现有接口的细节：

1. TaskRequest/AgentTask 的兼容投影、Run/Trigger 持久化接口、记录与事件的 schemaVersion；避免双写形成两套事实。
2. coordinator 的 ownership 与逻辑 runId 区分：运行进程/执行权 token 变化不能误建业务 Run。
3. 双 Provider 的追加输入、原生重试、压缩、后台等待与 settled 信号如何映射到统一事件；不假设单一 result/agent_end 就是终态。
4. 消息 provenance 如何经 SDKMessage 存储、分页、重发、fork、搜索导出和 Pocket 往返保留。
5. 定时任务指定绑定与已有 daily/reuse、preset/runtime/session 配置的优先级，以及排队持久化的最小接入路径。
6. 改动文件范围与依赖边界测试；保留当前工作树 WIP，不把 Runtime 根基和无关重构捆绑。

完成这些核对后再输出文件级实施计划；不得以计划或设计文档代替实现与验证证据。

## 13. 基础模型与运行边界（2026-11-01）

本节是结合参考实现与 Profer 产品需求的设计选择，不声称存在跨 Agent 通用的同名标准。以下 TypeScript 表达语义，不是已发布接口或本轮新增实现。

### 13.1 Task、Trigger、Run

```ts
interface Task {
  id: string
  objective: string
  origin: TaskOrigin
  authorization?: TaskAuthorization
  parentTaskId?: string
  workspaceRef?: string
  state: 'open' | 'completed' | 'cancelled'
  createdAt: number
  updatedAt: number
}

interface TaskTrigger {
  id: string
  kind: 'user_message' | 'delegation' | 'automation' | 'external_request' | 'resume'
  actor: ActorRef
  source?: ResourceRef
  authorization?: TaskAuthorization
  createdAt: number
}

interface AgentRun {
  id: string
  taskId?: string
  triggerId: string
  sessionRef?: string
  executorRef: string
  runtime: string
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped'
  startedAt?: number
  completedAt?: number
  resultRef?: string
}
```

这些是最小事实字段，不替换现有 Fabric 的 constraints、dependsOn、policy、预算、委派限制、产物与结果契约；实施时复用现有能力，不重新定义平行版本。Run 的 completedAt 在这里表示终态时间，命名可在文件级契约中统一为 finishedAt，不能只记录成功运行。

Task 状态回答工作目标是否仍开放；Run 状态回答当前执行过程。某次 Run 失败/停止不会自动取消 Task；用户继续推进可在同一 Task 下创建新 Run。排队或准备失败也可形成 failed Run，startedAt 为空，区分“准入后失败”和“Provider 已开始后失败”。Run waiting 的原因和恢复上下文经现有事件/请求引用保留，不用自然语言猜状态。

### 13.2 触发不等于每次新建 Run

```text
Session S
  Run R1 ← 初始 Trigger T1
    输入事件：Trigger T2（steer/followUp）
    模型与工具循环、自动重试、压缩恢复
    等待审批 → Trigger T3 恢复同一 Run
  Run R2 ← Trigger T4（R1 结束后用户重新执行）

Task K（可选）
  关联 R1、R2；不拥有 Session 的全部历史
```

- Run.triggerId 是初始触发；后续 Trigger 通过带 runId/triggerId 的输入或恢复事件关联已有 Run，不覆盖初始来源。
- 输入送达前先由 Runtime 确定它被接收为追加输入，还是等待新执行。不能仅凭 UI 显示 streaming 决定归属；settled 竞态由 ownership/协调器解决。
- Provider 内部模型调用、工具循环、原生重试与自动压缩不产生新 Run；网络重试记为事件，不增加顶层 Attempt 实体。
- handoff 可以保留逻辑 Run，执行者变化记为事件；Run.executorRef/runtime 表示当前执行快照，开始时和每次变更时在事件中保留当时值，不能覆盖历史。委派为独立分工时创建子 Task 与自己的 Run。两者不能只靠“换了模型”判断。
- 等待审批或恢复已持久化的暂停执行，可以继续同一 Run。终态后重新执行产生新 Run，不把 completed/failed/stopped 记录改回 running。
- 应用崩溃留下的 running 记录不代表仍有进程。宿主先对账：Provider 支持恢复且确认接管时沿用逻辑 Run；无法恢复时如实结束旧 Run，再根据任务依据决定是否新执行，写入型工作不盲重放。
- Session 是上下文引用，不等于展示时间线。多个子任务可在主时间线投影，同时保持各自执行上下文；第一阶段不引入同一 Provider Session 的并发写入。

### 13.3 定时与普通聊天

普通问答无需先创建 Task。需要跨轮交付、委派或持续管理时才创建 Task。Automation 是调度定义，不是永久 running 的 Run；每次有效调度产生独立 Trigger，并按任务管理规则关联 Task 和本次 Run。是否复用同一个 Session 与是否新 Run 正交。

同一个调度事件的重复投递沿用同一触发身份；按 automation ID 加计划触发时刻/occurrence ID 去重，不能按实际到达的 Date.now() 每次生成不同业务触发。重试投递和显式“立即运行”也应区分。

## 14. 来源、消息作者与引用

### 14.1 资源和主体引用

```ts
type ResourceRef = {
  type: 'task' | 'run' | 'session' | 'message' | 'automation' | 'request'
  id: string
}

type ActorRef = {
  type: 'user' | 'agent' | 'automation' | 'external' | 'system'
  id?: string
}

interface TaskOrigin {
  actor: ActorRef
  source?: ResourceRef
}
```

引用是可序列化的稳定业务 ID，不含 Electron 对象、IPC 通道或 Pi 文件路径。已有 Profer 会话 ID 可以继续作为逻辑 Session 引用使用，不必为“去 Electron 化”再造 ID；Claude/Pi 原生 session ID、文件路径、进程 ID 留在 Provider/宿主映射中。

Agent 作者用逻辑执行主体及来源 Run 定位，不能用模型名、预设显示名或会话标题充当唯一身份。外部调用方使用认证记录的稳定 client ID，显示名只用于展示。单用户宿主没有账号 ID 时允许 user.id 为空，不能为了满足字段伪造账号。

Task.origin 在任务创建时确定，不因重试、换执行者或定时触发而改写。Trigger.actor 描述本次事件的发起者。例如用户提出周期工作，Task 的来源仍是用户，后续调度 Trigger.actor 是 automation。Resume 同样是动作原因，实际操作者可以是用户、系统或 Agent。

### 14.2 消息关联必须覆盖无 Task 的对话

仅在 Task 上存 origin 不足以实现真实作者，因为普通聊天可没有 Task，同一个 Run 也能接收不同主体的输入。持久化消息需要最小 provenance：作者、逻辑消息 ID、所属 runId、可选 taskId/triggerId/source 引用。沿用当前 SDKMessage 存储与 Profer 元数据扩展模式，新增一处有类型定义、版本化的 provenance 元数据；领域语义不依赖 SDK 角色，序列化 adapter 负责保留/读取该元数据。此次不重写全部消息格式，也不另建可独立修改的作者侧表；未来换存储格式时仍映射相同事实。

Provider 输入可以使用 user 角色，产品作者仍按 provenance 解释；不增加 Provider 的 agent 角色。任务正文作者、框架触发通知作者、批准者和实际执行者分别展示。定时框架复用用户编写的 prompt 时，不能顺带把原正文作者改成框架；框架生成的触发通知才由框架署名。

源码中 AgentRunInitiator 继续可由新事实投影得到，以维持未读行为兼容。它当前用于未读策略，不升格为完整作者或授权模型。

来源引用被删除/不可访问时保留必要摘要与原始引用，UI 标记不可访问，不伪造链接。历史缺少可靠证据的作者保持旧版/unknown 展示；unknown 不作为新权限依据。用户编辑重发机器交接文案时，新消息作者是用户，原来源作为引用；fork 复制历史不改作者，新输入重新署名。

## 15. 轻量启动依据与来源校验

启动依据是解释性记录，复用现有权限机制，不是新的访问凭证。记录放在 Task 或当前 Trigger 上；普通聊天可只在 Trigger 记录，后续 Run 的依据可以与原 Task 不同。

```ts
interface TaskAuthorization {
  kind: 'direct' | 'confirmed' | 'inherited' | 'scheduled' | 'external' | 'policy'
  sourceRef?: ResourceRef
}
```

| kind | 解释 | 典型引用 |
|---|---|---|
| direct | 用户已明确要求当前工作 | 实际用户消息 |
| confirmed | 用户确认了已讨论的方案 | 实际确认消息/用户操作 |
| inherited | 在已有任务范围内拆分或继续 | 父 Task/Run |
| scheduled | 保存的持续任务依据 | Automation |
| external | 已认证调用方按既有入口策略提交 | 实际外部请求记录 |
| policy | 现有系统策略驱动的工作或恢复 | 运行/请求记录；具体策略解释沿用宿主现有机制 |

授权记录允许兼容缺省，不为旧聊天强制弹出新审批；缺省也不是放行凭证。新入口尽可能记录可追溯依据，是否允许执行始终取决于现有有效预设策略与宿主/Provider 权限机制。

来源由受信入口上下文生成：桌面输入取实际用户操作、委派工具取当前父 Run、调度器取实际 Automation、外部入口取认证调用方。模型可以描述工作目标并引用上下文，不能自行提交 actor='user' 或 kind='confirmed' 获得身份与权限。外部 envelope.actor 与 TaskRequest.requester 必须由认证身份解析或校验一致；不信任 payload 自称的身份。

不新增“所有 Task 先批准”的流程，不新增 Grant/Decision 表、撤销树或逐工具授权账本。父任务内拆分、已有明确指令、持续任务触发可直接继续；只有讨论时不自动扩大为实现。bypassPermissions 是现有工具审批模式，不等于真实用户作者或更宽的产品能力；EffectiveAgentPresetPolicy 仍是当前能力边界的解释来源，关闭组/单工具/Skill/MCP 不因 TaskAuthorization 或派工被重新启用。

已有 Fabric policy/approval 相关接口继续保留并接入现有机制，本设计不删除或削弱它们。现有 automation/Fabric headless 的 bypass 配置在适配时核对，不把来源字段包装成“所有安全链路已完成”。

## 16. Runtime、Fabric、Provider 与宿主边界

### 16.1 契约归属与依赖

| 位置 | 所有的内容 | 不承担的内容 |
|---|---|---|
| agent-fabric | Task/Task 图、Origin/资源引用/启动依据、协议事件、结果；在任务查询中引用 Run | Electron UI、Provider 原生类型、运行进程的管理 |
| agent-runtime | Run/Trigger 的执行契约与协调、追加输入、等待/恢复/停止/终态及宿主 ports | BrowserWindow、IPC、Electron 配置路径、Renderer 状态 |
| agent-provider-claude / pi | Provider 会话映射、模型/工具循环、原生重试/压缩/后台续轮与统一终态 | 以协议 role 推断真实产品作者、决定产品任务归属 |
| 存储/宿主 adapter | 持久化、资源解析、现有权限接入、会话路由、进程与交互能力 | 重定义 Task/Run/来源语义 |
| Renderer / Pocket / CLI 展示 | 消费安全投影、跳转、搜索、导出与用户操作 | 持有完整凭据、生成受信 Agent 来源或第二套状态机 |

纯值类型只有一处定义。需要共享来源/启动依据时采用 `agent-runtime → agent-fabric` 的单向纯类型依赖，Fabric 不反向依赖 Runtime；Fabric 任务侧只保存/返回 runId 关联，详细运行查询由组合宿主调用 Runtime 的存储端口。Runtime 不依赖具体 Gateway singleton。实施前核对 workspace 依赖闭包，不能为本功能新增第三个重复的 Task 模型包。

基础层不 import Electron 或 apps/electron；Provider 通过注入端口取宿主能力。Node-only 文件 adapter 可以依赖 fs，但目录、JSONL 布局和 Electron userData 都不是领域协议。业务资源 id 与存储路径分离，序列化记录/事件有 schemaVersion 和兼容读取规则。

### 16.2 复用端口，不给每个名词再造服务

沿用现有 SessionPort、PermissionPort、CredentialPort、ResourcePort、EventPort 与 coordinator/ownership；按 Run/Trigger 持久化和引用解析的实际缺口扩展窄接口。事件消费者不直接读取 Electron singleton。没有相应用户交互端口时沿用现有拒绝/受阻行为，不为了 headless 运行恢复被关闭能力。

用户发消息、委派、自动化和外部请求经各入口解析为可信上下文，再进入共同 Runtime 路径。Runtime 记录 Trigger/Run，执行 Provider adapter，发布带 runId/可选 taskId 的统一事件，宿主持久化并投影。UI 不直接转发不可信 actor/authorization 对象成为受信记录。

### 16.3 两端终态映射

| 参考与本地实现 | 应保留的差异 | Profer 顶层行为 |
|---|---|---|
| Claude Session + query/result；本地 adapter 支持软中断、延迟工具与后台任务 | result 可能要求保留通道，轻量完成不等于终态 | 背景任务仍关联同一 Run；确认真正结束才发布一次终态 |
| Pi AgentSession 0.86.1 的 agent_end.willRetry、auto_retry、compaction、agent_settled；本地 adapter 已有终态延迟逻辑 | agent_end 后可能继续原生重试/压缩；手动 compact 还有单独收束逻辑 | 按 adapter 完整生命周期收束，不把一次 agent_end 直接映射为 Run completed |
| OpenAI Runner 的模型/工具/handoff 循环、RunState 恢复 | handoff 与审批恢复可仍在同一逻辑 Run | 作为语义参考，不额外引入 OpenAI Provider 依赖 |

运行执行权 token、进程启动 ID 和业务 runId 职责不同。换进程或恢复 SDK 上下文不必产生新业务 Run；迟到的旧 owner 消息和重复终态不能覆盖新 owner 状态。停止当前 Run 与取消 Task 分开：独立工作不因来源会话普通停止而级联；子任务沿既有可追踪关系明确取消范围，终态事件只记一次。

## 17. 迁移与验收

### 17.1 契约迁移

现有 TaskRequest 是提交协议，不因引入轻量 Task 就静默丢弃 policy、constraints、dependsOn。AgentTask.status 的详细执行状态向 Run 迁移时提供版本化映射：旧调用方继续看到兼容状态，新内部 Task.state 与 Run.status 分开；不可同时独立写两个状态真值。paused/expired 等旧状态需保留结构化原因或兼容字段，不能无说明折叠为成功。

旧记录有可靠关联时可生成兼容视图；不能从 sourceAutomationId 猜一整个会话每条消息都是框架作者，也不能凭用户正文的“已批准”回填确认。Provider 原生 Session 保持可 resume，UI UUID/Pi entry binding 等已有定位关系不能丢失。

去重按实际业务触发身份，持久化任务/触发/Run 后再发外部可见开始事件。文件存储需防止半写导致第二次运行，允许用单一追加日志加派生索引或现有原子写模式；不默认引入数据库。应用重启从已有记录恢复和对账，不能只靠内存 Map/Set。

### 17.2 先补测试，再做实现

| 层级 | 必须证明的行为 |
|---|---|
| 纯契约 | 来源/引用往返；可无 Task 的 Run；同 Task 多 Run；多个输入 Trigger 关联同 Run；终态不可被重复或迟到消息改写 |
| Runtime | 追加输入与 settled 竞态；重试不新建 Run；暂停审批恢复同 Run；终态后重执行新 Run；stop Run 不自动 cancel Task |
| 双 Provider | Claude/Pi 同场景的统一行为；Pi willRetry/压缩、Claude 后台/软中断不误报最终完成；Provider session ID 与逻辑 sessionRef 不混用 |
| 能力策略 | 关闭工具组、单工具、Skill/MCP 白名单仍有效；Prompt 只说明实际注册能力；任务与来源记录不扩大权限 |
| 身份与输入 | 模型自称用户/已批准不改变受信来源；外部调用身份绑定；scheduled 正文作者与触发通知作者分别保存 |
| 持久化 | 重启去重；保存后重载；旧数据兼容；目标失效保留原因；写入中断不凭残留 running 重放副作用 |
| 产品投影 | JSONL/分页/搜索/导出/Pocket 一致；重发重新署名；fork 历史不改作者；未读回归 |
| 换壳 | 同一用例在内存/文件端口的最小 headless host 中运行，依赖闭包不导入 Electron/IPC；Claude/Pi 通过现有 adapter 可装配 |

验证分层报告：纯单测、类型检查、Runtime/Provider 构建、headless 装配、真实模型渠道与桌面/Pocket 交互分别记录。无 Electron 的 stub 测试不能充当真实 Provider 冒烟；纯 Renderer 通过也不能充当内核可移植证据。

本轮只完成设计与资料核对，没有运行上述实现测试。实施时先测试策略/工具组合与生命周期，再做最小实现，最后完成相关构建和交付验证。

## 18. 参考依据与适用边界

核对日期：2026-11-01。官方在线文档是当前文档，不保证与本地固定 SDK 的全部 API 一致；实施以项目锁定版本和 adapter 源码为准。外部参考支持概念与生命周期判断，不自动证明 Profer 方案已实现。

| 已实际读取的来源 | 可复用的事实 | Profer 的设计选择 |
|---|---|---|
| [OpenAI Running agents](https://openai.github.io/openai-agents-python/running_agents/) 与 [源码文档](https://raw.githubusercontent.com/openai/openai-agents-python/main/docs/running_agents.md) | Runner 一次运行内循环调用模型、工具及 handoff；turn 指模型循环，RunState 可恢复暂停运行 | 顶层 Run 包含内部循环，不把每次工具或换执行者当作新 Run |
| [OpenAI Sessions](https://openai.github.io/openai-agents-python/sessions/) | Session 在多个 agent runs 之间保存历史 | Session 与 Run 分开；不照搬 SQLite 作为存储约束 |
| [OpenAI HITL 源码文档](https://raw.githubusercontent.com/openai/openai-agents-python/main/docs/human_in_the_loop.md) | 工具声明需审批时中断，经 RunState 继续原运行 | 不设全任务批准前置；审批恢复不必新 Run；继续用现有权限链 |
| [Claude Sessions](https://code.claude.com/docs/en/agent-sdk/sessions.md) | continue/resume 继续既有 Session，fork 创建独立历史分支 | 逻辑 Session 与 Provider 映射分开，引用作者不因 fork 改写 |
| [Claude Permissions](https://code.claude.com/docs/en/agent-sdk/permissions.md) | 权限模式、工具规则与 canUseTool 控制具体工具使用 | 来源/启动依据不取代现有工具门禁，也不要求每个 Task 人工批准 |
| [Pi 0.86.1 Agent events](https://github.com/earendil-works/pi/blob/v0.86.1/packages/agent/src/types.ts)、[AgentSession](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/src/core/agent-session.ts) | agent 生命周期与 turn 不同；Session 层有 willRetry、自动重试、agent_settled | 顶层终态由 adapter 综合收束，保留 Provider 内部事件差异 |
| [LangGraph Checkpoint/Thread](https://reference.langchain.com/python/langgraph.checkpoint/) | 一个 Thread 保存多个 Run 的检查点 | 借鉴 Session/Run/恢复区分，不引入完整图调度与 Checkpoint 平台 |

本地同时核对：`agent-runtime/src/{contract,ports,events}.ts`、`agent-fabric/src/{task,gateway,protocol,events,state-machine}.ts`、`agent-provider-claude/src/claude-agent-adapter.ts`、`agent-provider-pi/src/pi-agent-adapter.ts`、Electron 的 automation scheduler/collaboration/session manager，以及项目依赖 Claude Agent SDK 0.3.201、Pi 0.86.1。当前代码已有的 Provider 生命周期保护优先复用，不为新领域对象删除这些行为。

Task、TaskOrigin、TaskTrigger 的具体组合及轻量启动依据是 Profer 的产品设计，不是以上 SDK 都提供同样对象；不再用“行业通常如此”替代证据。
