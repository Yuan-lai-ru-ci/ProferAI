# 新 runtime 链切默认：就绪度审计与分期（2026-11-09）

目标：**下一次发版把新链（`packages/agent-runtime` + `agent-runtime-entry`）设为默认**，旧编排器只作回滚保留。

当前状态：两个开关都默认关闭（`PROFER_RUNTIME_HEADLESS === '1'`、`PROFER_RUNTIME_DESKTOP === '1'`）。
直接翻默认会踩下面 4 个阻断项，其中第 1 项是全局降智，不是局部功能缺失。

---

## 一、阻断项（翻默认就会退化）

### B1. 系统提示词不是同一份（最严重）

| | 旧链 | 新链 |
| --- | --- | --- |
| 装配 | `assembleAgentSystemPrompt`（`agent-prompt-assembly.ts:23`） | 无 |
| 来源 | `buildSystemPrompt`（`agent-prompt-builder.ts:164`）：核心规则、工具指南、预设段、平台 overlay、记忆段、生图契约、子 Agent 策略、工作区路径 | `ResourcePort.load` 只返回 `projectInstructions`（= 工作区 profile 正文，`agent-runtime-host.ts:709`） |
| 兜底 | — | 无 profile 时 `promptFromPrepared` 回落到 **`input.prompt`（用户消息）当系统提示词**（`agent-runtime-provider-preparation.ts:21`） |

结论：新链的 system prompt 与旧链不是「少一点」，是**另一个东西**。

### B2. 动态上下文与引用注入全部缺失

旧链在用户消息前拼这些（`agent-orchestrator.ts:2094-2130`），新链一个都没有：

- `buildDynamicContext`：工作区名 / cwd / MCP 服务器名单 / 禁用工具组 / 浏览器上下文；
- `appendRunOriginPrompt`：run 来源上下文；
- `buildReferencedSessionsPrompt`：`@` 会话引用；
- `mentioned_tools`：`@` Skill / MCP 引用；
- `buildContextPrompt`：**无 resume 时的历史回填**（旧会话迁移、首次运行）；
- 任务 SOP（`promptAssembly.taskPrompt` 追加到本轮消息）。

### B3. 文件回退（Shadow Git）在新链不可用

`beginWorkspaceShadowTurn` / `endWorkspaceShadowTurn`（`workspace-shadow-turns.ts:102/187`）与写入证据只接在旧编排器：

- 旧链：`agent-orchestrator.ts:1383`（begin）、`:4143`（end）、证据来自 Pi `onFileMutation`/`onFileWrite`（`:2613/:2640`）与 Claude `resolveWriteToolFact`（`:3137`）；
- 新链：`agent-runtime-*.ts` 里 `onFileWrite` / `onFileMutation` / `onRewindTurn` / `fileWritesByToolUse` **零命中**。

真机表现：新链会话回退报「该会话还没有文件变化记录」。

### B4. 提示词模式与命令

- `light` 模式（新会话短问候不加载 MCP / skill / 动态上下文）新链没有，一律按 standard（`agent-runtime-host.ts:664` 注释已承认）；
- `/compact` 在新链被当普通文本发送（旧链 `agent-orchestrator.ts:2132` 特判）。

---

## 二、非阻断但需记录

| 项 | 现状 | 处置 |
| --- | --- | --- |
| Goal 输入 | 新链排除，一律回旧链（GAP-6） | 切默认后 Goal 仍走旧链，功能正常；后续再下沉 |
| Skill 任务路由 | 旧链 `routeSkillsForTask`（`:2465`）按任务挑 skill；新链只按预设白名单全量给 | S1 一并补 |
| Pi 文件检查点 | 新链已接（`checkpointTurn`） | 无 |
| 附件目录提示 | 旧链 `attachedDirectoriesPrompt` 进 system | S1 一并补 |

---

## 三、分期与验收

### S1 提示词装配（阻断 B1 + B2 + B4）

**关键难点（必须先解决）**：Pi 的 `toolNames` 决定提示词里的工具指南，而新链的工具装配是**延迟**的
（`prepared.deferredToolAssembly` 在 provider `stream()` 内才 `build(sdk)`，`pi-agent-adapter.ts:285`），
提示词却要在 provider 启动前定型。

方案：给 provider 契约加「延迟系统提示词」——`providerInput.systemPromptForTools?: (toolNames: string[]) => string`。
Pi adapter 在工具装配完成后调用它解析最终 system prompt；Claude 没有这个依赖，在 preparation 里直接定型。

步骤：
1. 抽出 `assembleAgentTurnPrompt`：输入全部显式（session meta / 策略快照 / 工作区 / 消息 / skill 路由结果），
   内部只调既有 builder，不新增第二套规则；
