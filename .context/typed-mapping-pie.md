# Goal 畅通化改造计划（对齐 Codex / Claude Code）

## Context

现在 Goal 规则太严，模型一次小失误、一次网络错误或一次超时就让整个目标停下。
Codex 和 Claude Code 都偏向"继续干"。本次保留 Profer 现有的 Codex 式架构
（Controller + update_goal 工具 + 空闲续跑），只放宽判定规则、补上重试和恢复路径、改善可见性。
不新增状态枚举，不改存储格式（`goals.json` 旧数据可直接读）。

## 改动（按优先级）

### 1. 每轮不再强制汇报（最关键）
文件：`main/lib/goal-session-service.ts`、`main/lib/goal-loop.ts`、`main/lib/goal-tools.ts`

- 新增 `assessGoalTurnProgress(messages)`（放在 `goal-session-service.ts`，复用已收集的 `messages`）：
  - `empty`：没有 assistant 文本、也没有工具调用
  - `all_tools_failed`：有工具调用但 tool_result 全部 `is_error`
  - 否则 `progress`
- 本轮没调 `update_goal`：有进展 → 按 `continue` 处理，`outcome: 'success'`；无进展 → `failed`。
- `evaluateGoalContinuation`：`continue` 不再要求 evidence。只有"无进展 / 运行失败"才累计失败次数。
- `complete` 仍然必须带非空 evidence（保留防假完成的底线）。
- `maxConsecutiveFailures` 默认保持 3，含义变成"连续 3 轮无进展"（对齐 Codex）。
- 迭代 prompt（`buildGoalIterationPrompt`）改写：
  - 去掉"每轮必须调用 update_goal"
  - 改为"完成或确实受阻时调用 update_goal；否则正常结束本轮，宿主会自动续跑"
  - 吸收 Codex continuation 的要点：先判断上一轮属于"有进展 / 已核实的等待 / 无进展"；完成前逐条审计

### 2. 预算可选，到点收尾而不是砍断
文件：`packages/shared/src/types/agent.ts`、`shared/src/utils/goal-contract.ts`、`goal-loop.ts`、`goal-controller.ts`、`goal-update-validation.ts`

- `AgentGoalLimits.maxIterations` / `maxDurationMs` 改为可选；`DEFAULT_GOAL_LIMITS` 只保留 `maxConsecutiveFailures: 3`。
- `goalBudgetReason` / `getGoalBudgetExhaustedReasons`：未设置的预算视为不限。
- 删除 `runTurn` 里的 deadline 定时器（目前会在轮中 `requestStop`）。预算统一在轮次边界检查：本轮自然结束后，如果已超预算就转 `budget_limited`，不再排下一轮。
- 预算接近用完时（剩最后 1 轮，或时长/token 已用 ≥ 80%），prompt 追加 Codex 式收尾提示："收尾、不开新的大块工作、如实汇报未完成部分"。
- 表单与 IPC：
  - `parseGoalLimitsInput`：三项都是"留空 = 不限"
  - `validateGoalUpdatePatch`：允许传 `null` 清除某项预算
  - 编辑器预填当前值，所以留空就是用户的明确选择

### 3. 错误有限重试，不计入失败
文件：`goal-session-service.ts`、`goal-controller.ts`

- 运行失败时按错误文本分类，复用 `error-patterns.ts` 的 `isTransientNetworkError` / `isTransientUpstreamText` / `isMalformedResponseError`，再加限流/额度关键词（429、rate limit、usage limit、额度）：
  - **可重试**：Goal 保持 `active`，Controller 按 1 / 5 / 15 分钟（±20% 抖动）重新排程，最多 3 次。
    - 重试计数存进 `AgentGoalState.retry?: { attempt: number; nextAt: number; error: string }`，让 UI 能显示。
    - 3 次后转 `paused`，原因码 `retry_exhausted`。
  - **不可恢复**（鉴权、余额等其它错误）：直接转 `paused`，原因码 `run_error`，detail 带上错误文本。
- 这两类都不进 `consecutiveFailures`。
- 新增原因码 `user_interrupt` / `retry_exhausted` / `run_error`，同步改 `GOAL_REASON_CODES` 和 `GOAL_REASON_LABELS`（`shared/src/utils/goal-lifecycle.ts`）。

