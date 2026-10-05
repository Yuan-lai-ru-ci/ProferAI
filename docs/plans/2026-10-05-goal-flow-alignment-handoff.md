# Goal 畅通化改造 · 交接文档

> 日期：2026-10-05
> 分支：`feat/goal-flow-alignment`（基于 `fix/skill-gate-hardening` 的 `f292b93f`）
> 状态：代码完成，自动化测试通过，**未手测、未提交**

## 一、为什么改

用户反馈 Goal 用起来"跑不通"：跑几轮就停，或中途失败。

调查结论：Profer 的 Goal 架构接近 Codex，但规则比 Codex 和 Claude Code 严得多，模型一次小失误、一次网络错误或一次超时就让整个目标停下。主要问题：

1. 每轮必须调用 `update_goal` 并带证据，否则算失败，连续 3 次即 failed。
2. 默认预算 20 轮 / 2 小时，到时间直接在轮中砍断。
3. 网络错误、限流都计入失败，没有重试。
4. 停止按钮直接终止 Goal，发消息也不会续上。
5. 计划模式下直接拒绝启动。
6. 对话里看不到轮次分隔，状态栏没有 token 用量。

对标资料：
- Codex：源码 `openai/codex` 的 `codex-rs/ext/goal/`（commit `c2f7fe89`）。空闲后自动开新回合；模型只在完成或受阻时调 `update_goal`；只有 token 预算；用户中断即暂停。
- Claude Code：本机 2.1.289 二进制 + CHANGELOG。本质是会话级 prompt 型 Stop hook，由小模型判定是否达成；错误按 1/5/15 分钟重试；用户发消息继续。

计划原文：`.context/typed-mapping-pie.md`（未纳入版本库）。

## 二、改了什么（行为）

| 场景 | 之前 | 现在 |
|---|---|---|
| 一轮没调 `update_goal` | 算失败 | 有实际工作就继续；只有空回复或工具全部失败才算无进展 |
| 无进展上限 | 连续 3 次失败 | 连续 3 轮无进展（对齐 Codex） |
| 声称完成 | 需证据 | 仍需非空证据（不变） |
| 预算 | 默认 20 轮 / 2 小时 | 默认不限，三项都可选；只在轮次结束时检查，快用完时提示收尾 |
| 网络 / 限流 / 上游繁忙 | 计入失败 | 1 / 5 / 15 分钟（±20%）重试，不计入失败；3 次后暂停（`retry_exhausted`） |
| 鉴权、余额等错误 | 计入失败 | 直接暂停（`run_error`），显示原因 |
| 普通停止按钮 | 终止 Goal | 暂停（`user_interrupt`） |
| 受阻 / 被中断后用户发消息 | 需手动 `/goal resume` | 该轮结束后自动续上（桌面、Pocket、飞书等入口都生效） |
| 计划模式 | 拒绝启动 | 保持 active 等待，切换模式后立即继续 |
| 对话展示 | 轮次连成一片 | 每轮有分隔条 |
| 状态栏 | 轮次 + 耗时 | 加 token 用量/预算、重试倒计时、"发消息即可继续"等提示 |

`/goal stop`、`/goal pause`、重启后的暂停，仍需手动恢复。

## 三、关键实现（按文件）

**共享层 `packages/shared`**
- `types/agent.ts`：`AgentGoalLimits` 的轮次、时长改为可选；新增原因码 `user_interrupt` / `retry_exhausted` / `run_error`；`AgentGoalState` 新增 `retry`、`waiting`；结果新增 `errorKind`。
- `utils/goal-contract.ts`：
  - `AgentGoalLimitsPatch`（`null` = 清除该项预算）、`applyGoalLimitsPatch`
  - `isValidGoalLimits`：预算唯一校验规则，controller 与 store 共用
  - `getGoalBudgetDimensions`：预算维度唯一来源，耗尽判断、收尾判断、剩余预算描述都基于它
- `utils/goal-lifecycle.ts`：`isGoalResumableByMessage`，main 与 UI 共用的"发消息可续上"判定。