2. 旧链改为调用同一函数（结构上保证只有一份实现，而不是靠测试对齐）；
3. 新链接线：`agent-runtime-provider-preparation` 组装 system prompt + 本轮 prompt（动态上下文、引用、SOP、notice 前缀）；
4. `light` 模式与 `/compact` 判定回到入口；
5. 验收：同一 fixture 下两链产出的 `systemPrompt` 与最终 `prompt` 逐字符相同（golden test）。

### S2 文件回退归属（阻断 B3）

1. `runRuntimeHeadlessEntry` 在 run 前 `beginWorkspaceShadowTurn`（带会话附加目录），拿到 baseline；
2. Pi 写回调（`onFileMutation` / `onFileWrite` / `onRewindTurn`）在 `agent-runtime-provider-preparation` 接线，
   证据进同一份账本；Claude 从 assistant `tool_use` 取 `resolveWriteToolFact`；
3. 终态 `endWorkspaceShadowTurn`（sessionId / turnId / runtime / startedAt / evidence / baseline）；
4. 验收：新链会话改文件 → 回退 → 文件按三方语义恢复；与旧链同一 workspace 交替回退不串。

### S3 杂项对齐

`/compact`、Goal 下沉（可选）、`light` 与 skill 路由的边界用例。

### S4 翻默认

`resolveDesktopRunChain` / `canUseRuntimeHeadless` 默认值反转（未设置即新链，显式 `0` 回旧链），
全量回归 + 真机 e2e（桌面 / 飞书 / automation / remote 四条入口）。

### S4 翻转默认链（2026-11-09 16:4x）

- `canUseRuntimeHeadless`：`PROFER_RUNTIME_HEADLESS !== '0'`（默认新链，显式 0 回旧链）；
- `isDesktopRuntimeSwitchEnabled`：`PROFER_RUNTIME_DESKTOP !== '0'`；
- 两个开关的注释、`runAgent` 入口注释同步改为「默认开启」；
- 受影响的存量测试明确声明自己测的是旧路径（`agent-goal-runtime-bridge.test.ts` 置 `0`）；
- 新增 `agent-runtime-desktop-switch.test.ts` 4 pass（未设置=新链、`0`=旧链、其他值不构成关闭、Goal 输入回旧链）。

**全量回归（`apps/electron/src/main/lib`，439 文件）**

```text
3635 pass / 6 skip / 2 fail
```

两个失败均在 `remote-service-send-message.test.ts`，原因是**并行未提交改动** `remote-service.ts:1695`
现在缺省生成 `uuid`（`randomUUID()`），而测试仍断言「缺省时不应出现该字段」。与本次改造无关，未改动。

**真机冒烟（无任何开关，默认链）**：新会话「你好」→ light 提示词生效、正常回复。

**待人工验收（我无法代做）**：桌面点发送的完整投影（backlog 回放、STREAM_COMPLETE/STREAM_ERROR、
草稿晋升、删除/分支守卫）、飞书、automation、remote 四条入口。

---

## 四、当前进度

- [x] 审计（本文档）
- [x] **S1.1 系统提示词装配**（2026-11-09 15:5x）
  - 新增 `agent-runtime-turn-prompt.ts`：把新链已有事实（策略快照 / 会话元数据 / 工作区 / 模型）映射成
    旧链同一份 `assembleAgentSystemPrompt` 的入参，不复制提示词文本；
  - `agent-runtime-provider-preparation.ts`：装配结果优先于 `prepared.systemPrompt`
    （后者只是工作区 profile 正文），Pi 额外拿到 `taskPrompt`；
  - 修掉「无 profile 时把用户消息当系统提示词」的回落；
  - 测试：`agent-runtime-turn-prompt.test.ts` 4 pass（含 provider preparation 接线断言），
    `agent-runtime-*` 194 pass，根 typecheck 16/16。
  - 遗留：`allowedPresetOperations` 暂传空（预设操作意图 gate 未下沉），`toolNames` 暂空（S1.3）。
- [x] S1.2 动态上下文与引用注入
  - `agent-prompt-utils.ts` 抽出 `formatContextHistoryBlock`（旧链 `buildContextPrompt` 改为调用它，格式只有一份）；
  - `buildRuntimeTurnUserPrompt`：运行来源 → `@` 工具（按**实际加载**的 MCP 过滤）→ `@` 会话 → 动态上下文 →
    无 resume 时的历史回填，块顺序与旧链逐项对齐；
  - 契约扩展：`AgentRuntimePreparedContext.prompt`，`provider-bridge` 用 `prepared.prompt` 覆盖 query prompt
    （否则动态上下文拿不到实际 MCP 名单）；
  - 接线点：`createElectronAgentHost` 的 `queryPreparation` 包装层；
  - 测试：`agent-runtime-turn-prompt.test.ts` 7 pass（含回填/resume 互斥、MCP 过滤）。
