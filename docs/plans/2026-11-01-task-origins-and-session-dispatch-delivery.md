# 真实任务来源与会话派工：施工交付

日期：2026-11-01（GMT+8）

依据：`docs/plans/2026-10-30-task-origins-and-session-dispatch-design.md`。本文件记录施工后的实际状态，不把原设计中的历史源码描述改写为现状。

状态：代码实现与自动验证完成，本地未提交；未发布、未部署、未修改真实定时任务。真实模型渠道与 Electron/Pocket 人工端到端验收未执行。保留施工前工作树中的用户 WIP，未修改 AGENTS.md、CLAUDE.md、README.md 或发布脚本的既有内容。

## 已实现行为

### 来源事实与轻量基础契约

- `packages/agent-fabric/src/origin.ts` 单一定义 ResourceRef、ActorRef、TaskOrigin、TaskAuthorization、MessageProvenance。来源记录不授予权限。
- TaskRequest 保留已有 policy、constraints、dependsOn 等字段，增加可选版本化来源；AgentTask.runIds 由真实 executor 准入回调关联。工作目标状态由同一 AgentTask 派生，不创建第二个可写 Task 模型；failed/expired 的目标仍为 open。
- Gateway 将 requester、origin 和启动依据绑定认证 caller，拒绝跨 caller 的 requestId 幂等读取。正文和 envelope 的自称身份不能替换认证身份。
- `packages/agent-runtime/src/run-ledger.ts` 维护带 schemaVersion 的 Trigger/Run/event 快照：queued、running、waiting、completed、failed、stopped。初始 triggerId 不被追加输入与恢复覆盖，终态幂等；支持同 Task 多 Run、无 Task 普通运行及 executor handoff 历史。

### 两条桌面执行链与持久化

- 默认旧 AgentOrchestrator 与显式开关启用的新 AgentRuntimeCoordinator 共用 ownership registry 和文件 Run ledger。业务 runId 与进程执行权 token 分开。
- claim 后、异步准备前保存 queued；准备成功、Provider 真正启动前保存 running；准备失败保留 startedAt 缺省；真实逻辑运行结束后只保存一次终态。
- 保留 Claude 后台轻量完成、软中断、Pi 原生 retry/compaction/settled 行为，不为内部循环新建 Run，不把轻量完成当终态。
- 权限审批和 AskUserQuestion 的真实 request/response 关联同一 Run 的 waiting/resume；abort 与迟到回复不伪造恢复。
- `packages/session-store/src/run-ledger-store.ts` 以临时文件、fsync、原子 rename 提交快照；损坏或未知 schema 失败关闭，不回退空账本。
- Electron 组合根使用配置目录下 `agent-runs.json`，沿用开发/正式/受控配置根隔离。启动及首次使用共用幂等对账：上进程 running/waiting 转为 failed 并说明中断，queued 保留，不自动重放未知副作用。
- 追加输入绑定接收时的真实 Run；Provider 接收后落盘、关联 Trigger 并广播。重复 UUID 不重注入；settled/过期 owner 拒绝，不归到后续 Run。新 coordinator 的追加入口已接到 service。

### 作者、触发通知与跨端投影

- 消息通过 `_provenance` 记录产品作者和 run/task/trigger/source；保留 Provider 的 type、role、uuid。无 Provider uuid 时不写入业务 ID，partial/final 的逻辑 messageId 保持稳定。
- 桌面发送与编辑重发由可信入口重新署名为 user；Pocket 用户输入仍为 user。派工、调度、外部主进程入口分别建立 agent、automation、external 等真实来源，不从正文的“已批准”推断授权。
- 非用户 Trigger 在正文前保存 `system/task_trigger` 来源通知，通知作者与保存的正文作者分开。例如用户编写的定时正文仍归 user，触发通知归 automation。通知正文使用可读来源摘要；完整引用仅在 provenance 结构字段中保存。
- Provider 输入附加宿主来源说明；历史上下文回填也保留作者和来源引用，不能把 user 协议槽等同真实用户。预设变更意图只从真实用户输入解析。
- JSONL、分页、fork、session-core 分组/搜索/导出、Electron 搜索、remote 两路消息和 session_detail 均保留或消费同一安全 provenance。Pocket 只投影白名单，不传授权对象、凭据或文件路径。
- 普通助手回复的标题仅显示模型名和时间，不额外插入 Agent/作者 ID 行。任务交接与定时触发使用独立来源卡：显示可读来源标题及定位入口，来源不可访问时只显示一次状态提示；内部 ID 不作为用户文案。旧通知正文即使含 ID，也不直接回显，而是从可验证 provenance 重建摘要。缺少可靠 provenance 的旧通知显示通用历史来源说明，不猜测作者。

### 派工与自动化

