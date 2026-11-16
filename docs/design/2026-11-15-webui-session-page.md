# WebUI：一个会话一个网页（端口与权限模型）

2026-11-15 · 适用于 Electron 主进程（`apps/electron/src/main/lib/webui-*.ts`）与
`Profer-pocket/webui` 前端子工程

## 0. 一句话结论

WebUI 是**第二条对外通道**，不是「移动模式的另一种界面」：它有自己的端口、自己的网卡设置、
自己的凭据，只服务「已发布会话」，也只能调用页面真正用到的命令。会话内容仍然只有一个写者
（主进程），所以两条通道共用同一套 WS 命令层。

## 1. 为什么必须与 Pocket 分开

改造前两者共用一个 `http.Server` + 一个 `accessToken`，由此产生三个无法同时满足的诉求：

1. **监听地址相反**。Pocket 需要 `0.0.0.0`（手机要能连），WebUI 默认只该给本机
   （链接可分享，暴露面越小越好）。共用监听时，任何一方改网卡都会改到对方：
   为网页选 `127.0.0.1`，手机端直接连不上，而 Pocket 面板仍显示局域网地址。
2. **凭据泄露半径不同**。网页 token 会出现在 URL、书签、聊天记录里；Pocket token 等同于
   这台机器的远控权（可读任意会话、删会话、执行工具）。共用一个 token 时，
   「分享一个会话的网页」= 「把远控权一起发出去」。
3. **能力面不同**。网页只需要「一个会话 + 审批 + goal」；Pocket 需要全量命令。

因此：**监听与凭据分开，命令层共用**。共用命令层的前提是连接上带角色
（`attachRemoteSocket` 的 `role`），由角色决定能力，而不是由端口猜测。

| 项 | Pocket | WebUI |
|----|--------|-------|
| 端口 | `pocketModePort`（7788/7789） | `webuiPort`（7800/7801） |
| 网卡 | `PROFER_REMOTE_HOST` / `0.0.0.0` | `webuiBindHost`（默认 `127.0.0.1`） |
| 凭据文件 | `remote-token.json` | `webui-token.json` |
| 默认命令面 | 全量 | 白名单（`webui-command-scope.ts`） |
| 会话范围 | 全部 | `webuiPublishedSessionIds` |

端口被占用时两者都会向后顺延 3 个候选并回写设置 —— 否则复制出去的链接第二天就失效。

## 2. 三道边界

### 2.1 发布白名单（HTTP 层）

- 开关默认关、白名单默认空 ⇒ **默认 0 个网页**。
- `/s/<id>` 只对白名单放行；未发布的 id 一律 404，且不会回「自愈页」泄漏页面存在。
- 白名单是持久化配置，会落后于会话状态，所以每次请求都复核「会话是否已归档/删除」；
  归档与删除还会主动撤发布（`webui-publication.ts`），面板里不会留幽灵条目。

### 2.2 命令白名单（WS 层）

网页连接的每一条命令都要过 `checkWebuiCommandAccess`：

1. 命令必须在 `WEBUI_ALLOWED_COMMANDS` 内 —— **白名单而非黑名单**，主仓新增远程命令时默认
   对网页关闭；
2. 会话级命令（`get_sdk_messages` / `send_message` / goal / 模型与预设更新…）的 `sessionId`
   必须在发布白名单内；
3. 审批命令只带 `requestId`，必须能从待处理队列反查出归属会话，且该会话已发布 ——
   避免「拿别的会话的 requestId 替它点允许」。

被拒的命令不产生任何副作用（放在 `handleRemoteCommand` 最前面，先于 `activeSessionId` 写入）。

### 2.3 事件与回放过滤

事件日志是全局的。不过滤的话，浏览器带 token 从 `cursor=0` 就能拉回整台机器的历史事件：

- 实时广播（`broadcastAgentFrame`）按白名单跳过；
- 游标回放（`resume_agent_events`）按白名单剪 `records`；
- 会话级回放（`restore_agent_streams`）把请求的 `sessionIds` 收成白名单本身（缺省也收）；
- `chat_event` 与 `connection_profile` 对网页连接不下发（页面没有对应视图）。

## 3. 静态产物链路（打包）