- [x] S1.3 延迟系统提示词（toolNames）
  - Pi 契约新增 `resolvePromptForTools(toolNames) → { systemPrompt, taskPrompt }`；
  - `applyPiPreparedQuery` 在 `prepared.tools` 就绪后重算，未就绪时保留占位；
  - 测试：`pi-delayed-prompt.test.ts` 3 pass。
- [x] S2 文件回退归属
  - 新增 `workspace-shadow-write-evidence.ts`：证据采集规则（哪些工具算写入、同一路径如何合并）只有一份，
    旧编排器与新链共用；编排器本地类型/去重函数/工具表全部删除，改为引用；
  - `runRuntimeHeadlessEntry`：run 前 `beginWorkspaceShadowTurn`（带会话附加目录 + baseline），
    终态 `finally` 里 `endWorkspaceShadowTurn`（未真正开始的请求不记 turn）；
  - 证据来源：assistant `tool_use`（两 runtime 通用）+ Pi 受控写回调 `onFileWrite`（Bash 提升的写入）；
    草稿区过滤与旧链同一判据；
  - 测试：`agent-runtime-entry-shadow.test.ts` 3 pass（begin/end、证据映射、并发拒绝不记空 turn）。

### S2 真机验收（2026-11-09 16:1x）

| 场景 | 结果 |
| --- | --- |
| Write 工具建文件 → 归属 | `attribution: added`，1 条变更 |
| 回退 session-start | `committed`，`deleted: [s2-rewind-probe.md]`，文件真的消失 |
| 回退后 notice | `pendingRewindNotice` 写入 → 下一轮注入 `<workspace_rewind_notice>` → 首条消息后清空 |
| Bash 建文件 → 归属 | `unconfirmed`，回退保留文件 |
| 旧链对照（Bash） | 旧链同样 `unconfirmed`、同样不删 → **行为对齐，不是回归** |

### S1 真机验收（2026-11-09 16:0x，dev + `PROFER_RUNTIME_HEADLESS=1`，pi/deepseek-flash）

| 项 | 证据 |
| --- | --- |
| 系统提示词 | Pi 会话文件里出现完整文本（含「你是 Profer 桌面应用中的通用 AI 助手」），不再只有 profile 正文 |
| 动态上下文 | 会话文件 user 消息含 `<workspace_state>工作区: 默认工作区 / MCP 服务器: github`、`<working_directory>`、`**当前时间: …**`；模型正确答出时间与工作区名 |
| 持久化隔离 | Profer JSONL 里的 user 消息仍只有原始文本（30 字），动态上下文不污染对话历史 |
| 热启动 | 第二轮答出第一轮的问题；Pi 会话文件仍同一个、user 轮次 2 → 没有新建 session |
| 回填互斥 | 有 resume 的两轮均无 `<conversation_history>`（provider 自己持有历史） |

验收中发现并修掉：`workspaceName` 只从 `input.workspaceId` 取，headless 入口不带该字段时提示词里只有目录没有名字。
改为 `input.workspaceId ?? meta.workspaceId` 两条来源都看。

**未验收（属 S2）**：文件回退在新链仍不可用——`beginWorkspaceShadowTurn` 未接线，回退会报「该会话还没有文件变化记录」。
- [x] S3 杂项对齐
  - `/compact` 原样透传（不包动态上下文 / 历史回填）；
  - `light` 模式：新会话无上下文的短问候走精简 system，不拼动态上下文/引用/历史，资源端口不加载 MCP/Skill；
    只有 light 才写 `promptMode` 字段，standard 的 metadata 形状零变动；
  - Skill 目录：资源端口为 Pi 构建 `<skill_catalog>`（Claude 由 SDK 自己发现，与旧链一致）；
  - 测试：`agent-runtime-turn-prompt.test.ts` 11 pass。
  - **遗留（不阻断使用）**：任务级 skill 路由（`routeSkillsForTask` 的选型提示）尚未下沉，
    目前模型能看到完整 catalog 并自行读取 SKILL.md，但不享受「按任务预选」提示。

### S3 真机验收（2026-11-09 16:3x）

