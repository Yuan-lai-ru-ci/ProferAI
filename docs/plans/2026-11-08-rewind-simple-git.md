# 简化 Agent 回退 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 恢复原有 Agent 回退入口和 runtime 行为，并用 Profer 自己管理的影子 Git 快照补上可用的文件回退，不把快照机制暴露成新的用户流程。

**Architecture:** 回退继续由现有消息操作直接触发，不新增预览、计划确认、模式选择或恢复面板。Claude 和 Pi 保留各自的 transcript 回退逻辑；文件快照统一使用 Profer 会话目录中的 bare shadow Git，只保存 Agent 受控修改过的路径，用户项目自己的 `.git`、分支、索引和提交完全不动。文件无法安全恢复时跳过该文件并提示结果，不能删除用户未归属当前 Agent 的文件。

**Tech Stack:** Electron main process、TypeScript、Bun test、现有 `pi-checkpoint-git.ts` / `pi-file-checkpoint.ts`、Claude SDK checkpoint、Pi transcript。

---

### Task 1: 冻结当前行为并标出回退改造边界

**Files:**
- Read: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-orchestrator.ts`
- Read: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-session-manager.ts`
- Read: `/Users/mac/profer/profer-main/apps/electron/src/renderer/components/agent/AgentView.tsx`
- Read: `/Users/mac/profer/profer-main/apps/electron/src/renderer/components/agent/RewindDialog.tsx`
- Read: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/pi-file-checkpoint.ts`
- Test: existing rewind and Pi checkpoint suites

**Step 1: Record the pre-change behavior**

Use `git show 49ea9bd9^:<path>` to identify the parent implementation of every file changed by the rewind work. Separate rewind changes from unrelated collaboration/runtime changes in the same commit.

**Step 2: Run the existing focused tests**

Run from `/Users/mac/profer/profer-main`:

```bash
bun test apps/electron/src/main/lib/agent-session-manager.test.ts
bun test apps/electron/src/main/lib/pi-file-checkpoint.test.ts
bun test apps/electron/src/renderer/components/agent/AgentView.rewind-entry.test.ts
```

Expected: capture the current baseline and any existing failures before edits. Do not change unrelated WIP files.

---

### Task 2: 移除用户可见的复杂回退流程

**Files:**
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/renderer/components/agent/AgentView.tsx`
- Delete: `/Users/mac/profer/profer-main/apps/electron/src/renderer/components/agent/RewindDialog.tsx`
- Delete: `/Users/mac/profer/profer-main/apps/electron/src/renderer/components/agent/RewindDialog.test.tsx`
- Delete: `/Users/mac/profer/profer-main/apps/electron/src/renderer/components/agent/RewindRecoveryPanel.tsx`
- Delete: `/Users/mac/profer/profer-main/apps/electron/src/renderer/lib/agent-rewind-client.ts`
- Delete: `/Users/mac/profer/profer-main/apps/electron/src/renderer/lib/agent-rewind-client.test.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/renderer/components/agent/AgentView.rewind-entry.test.ts`

**Step 1: Restore the old entry behavior**

Restore the message action so rewind, regenerate, and edit-resend call the existing Electron API directly. A normal click must not open a preview or ask the user to choose `conversation`, `files`, or `both`.

**Step 2: Keep the existing action semantics**

- Rewind truncates at the selected assistant message.
- Regenerate rewinds and resends the original user message.
- Edit-resend rewinds and sends the edited content.
- The existing loading and error states remain in place.

**Step 3: Run the renderer tests**

```bash
bun test apps/electron/src/renderer/components/agent/AgentView.rewind-entry.test.ts
```

Expected: the old direct-action behavior passes and no `RewindDialog` import remains.

---

### Task 3: 恢复 Claude/Pi 原有主进程回退入口

**Files:**
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/ipc.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/index.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-service.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/remote-service.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/preload/index.ts`
- Modify only rewind-related hunks in: `/Users/mac/profer/profer-main/packages/shared/src/types/agent.ts`

**Step 1: Restore the legacy dispatch**

Use the parent version of the rewind-related hunks so the main process dispatches by runtime:

- Claude uses `resetClaudeSession` / Claude snapshot rewind.
- Pi uses `rewindPiSession` / `resetPiSession` and its native transcript file.
- An omitted assistant UUID retains the existing session-start behavior.

Preserve unrelated changes in these files if they are not part of rewind.

**Step 2: Remove the new gateway from the normal path**

Remove `prepare → execute → undo` from the normal UI path. Do not make the legacy IPC route call the new gateway as a fallback. If the remote endpoint must remain for compatibility, it must map directly to the existing runtime-specific operation and must not introduce a new confirmation flow.

**Step 3: Run runtime-focused tests**

```bash
bun test apps/electron/src/main/lib/agent-session-manager.test.ts
bun test apps/electron/src/main/lib/agent-orchestrator.test.ts
```

Expected: Claude and Pi both reach their old rewind implementations.

---

### Task 4: 保留并收敛影子 Git 快照能力

**Files:**
- Reuse: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/pi-checkpoint-git.ts`
- Reuse: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/pi-file-checkpoint.ts`
- Modify: the existing checkpoint creation hooks in the runtime adapters/session manager
- Test: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/pi-file-checkpoint.test.ts`