**主进程 `apps/electron/src/main`**
- `lib/goal-loop.ts`：重写迭代 prompt（不再强制每轮汇报，吸收 Codex continuation 要点）；新增 `isGoalNearBudget`；`continue` 不再要求证据。
- `lib/goal-controller.ts`：
  - 删除轮中 deadline 定时器
  - 新增 `handleRunError`（退避重试 / 暂停）
  - 新增 `pauseForInterrupt`
  - 新增 `nudge`：等待中的 Goal 立即重检，兜底轮询 30 秒
- `lib/goal-session-service.ts`：
  - `assessGoalTurnProgress`：从本轮 runtime 消息判断进展，`update_goal` 不算
  - `classifyGoalRunError`：复用 `agent-retry-utils.ts` 的 `isAutoRetryableCatchError`，另补限额类正则
  - `onRunFinished`：只对 `user` / `external` 发起者生效
  - 去掉 `suppressUserMessagePersistence`，让轮次分隔条落盘
- `lib/agent-service.ts`：新增 `onAgentRunComplete`，订阅事件总线的 `run_complete`，覆盖桌面与 headless 入口。
- `ipc.ts`：
  - `permissionError` 改为 `isPlanMode`
  - `STOP_AGENT` 改走 `pauseForInterrupt`
  - 切换权限模式后调 `nudge`
  - 订阅 `onAgentRunComplete`
- `lib/goal-store.ts`、`lib/goal-update-validation.ts`：适配可选预算与 `null`。
- `preload/index.ts`：`updateGoal` 类型改为 `AgentGoalLimitsPatch`。

**渲染层 `apps/electron/src/renderer`**
- `components/agent/GoalStatusBar.tsx`：
  - 状态文案抽成 `goalStatusLabel`
  - 两个计时器合并为一个 `useNow`
  - 编辑器中三项预算留空即不限
- `lib/format-tokens.ts`（新）：从 `ContextUsageBadge.tsx` 抽出的共享 token 格式化。

**兼容性**：不改存储结构。旧 `goals.json` 能直接读，旧数据里已有的轮次/时长上限保留生效。

## 四、验证情况

- Goal 相关测试 209 个全部通过，`bun run typecheck` 0 错误。
- 全量 `bun test`：87 个失败。在 `git stash` 前后对比完全一致，均为与本次无关的既有失败（如 `auto-updater.test.ts`），没有新增。
- 3 个多轮测试原先依赖固定 15ms 等待，满载下不稳定，已改为等待状态成立（`until`）。
- 已跑 `/simplify`（复用 / 简化 / 效率 / 层级四路审查），主要发现已修。

**未做：在真实 App 里手测（`bun run dev`），Claude 与 Pi 两种运行时都没测。**

## 五、接手后要做的事

1. **手测**（建议 Claude 与 Pi 各一次）：
   - `/goal` 一个需要多轮的小任务，确认不汇报的轮次能续跑，且有轮次分隔条
   - 轮中点停止 → 显示"已暂停 · 发消息即可继续" → 发一句话 → 该轮结束后自动续跑
   - 断网一轮 → 看到重试倒计时，恢复网络后继续
   - 设很小的 token 预算 → 本轮收尾后变为"预算已耗尽"
   - 计划模式下 `/goal` → 显示等待 → 切换模式 → 立即开跑
   - 从飞书给受阻的 Goal 回消息 → 自动续上
2. **提交**：按项目约定，`@profer/shared` 和 `@profer/electron` 各递增 patch 版本。
3. **文档**：CLAUDE.md / README 的 Goal 描述需更新，**须先征得用户同意**。

## 六、已知取舍与风险

- **进展判断是启发式**：一轮只有文字、没有工具调用也算进展。模型如果一直空谈，要等无进展上限或预算才停。Codex 也是这个口径。
- **自动续上的范围**：只看本轮发起者是 `user` / `external`。定时任务、委派、Goal 自身的运行不会触发。
- **错误分类**：基于错误文本，没有用 orchestrator 的 `TypedError`（它没有透传到 `onRunOutcome`）。更彻底的做法是在 `agent-run-outcome.ts` 透传 `errorCode` / `canRetry`，本次没做，以控制改动范围。
- **存储写入**：`goals.json` 仍是每次状态变化就整文件读写（原有机制）。新增的写入触发很少（等待状态切换、最多 3 次重试），暂未优化。
- **没做的对标项**：Claude Code 的小模型裁判、`create_goal` / `get_goal` 模型工具。可作为第二阶段评估。