| 场景 | 结果 |
| --- | --- |
| 新会话首轮「你好」 | Pi 文件里是精简 system（含「简短对话」），无「## 做事方式」、无「**当前时间」→ light 生效 |
| 同一会话第二轮 | 动态上下文与完整核心规则全部回来 → 自动升回 standard |
| Skill 目录 | 默认开发工作区没有 skill，catalog 为空（单测覆盖非空路径） |
- [x] S4 翻转默认链 + 全量回归（四条入口全部翻转，见下表）

  | 入口 | 开关 | 默认 |
  | --- | --- | --- |
  | 桌面 | `PROFER_RUNTIME_DESKTOP` | `!== '0'` → 新链 |
  | 飞书 / push（headless） | `PROFER_RUNTIME_HEADLESS` | `!== '0'` → 新链 |
  | 定时任务 | `PROFER_RUNTIME_AUTOMATION` | `!== '0'` → 新链 |
  | 手机端 Pocket（remote） | `PROFER_RUNTIME_REMOTE` | `!== '0'` → 新链 |

  回滚口径统一：把对应变量设为 `0` 即回旧链，不需要发版。
  受影响的存量测试已按新语义修正：automation fixture 区分「任意路由的 input」与「只有旧入口的 legacyInputs」，
  remote 的 `send_message` fixture 同时 mock 新入口并注入恒无阻塞的预检。
- [x] S4.1 回退后「文件改动」面板残留（2026-11-09 17:0x，验收中发现）
  - 现象：非 Git 目录回退后文件确实被删除，但右侧「文件改动」把该文件继续列为「新建」；
  - 根因：`agentNonGitFileChangesAtom` 是渲染层在 `tool_result` 时累积的内存表，全仓没有任何回退清理点
    （与新旧链无关，两条链都累积）；
  - 修复：`session-file-changes.ts` 新增 `dropRewoundSessionFileChanges`（按回退返回的 `deleted`/`restored`
    尾部匹配剔除，纯文件名不参与匹配以免误伤同名文件；`conflicts` 保留），
    `AgentView.handleRewindCommitted` 在 bump diff 版本号后同步清理该会话记录；
  - 测试：`session-file-changes.test.ts` 7 pass；`apps/electron/src/renderer` 1958 pass。
  - 注意：已存在于内存里的旧记录不会自动消失，需重启应用后重新走一次「写文件 → 回退」。

- [x] S4.2 新链丢失 `permissionModeOverride`（2026-11-09 17:1x，验收中发现的阻断级缺陷）
  - 现象：新建会话里 Agent 调用 Write 后永久停在「等待批准」，无人值守入口（automation / 飞书 / 调试通道）会死锁；
  - 三层原因：
    1. `agent-runtime-entry.ts` 构造 query 时**没有**把 `input.permissionModeOverride` 带进去
       （旧链一直传同一字段），于是显式 bypass 在新链里凭空消失；
    2. `permissionService.createCanUseTool` 本身不看权限模式，只区分「只读自动放行 / 其余询问」；
       旧链靠 Claude SDK 在 bypassPermissions 下自行跳过回调，而 Pi 的工具是本地包装
       （`wrapToolWithPermission`），装了 canUseTool 就一定回调，等于把无界面入口挂死；
    3. 调试通道 `/send` 没给权限模式（automation 与飞书 bridge 都显式传了 bypass，只有这里漏了）。
  - 修复：
    - entry 透传 `permissionModeOverride`；
    - `createElectronPermissionPort` 增加 `isBypassPermissions(sessionId)` 注入位，
      bypass 时直接 `allow` 且**不产生审批请求**（host 用 run facts + 会话元数据两个来源判定）；
    - `applyPiPreparedQuery` 在 bypassPermissions 下不安装 `canUseTool`；
    - 调试通道建会话/发消息默认 `bypassPermissions`，可用 `permissionMode` 覆盖。
  - 测试：`agent-runtime-permission-port.test.ts` 6 pass（新增 2 条 bypass 用例）；
    `agent-provider-pi` + `agent-runtime` 448 pass；`apps/electron/src/main/lib` 3647 pass；
    `apps/electron/src/renderer` 1958 pass；根 typecheck 16/16。
  - 真机：project 模式下 Write → `tool_result.proferFileChanges = [{path, source:'write'}]` 已落盘。

- [x] S4.3 消息气泡文件改动 chip（`proferFileChanges`）
  - 新链没有旧链 `fileWritesByToolUse` 的等价实现，chip 与历史回放都丢失；
  - 新增 `agent-file-write-chips.ts`（按会话记账 + 挂载），在 `provider-bridge` 的唯一出口装饰消息，
    桌面与 headless 两条入口同时生效；记账仍只信 provider 受控写回调，不解析 Bash 文本；
  - `onFileWrite` 改为始终注册；回退/结束时 `dropSession`，单会话上限 256 条防无界增长；
  - 测试：`agent-file-write-chips.test.ts` 8 pass。
  - 注意：managed 模式下写会话目录属于草稿区，按既有语义**不产生** chip（旧链一致）；
    project 模式写项目文件才可见。

- [ ] S3.1 任务级 skill 路由（`routeSkillsForTask`）——不阻断使用，后续补