- Claude/Pi delegate_agent(s) 的 schema、注册与提示词支持 placement=current/child/independent 和 relation=subtask/independent；旧调用保持 child 兼容。
- current 使用隔离 Provider 执行上下文，在父会话展开历史/实时记录，支持切换、分页、完成刷新和打开完整执行会话；不拼入父 Provider 历史。
- independent 保留来源和查询范围，不进入父会话停止级联。子任务保留明确父子关系；持久化恢复后的 list/results 仍返回定位投影。
- 派工来源继承真实 sourceRunId，权限由本轮冻结有效权限与目标预设共同收窄；来源不恢复禁用工具组、单工具、Skill 或 MCP。
- Fabric executor 使用稳定 triggerId 并对共享 Run 账本去重；Task.runIds 保存实际准入 Run。后台轻量完成不封存 Task，取消先封存再通知 executor，迟到回调不覆写终态。
- 定时任务增加 boundSessionId 与 promptAuthor；显式绑定优先于原 daily/reuse。绑定失效、模型/渠道/预设不匹配时保留原因，不静默换会话。
- 自动化 occurrence/trigger 持久化在同一 automations 文件，忙碌时排队；调度与手动创建分别记录真实作者。触发记录关联共享 runId，重启对账不盲重放，trigger 与运行历史在同次原子写入结算。
- 自动化表单提供“在指定会话中执行”及目标选择；LIST/GET 从唯一 triggers 事实派生 pendingTriggers，展示排队、受阻、执行中及中断原因与目标定位，不保存第二份状态。

## 核心文件入口

| 边界 | 文件 |
|---|---|
| 来源/Task 契约 | `packages/agent-fabric/src/{origin,task,gateway}.ts` |
| Run、上下文、协调 | `packages/agent-runtime/src/{run-ledger,run-context,run-origin-prompt,coordinator,contract,events}.ts` |
| 文件端口 | `packages/session-store/src/run-ledger-store.ts` |
| 桌面装配 | `apps/electron/src/main/lib/{agent-run-ledger-host,agent-input-origin,agent-runtime-queue,agent-service,agent-runtime-host,agent-orchestrator}.ts` |
| 派工/Fabric | `apps/electron/src/main/lib/agent-collaboration-*.ts`、`agent-fabric/fabric-executor-headless.ts` |
| 自动化 | `apps/electron/src/main/lib/automation-*.ts`、`renderer/components/automation/` |
| 安全投影 | `packages/shared/src/utils/message-provenance.ts`、`packages/session-core/src/`、`pocket-agent-projection.ts`、`remote-service.ts` |
| 可见入口 | `renderer/components/agent/{CurrentDelegationPanel,SDKMessageRenderer}.tsx` |

仅新增内部 workspace 依赖：Runtime → Fabric、Shared → Fabric、SessionStore → Runtime；Fabric 不反向引用 Runtime，不新增第三方依赖。bun.lock 仅同步这三处依赖关系。

## 验证结果

| 检查 | 结果 |
|---|---|
| `bun test --isolate` | 展示修正后全量：680 文件，5,839 pass / 4 skip / 0 fail，19,951 assertions |
| `bun run typecheck` | 全部 workspace 包通过；最后的测试参数类型补齐后再次通过 |
| Runtime `check:isolation` | 10/10 通过；无 Electron/Provider SDK 可解析的沙箱中 typecheck、构建、源码/产物加载和 218 项 Runtime 测试通过 |
| Electron `build:main` | 通过 |
| Electron `build:renderer` | 通过；保留既有 chunk size 警告 |
| `git diff --check` | 通过 |
| 文件端口最小 headless 组合 | Claude/Pi 两种装配均通过；重建宿主、重投同 Trigger 只调用 Provider 一次，通知与正文作者分开持久化 |
| 实际 React 静态呈现 | 已检查来源卡、current 委派面板、自动化待执行列表；浅/深色、窄栏、长来源 ID 下只显示可读作者/状态，不显示原始 ID |

4 项 skip 均为本机 macOS 无法执行的 Windows PowerShell 专项。Claude/Pi 生命周期、权限/工具组合、Skill/MCP 白名单、Prompt 不泄漏与消息/未读等回归包含在全量测试中。

## 验收边界与后续人工场景

本轮没有使用真实模型渠道、没有启动桌面进行人工派发、没有连接 Pocket 真机，没有打安装包。受控 adapter、文件端口组合测试和静态 React 渲染不等同真实模型或设备端到端。

建议人工覆盖：桌面 Claude/Pi 普通输入及追加；派工三位置与父停止；审批等待/回复/停止；定时指定会话忙碌、目标删除和重启去重；Pocket 运行中与重连后来源显示；来源会话与定时任务定位。

本地账本采用完整 JSON 快照和单应用进程的同步原子写入，未新增跨实例协调或日志压缩系统。来源删除后结构化 provenance 仍保留稳定引用，但用户界面只显示“来源不可访问”状态，不泄露原始 ID；历史没有可靠作者或名称快照时不补造原标题。Pocket 本轮仅修改桌面服务端协议投影，未修改独立 Android 仓库，原生 UI 展示由后续真机联调确认。