### 4. 中断 = 暂停；用户发消息自动续上
文件：`main/ipc.ts`、`goal-session-service.ts`

- `STOP_AGENT` 处理器：`goalSessionService.stop` 改为 `pauseForInterrupt`，即 `paused` + `user_interrupt`。"停止 Goal"按钮和 `/goal stop` 仍是真停止。
- `SEND_MESSAGE` 处理器：用户发普通消息时（`triggeredBy` 为空或 `'user'`），调用 `goalSessionService.onUserMessage(sessionId)`：
  - 状态为 `blocked`，或 `paused` 且原因是 `user_interrupt` / `retry_exhausted` → 自动 `resume()`
  - Controller 已有 `canRun` 等待，用户这轮跑完后会自动进入下一个 Goal 轮次（对齐 Codex 的空闲续跑、Claude Code 的"发消息继续"）
  - 用户显式 `/goal pause` 和 `app_restart` 仍然需要手动 resume
- 已经 `active` 的 Goal 期间用户插话：保持现状（用户轮跑完后续跑）。

### 5. 计划模式不再拒绝，而是等待
文件：`main/ipc.ts`、`goal-session-service.ts`

- `permissionError` 不再阻止 start/resume。`canRun` 增加"非计划模式"条件：计划模式下 Goal 保持 `active`，不计轮次。
- 新增只读查询 `isWaitingForExecutableMode`，通过 `AgentGoalState.waiting?: 'plan_mode'` 推给 UI。

### 6. 可见性
文件：`goal-session-service.ts`、`renderer/components/agent/GoalStatusBar.tsx`

- 去掉 Goal turn 的 `suppressUserMessagePersistence: true`。orchestrator 已经会写带 `_goalIteration` 标记的用户消息，`SDKMessageRenderer` 已有 `GoalIterationDivider`，分隔条会自动出现（runtime 仍只收 `internalPrompt`）。
- 状态栏显示：
  - token 用量：设了预算时显示 `12k / 50k`，否则显示 `12k`
  - 重试倒计时：`网络错误，3 分钟后第 2 次重试`
  - 计划模式等待：`计划模式中，切换后自动继续`
  - 中断后：`已暂停 · 发消息即可继续`

## 不做（避免过度设计）
- 不引入 Claude Code 式小模型裁判（第二阶段再评估）
- 不加 `create_goal` / `get_goal` 模型工具
- 不改 SQLite / 存储结构

## 测试（BDD，先写失败用例再实现）
在现有测试文件中补充场景：

- `goal-loop.test.ts`
  - 给定没有 update_goal、有工具成功 → 继续、失败数清零
  - 给定连续 3 轮空回复 → failed
  - 给定 complete 无证据 → 不完成
  - 给定预算未设置 → 不限
  - 给定剩余 1 轮 → prompt 含收尾提示
- `goal-controller.test.ts`
  - 给定轮中超时 → 本轮不被打断，结束后 `budget_limited`
  - 给定可重试错误 → 1/5/15 分钟重排，第 4 次转 `paused/retry_exhausted`
  - 给定不可恢复错误 → 立即 `paused/run_error`
- `goal-session-service.test.ts`
  - 给定 blocked 时用户发消息 → 自动 resume
  - 给定 `/goal pause` 后用户发消息 → 不 resume
  - 给定计划模式 → active 但不运行
- `goal-update-validation.test.ts` / `goal-contract.test.ts`：`null` 清除预算、留空 = 不限
- `goal-lifecycle.test.ts`：新原因码
- `GoalStatusBar.test.tsx`：token / 重试 / 等待文案

## 验证
1. `bun test goal` 全绿，`bun run typecheck` 通过。
2. `bun run dev` 手测，Claude 与 Pi 各跑一次：
   - `/goal` 一个需要多轮的小任务，确认无汇报轮能续跑、转折处有分隔条
   - 轮中点停止 → 显示已暂停 → 发一句话 → 自动续跑
   - 断网一轮 → 看到重试倒计时
   - 设很小的 token 预算 → 收尾后 `budget_limited`
3. 改完运行 code-simplifier 精简。
4. 递增版本：`@profer/shared`、`@profer/electron` 各 patch +1。
5. CLAUDE.md / README 的 Goal 描述更新，需要另行征得你同意后再改。