```
Profer-pocket/webui  --bun run build:webui-->  webui/dist
   --scripts/sync-webui-assets.mjs（拷贝 + 生成 .br/.gz）-->  apps/electron/resources/webui
   --electron-builder extraResources-->  process.resourcesPath/webui
```

- `resources/webui` 是构建产物（`.gitignore`），不进仓库；
- `build:resources` 严格模式：源产物缺失时**构建失败**，避免静默产出「网页 503」的安装包；
  日常开发用 `build:resources:dev`（缺产物只告警）；
- 可用 `PROFER_WEBUI_SRC` 指向任意 `webui/dist`。

## 4. 静态托管的两个细节

- **缓存**：产物文件名带内容 hash ⇒ `public, max-age=31536000, immutable`；
  会话页 HTML 仍然 `no-store`（要注入 boot 与标题）。
- **压缩**：Node 没有内置压缩，实时压不如构建时压。构建脚本产出 `.br` / `.gz`，
  服务端按 `accept-encoding` 直接给压缩体（426KB → 114KB BR）。

## 5. 前端（`Profer-pocket/webui`）

- 单会话页，通信复用 `pocket/ws-client`（心跳/重连/命令配对/游标都在里面）；
- `main.tsx` 只做编排，四个 hook 各管一件事：
  `use-diagnostics`（事件环形缓冲 + bundle 自检）、`use-auto-scroll`（贴底跟随与翻页锚点）、
  `use-attachments`（选择→校验→上传→就绪）、以及会话连接本身；
- 顶栏与输入条是纯展示组件（`topbar.tsx` / `composer.tsx`）。顶栏分三块触发区：
  - 左格「历史对话」→ `message-history.tsx`：把**已加载**的回合按时间正序列出、打开即贴底，
    点一条滚到那条消息；「加载更早」在列表顶部（更早的消息在时间序里就在上面）。
    列表顶部有渐隐（`mask-image`），只在「能滚且不在顶」时挂上 —— 打开即贴底时用户
    看不出上面还有内容，这层渐隐是最便宜的滚动方向暗示；到顶立刻撤掉，避免首条一直蒙灰。
  - 标题下面那一行（模型 chip）→ 会话设置菜单，目标入口（设定 / 编辑）收在这里。
  - 圆框其余任意区域（标题、标题下面那一行、留白）→ 会话设置菜单（模型 / 强度 / 预设 /
    目标 / 压缩）。压缩是唯一会占掉一整轮的动作，所以点它先出确认面板
    （`confirm-sheet.tsx`，与「停止本轮并发送」共用同一个组件）。
  - 右上角**连接绿点** → 会话信息条（`session-info.tsx`，横排居中：会话 id / 构建时间）。
    只留这两项：模型与权限在标题下面那一行已经显示了，重复等于噪音。
  - **键盘适配（iOS）**：`.app` 用 `position: fixed` + `top: var(--app-top)`（visualViewport 的
    `offsetTop`）+ `height: var(--app-h)`（`height`）钉在**可见矩形**上，同时把布局滚动归零、
    页面自身 `overflow: hidden`。只缩高度不跟偏移，就会出现「点输入框后正文消失、底部一大片空白」——
    iOS 会把布局视口整体上滚去露出输入框。
  - 输入条布局：按钮（加号 / 发送）全部收在**右下角**，正文从胶囊左内边距开始 ——
    加号放在左侧时每行都要为它让出 34px，手机宽度更该留给文字。
  - 输入框的回车语义按指针类型分流：桌面 Enter 发送 / Shift+Enter 换行；
    触屏 Enter 换行、**连按两次（800ms 内）发送**，右侧圆键照旧可用。
    时间窗是必要的：只按"内容以换行结尾"判断会把「空一行继续写」误判成发送。
    触屏上发送会**收起键盘**（`blur()` 必须在用户手势的同步栈里，iOS 只在那里允许收键盘）；
    桌面不 blur，发完还能接着敲下一条。
  - 历史面板顶部有搜索框：按**全文**匹配（不是列表里那行截断摘要），
    空白分词、每词都要命中（AND）、大小写不敏感。
