# 项目导航与隐藏 Draft Agent 会话

> 状态：已实现
>
> 日期：2026-07-22

## 目标

在 Agent 模式中，单击侧边栏项目后直接进入与“新 Agent 对话”完全一致的原生 `AgentView`。项目本身不再维护独立的起始页、输入草稿、附件临时目录或另一套模型/运行时选择 UI。

为此，项目单击会幂等创建或复用一个真实的 Agent session，并以持久化 `draft: true` 标记将它隐藏。它在用户首次有效发送成功落盘前，不出现在侧栏、搜索、同步和外部入口。

## 交互契约

- 项目标题单击：切换当前项目，确保并打开该项目的隐藏 draft session。
- 项目标题双击：只展开或收起项目会话列表，不打开项目。
- 小三角保持在项目标题按钮内部、名称末尾；鼠标点击三角只切换展开状态。
- 项目菜单的“设为当前项目”只更新当前项目；“在此项目中新建会话”仍立即创建真实会话。
- 用户首条消息写入 JSONL 后，draft 晋升为正式会话并从隐藏列表移除。
- 预检、附件或渠道失败不晋升，会话继续保持隐藏。
- 用户在隐藏 draft 中创建真实子代理时，父会话立即晋升为正式会话；子代理以该父会话的子节点显示，避免正式子会话挂在不可访问的隐藏父节点下。

## 数据模型与生命周期

`AgentSessionMeta` 增加持久化的可选 `draft` 标记。主进程 session metadata 的创建、更新和恢复均保留它。

`ensureProjectDraftAgentSession(workspaceId, channelId?, modelId?)` 按项目幂等创建或复用 draft，处理快速单击和应用重启。若发现已有 draft 已经写入用户消息但元数据晋升失败，会在下一次 ensure 时先恢复晋升，避免永久隐藏和重复追加。

普通发送路径在用户消息已持久化后调用 `onRunStarted` 晋升 metadata，并通过 `SESSION_UPDATED` 通知 renderer。renderer 的内存 `draftSessionIdsAtom` 也只在发送 IPC 成功或收到正式更新后解除隐藏。

协作委派路径在创建 child session 前先将 `parent.draft` 置为 `false`。子代理启动事件到达 renderer 时，会从主进程会话快照同时 upsert child 和转正的 parent，并清除 parent 的内存 draft 标记，保证会话树可访问。

## 可见性边界

所有用户可见或外部可访问入口均过滤持久 draft：

- 侧栏、TabSwitcher、SearchDialog、主进程消息搜索和 `&session` 引用搜索。
- Welcome 与模式切换的自动恢复。
- 同步、系统托盘、知识库目标选择器、飞书设置、桥接命令与飞书 `/list`、`/switch`。
- 飞书首轮流式镜像在用户消息持久化并晋升后才启动。

## 验收与验证

- 项目单击直接打开完整原生 `AgentView`，且不自动打开最近的正式会话。
- draft 在发送前不出现在本地列表、搜索、同步或外部桥接入口。
- 首条用户消息持久化后，session 立即成为可见正式会话。
- 隐藏 draft 创建真实子代理后，父会话与子代理均可从项目会话树访问。
- 项目标题双击只展开/收起；普通单击使用 500ms 延迟避免慢双击先打开项目。
- 已运行：`agent-send-coordinator.test.ts`、`agent-session-list.test.ts`、Electron `typecheck`、`build:main`、`build:preload`、`build:renderer` 与 `git diff --check`。