**Step 1: Use a Profer-owned shadow repository**

Keep the bare repository under the Profer session storage directory. Never run `reset --hard`, `clean`, `checkout`, or automatic commits in the user project’s `.git`.

**Step 2: Capture only Agent-owned paths**

The checkpoint manifest must contain paths touched by the current Agent through controlled Write/Edit operations. Do not treat every file in a project directory as belonging to one session. Keep `.git`, `.profer`, session storage, attachments, symlinks, and protected paths out of the snapshot.

**Step 3: Restore conservatively**

At rewind time:

- restore tracked Agent-owned modifications;
- delete only files created by the Agent and still unchanged since the checkpoint;
- preserve files changed externally or by another session and report them as skipped;
- keep conversation rewind independent from one file’s restore failure.

**Step 4: Add focused tests**

Cover only these cases:

- modified text and binary file restores;
- Agent-created file deletion;
- Agent-deleted file restoration;
- user modification after checkpoint is preserved;
- user `.git` status and index are unchanged;
- process restart can load the shadow checkpoint.

Run:

```bash
bun test apps/electron/src/main/lib/pi-file-checkpoint.test.ts
bun test apps/electron/src/main/lib/visualization-rewind-safety.test.ts
```

---

### Task 5: 只在原有回退路径接入文件恢复

**Files:**
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify the existing Claude/Pi adapter hooks only where they record controlled file writes
- Test: existing Claude/Pi rewind tests plus new focused host tests if needed

**Step 1: Keep runtime-specific conversation mutation**

Do not replace Claude JSONL/native resume handling or Pi JSONL branch truncation with a shared transcript implementation.

**Step 2: Attach the checkpoint to each turn**

When a controlled Agent turn starts, record the shadow Git checkpoint reference alongside the existing turn/entry binding. Rewind resolves that reference from the selected message and calls the existing runtime-specific conversation rewind.

**Step 3: Apply file restoration without a new UI**

The existing click performs the operation. The result may report changed or skipped files in the existing error/result surface, but it must not open a preview dialog or require a second confirmation.

**Step 4: Preserve graceful degradation**

If a legacy session has no checkpoint, rewind the conversation using the old behavior and report that files were not restored. Never silently delete unrelated project files.

---

### Task 6: 删除未接入的统一回退实现并完成验收

**Files:**
- Delete rewind-only files introduced by `49ea9bd9`: `agent-rewind-service.ts`, `agent-rewind-gateway.ts`, `agent-rewind-host.ts`, `agent-rewind-claude.ts`, `agent-rewind-pi.ts`, `agent-rewind-file-port.ts`, their fixtures/tests, and `packages/shared/src/types/agent-rewind.ts` when no remaining caller uses them.
- Revert only rewind-related hunks from `packages/session-store`, `packages/agent-provider-claude`, and `packages/agent-provider-pi`.
- Preserve unrelated collaboration, delegation, preset, renderer, and session-layout WIP.

**Step 1: Search for stale callers**

```bash
rg -n "RewindDialog|prepareRewind|executeRewind|agent-rewind|rewind_session|rewindFilesFromSnapshot|rewindPiSession|resetClaudeSession|resetPiSession" apps packages
```

Expected: legacy runtime calls remain where intended; no normal UI caller depends on the removed preview/gateway flow.

**Step 2: Run validation**

```bash
bun test apps/electron/src/main/lib/agent-session-manager.test.ts
bun test apps/electron/src/main/lib/pi-file-checkpoint.test.ts
bun test apps/electron/src/main/lib/agent-orchestrator.test.ts
bun test apps/electron/src/renderer/components/agent/AgentView.rewind-entry.test.ts
bun run --filter=@profer/shared typecheck
bun run --filter=@profer/session-store typecheck
bun run --filter=@profer/electron typecheck
bun run --filter=@profer/electron build:main
bun run --filter=@profer/electron build:preload
bun run --filter=@profer/electron build:renderer
git diff --check
```

**Step 3: Manual acceptance**

Verify with both Claude and Pi:

1. send two turns;
2. click rewind on the first turn;
3. confirm the UI immediately returns to that point;
4. confirm the next message continues from the selected point;
5. confirm regenerate and edit-resend still work;
6. confirm Agent-created files are restored where a checkpoint exists;
7. confirm a hand-edited file is preserved and reported;
8. confirm the user project’s `.git` status, index, and branch are unchanged.

Do not commit, push, publish, or alter unrelated working-tree changes.