- 单会话内的「重跑」链路（2026-11-15 补齐）：
  - **运行中发消息 = 排队**（`queue_message`）：`send_message` 在 run 飞行中会被 claim 直接拒绝，
    走排队语义与桌面 AgentMessageQueue 一致；附件不能排队，明确提示而不是静默丢弃。
    - 追加能力按 runtime 而异：**Claude 支持，Pi 不支持**（adapter 没有 `sendQueuedMessage`）——
      失败时服务端回 `code: QUEUE_UNSUPPORTED`，页面弹「停止本轮并发送」确认，
      确认后 `stop_agent` + 短轮询重发（只在「仍在运行」这类错误上重试，不会重复发）。
    - 「是否在跑」以 `session_detail.meta.active` 为准，并接受 claim 拒绝（`AGENT_RUN_ALREADY_ACTIVE`）
      作为兜底信号 —— 客户端的事件推断在刷新/断帧后必然落后。
  - **编辑重发 / 回退**（`rewind_session`）：点用户消息的「⋯」→ 确认 → 回退到这条之前，
    原文回填输入框。回退范围**只到对话**（文件改动不回滚，那需要桌面端工作区历史），
    确认页里写清楚，避免用户误以为文件也回去了。
  - **文件预览**（`read_text_file`）：工具行里的路径可点开；图片仍走 `read_file_as_data_url`，
    文本走新命令（只读前 256 KB、前 8KB 含 NUL 判二进制），与图片共用同一条授权链，
    且**不返回绝对路径**。
  - **`/goal` 客户端命令**：与桌面端 `parseGoalCommand` 同一语法（`webui/goal-command.ts` 是镜像，
    主仓改语法要同步）。`start` / `status` / `pause` / `resume` / `stop` / `clear` 六个分支，
    `@verify/@constraint/@stop` 契约行解析进 contract、不进消息正文。命中后**不进入发送路径**，
    也不会被当成正文发给模型。已有未完成 Goal 时 `start` 先弹「替换并启动」
    （先 `clear_goal` 归档旧目标再 `start_goal`，因为服务端拒绝直接覆盖）。
  - **完成提醒**：页面在后台时跑完一轮 → 系统通知（`Notification`）；非安全上下文
    （`http://<局域网 IP>`）拿不到权限时退化成标题前缀「●」，回到页面自动还原。
- 覆盖层（模型菜单 / 预设面板 / Goal 编辑器 / 大图）统一走 `overlay.ts`：Esc 关闭 + 打开即聚焦，
  不让任何一层只能用鼠标退出；
- WS 命令的请求/响应类型固定在 `protocol.ts`（与服务端 `handleRemoteCommand` 对齐）。

## 5.4 能力补齐（2026-11-15 晚）：上下文占用 / 回退还原文件 / 工具输出 / @ 提及

- **上下文占用条**：顶栏胶囊内显示百分比（`63%`），数据 = `context_window` 事件 +
  `get_agent_runtime_contexts` 快照（重连水合）+ 最后一条 assistant 的 `usage.input_tokens`。
  口径与桌面 ContextUsageBadge 一致：压缩阈值 = 窗口 × 0.775，达到阈值的 80% 转警示色。
  点徽章打开设置菜单（压缩入口就在里面）。快照命令对网页按发布白名单二次收口
  （它不带单个 sessionId，不收口就能枚举任意会话的运行状态）。
  **2026-11-16 修正**：`context_window` 是一次性事件且 `run_idle` 会清空运行时快照，
  再加 `get_agent_runtime_contexts` 过去用 `isAgentSessionActive` 二次过滤 —— 跑完一轮后
  页面必然拿不到窗口，信息条一直「未知名」。现在按会话把最后已知窗口持久化到
  `agent-context-windows.json`，`listKnownAgentRuntimeContexts()` 合并「活跃快照 + 持久化值」
  返回（活跃优先）；`restore_agent_streams` 仍用只含活跃快照的 `listActiveAgentRuntimeContexts`。
  **更上游的断链**：事件本身也发不出来 —— `AgentSendInput.onContextWindow` 在
  `createElectronAgentRuntimeQuery` 里没被塞进 `providerInput`，runtime 的 `toProviderInput()` 白名单
  把它丢掉，Pi/Claude adapter 从自身 input 读到的回调永远是 undefined（桌面 orchestrator 直传 adapter 所以正常）。
  修复：宿主构造 query 时把回调放进 `providerInput` 透传通道，并在 `AgentQueryInput` 契约里正式声明该字段。
  判断信号：持久化文件 `agent-context-windows.json` 是否出现 —— 不出现说明事件根本没发，不是读取问题。
