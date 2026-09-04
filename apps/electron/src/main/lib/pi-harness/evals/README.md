# Pi Harness Phase 6 replay evals

这些 fixture 是**纯本地、零模型调用**的 JSON 重放用例。`replay.ts` 只重放 Project Graph 事件和 Pi Harness sidecar 事件，再运行既有的 focus、verification/reconcile 与 telemetry 逻辑；它不会写 session 文件、调用 Pi Adapter、排队 prompt 或消耗 autonomy budget。

## 覆盖的上线门槛

| Fixture | 证明的约束 |
| --- | --- |
| `manual-compact-boundary.json` | 手动 `/compact` 没有 Goal、Turn、候选或用量事件。 |
| `stop-boundary.json` | Stop 只中断当前 Turn 并暂停 Goal，不创建 follow-up Turn。 |
| `new-goal-conflict-boundary.json` | 明确的新目标只提出独立最小骨架，不恢复旧方向。 |
| `retry-compaction-single-turn.json` | native retry 与自动 compaction 仍属于一个 Turn，`taskTransitions=0`。 |
| `failed-verification-no-change-loop.json` | 无新 Write/Edit 的失败验证不产生 shadow candidate。 |
| `verified-readback-and-shadow-ready.json` | readback + 显式验证契约可 verified；后续节点只记录 shadow candidate。 |

## 本地诊断导出

`collectSessionPiHarnessTelemetry(sessionId)` 从本地 Graph JSONL 和 sidecar JSONL 读取并汇总：

- 按 Goal 归因的模型调用、token、retry、compaction、耗时与已记录成本；
- shadow candidate 数量及阻断原因；
- verification coverage、重放后发现的 stale `verified`；
- 被 loop breaker 阻断的“失败且无新修改”验证；
- pause 数量和 pause 后新 Turn 的**人工审计信号**。

该 API 不注册 IPC、不上传数据，也不返回 prompt、命令、工具输入/输出、文件路径、hash 或 fact subject。`serializePiHarnessTelemetry()` 用于稳定的本地 JSON 导出/回归比较。

当前 shadow-only 版本没有 `goal_resumed` 自动执行事件，因而不存在可诚实计算的“自动恢复成功率”。Telemetry 将任何 `goal_paused` 后的新 Turn 作为 `turnsStartedAfterPause` 审计信号，而非自动恢复成功；上线门槛为零。若未来另行批准自动恢复，必须同时新增显式 resume event、用户/host 发起来源、成功/失败终态和独立的 budget/kill switch 评审。

## 运行

```bash
cd apps/electron
bun test src/main/lib/pi-harness/evals/replay.test.ts src/main/lib/pi-harness/telemetry.test.ts
```