- **回退还原文件**：编辑重发确认页加「同时还原文件改动」勾选（默认开）。勾选走
  两段式 `rewind_prepare(mode:'both')` + `rewind_execute`：先给文件清单（还原/删除）
  让用户确认再执行；prepare 失败（内核不支持 / 工作区历史不可用）自动降级为仅对话回退。
  非 committed 状态（进入恢复流程）提示去电脑端对账。
- **工具行完整输出 / 入参**：投影 `tool_result` 增加 `output`（提取 text 块，4000 字上限、
  超长保首尾）、`tool_use` 增加 `inputText`（JSON，1500 字上限）。展开工具行按等宽正文
  渲染「参数 / 输出」。这是个安全决策的放宽：工具输出可能带文件内容，但有界且网页
  本就被授权读取工作区文件（`read_text_file`）。
- **`/` 与 `@` 提及（2026-11-16 对齐桌面端语义）**：桌面端是 `/` 触发 Skill、`@` 引用文件，
  WebUI 第一版做反了（`@` 弹技能），现已改正：
  - `/` 弹技能候选，数据来自 `list_skills`（按会话的工作区 slug 推导，不接受客户端指定）；
    候选**不再硬截断到 8 个**（后端有 20 个就显示 20 个，面板可滚动）。选中插入
    `/skill:<slug>` token，发送时按桌面同款正则提取 `mentionedSkills` 做技能路由。
  - `@` 弹文件候选，数据来自新增的 `list_workspace_files`：只列会话授权根内的文件，
    返回相对根的路径（POSIX 风格，不暴露机器绝对路径），跳过 `node_modules`/`.git` 等；
    双白名单（`WEBUI_ALLOWED_COMMANDS` + `WEBUI_SESSION_SCOPED_COMMANDS`）都要登记。
    选中插入 `@file:<相对路径>` token。两种 token 都留在正文里给模型看。

## 5.5 宽屏（≥1024px）：桌面浏览器不是「放大版手机」

手机版式原样保留，以下全部收在 `@media (min-width: 1024px)` 里：

- **内容列**：正文列（720px）与输入条、顶栏同宽居中 —— 桌面习惯「内容列」，不拉满屏；
- **历史对话 = 左侧栏**：非模态（无遮罩、不锁页面），正文通过 `.app:has(.history-sheet)`
  让出 340px（`--rail-w`）；不支持 `:has` 的老浏览器退化为覆盖式侧栏；
- **悬停显示消息操作**：`@media (hover: hover)` 下 `.turn-actions-btn` 悬停/聚焦才出现，
  触屏保持常显；
- 顶栏胶囊在宽屏下读作工具栏（`border-radius` 收小）。

手机版式原样保留，桌面差异只由媒体查询驱动，没有第二套组件。

## 6. 验收清单

1. 只开 WebUI、不开移动模式：`/s/<id>` 可访问，`/ws` 的 `send_message` 正常。
2. 把 WebUI 网卡改成 `127.0.0.1`：手机上的 Pocket 仍然可连（端口分离的核心断言）。
3. 网页 token 连 Pocket 端口：401（凭据分离）。
4. 网页 token 调 `list_sessions` / `delete_session`：被拒。
5. 网页 token 调另一未发布会话的 `get_sdk_messages`：被拒。
6. 归档已发布会话：`/s/<id>` 立刻 404，面板条目消失。
7. 打包产物：`process.resourcesPath/webui/index.html` 存在，且页面为压缩响应。
8. 运行中发一条消息：提示「已加入队列」，本轮结束后自动发出（不报错）。
9. 对某条用户消息「编辑重发」：确认后该条及之后消失，原文回到输入框；文件未被回滚。
10. 点工具行里的文件路径：文本文件显示正文，二进制文件提示不可预览。
