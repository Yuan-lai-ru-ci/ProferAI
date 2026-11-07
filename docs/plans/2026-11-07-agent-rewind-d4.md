# Agent Rewind D4 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the single host-side rewind service that prepares explicit conversation/file/both plans, validates revisions, creates durable recovery material before destructive writes, executes or compensates operations, and becomes the only path used by the new rewind gateway.

**Architecture:** D4 is an Electron-main host service over the D0 `RewindService` contract. It composes the session-store rewind object/journal APIs with the read-only Claude and Pi resolvers. Provider resolvers never write files; D4 owns locks, path authorization, backup persistence, message/native transcript mutation, runtime resume state, idempotency, recovery-required states, and legacy conversation-only compatibility. Existing legacy rewind functions remain available for unrelated callers until the final adapter is wired, but the new IPC/remote gateway must never call them as a fallback.

**Tech Stack:** TypeScript, Electron main process, Bun tests, `@profer/shared`, `@profer/session-store`, Claude/Pi provider ports, existing session metadata/message stores.

---

### Task 1: Verify the D1-D3 public contract and create D4 test harness

**Files:**
- Read: `/Users/mac/profer/profer-main/packages/shared/src/types/agent-rewind.ts`
- Read: `/Users/mac/profer/profer-main/packages/session-store/src/rewind-store.ts`
- Read: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-claude.ts`
- Read: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-pi.ts`
- Read: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-gateway.ts`
- Create: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-service.test.ts`

**Step 1: Run the existing focused suites**

Run from `/Users/mac/profer/profer-main`:

```bash
bun test ./packages/session-store/src/rewind-store.test.ts
bun test ./apps/electron/src/main/lib/agent-rewind-contract.test.ts
bun test ./apps/electron/src/main/lib/agent-rewind-claude.test.ts
bun test ./apps/electron/src/main/lib/agent-rewind-pi.test.ts
bun test ./apps/electron/src/main/lib/agent-rewind-ipc.test.ts
bun test ./apps/electron/src/main/lib/agent-rewind-remote.test.ts
```

Expected: D1–D3/D6 focused tests pass except the intentionally red D0 legacy unknown-target regression. Record baseline failures before changing D4 files.

**Step 2: Define injected ports in the D4 test harness**

Use in-memory fakes for metadata, message store, runtime artifact adapters, file snapshots, path authorization, and the D1 rewind store. The fake must expose observable call order so tests can prove backup/journal creation precedes destructive writes.

**Step 3: Add failing D4 tests**

Cover:
- conversation prepare/execute never calls file snapshot or file mutation ports;
- files prepare/execute never truncates messages or changes native resume;
- both rejects when either provider capability is unavailable;
- unknown target returns `TARGET_NOT_FOUND` and leaves messages/files unchanged;
- stale `expectedRevision` returns `PLAN_STALE` before any write;
- destructive file execution writes recovery manifest/journal before mutation;
- file revision conflict returns `CONFLICT` and leaves the target unchanged;
- partial file failure returns `recovery-required` and preserves journal/recovery material;
- undo requires matching recovery/session/caller ownership and restores the pre-operation state;
- duplicate execute of the same plan is idempotent;
- `after-turn T1` and `before-turn T2` produce the same B boundary;
- old `rewindSession` compatibility maps to explicit `conversation` mode.

Run the new test file and confirm failures are caused by the missing D4 service, not malformed fixtures.

---

### Task 2: Implement the D4 service ports and plan preparation

**Files:**
- Create: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-service.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-service.test.ts`

**Step 1: Define narrow host ports**

The service constructor receives:

- `SessionStore` for metadata and message pages/replacement;
- `createRewindStore` or an equivalent D1 port for manifests, objects and journals;
- runtime-specific resolver ports for Claude/Pi evidence and native transcript mapping;
- file access/path authorization with `lstat`/symlink checks and allowed-root resolution;
- a host lock/stop-and-wait port;
- monotonic revision and runtime resume persistence port;
- optional clock and ID factories for deterministic tests.

Do not import Electron UI code or access renderer state from this service.

**Step 2: Implement `prepare`**

Validate session existence, target availability, runtime capability, current revision, root authorization and protected paths. Build a D0 `RewindPlan` with explicit `mode`, `target`, `turnId`, `revision`, `capability`, conversation actions and/or file items. Never convert an unknown target or unloaded page into `session-start`.

For `files`/`both`, only include provider-confirmed `tracked-write` evidence. Reject or mark unsupported for Shell/MCP/Bash-only evidence, project `.profer`, `.git`, recovery storage, symlinks, special files, path traversal, user-added files and missing backup/object evidence.

**Step 3: Make `refine` server-side and safe**

Accept only item IDs returned by the previous plan. Re-read current state and issue a new plan/revision. Never accept arbitrary renderer paths.

Run the D4 test file. Expected: all preparation and mode-isolation tests pass; execution tests remain red until Task 3.

---

### Task 3: Implement durable execute/undo transactions

**Files:**
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-service.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-service.test.ts`

**Step 1: Add a preflight phase**

At execute start, acquire the per-session lock, stop/wait for active runtime, re-check `planId`, `sessionId`, `expectedRevision`, current file revisions, path roots and all protected regions. On any mismatch return a typed error without changing messages or files.

**Step 2: Persist recovery material before the first destructive write**

Read and store the complete pre-operation message/native transcript references and all affected file versions through D1 content objects. Write a `ready`/`applying` recovery manifest and `started` journal atomically. Verify every object by hash before mutation. Refuse execution if backup persistence is incomplete.

**Step 3: Execute conversation-only operations**

Truncate the product message history to the resolved boundary and update runtime resume/native transcript references through the injected provider adapter. Do not touch work files. On provider failure, restore the prior message/native state or return `recovery-required` with enough material for undo.

**Step 4: Execute file-only operations**

Apply only validated `restore`/`delete` items using current-revision compare-and-swap checks. Preserve file mode where supported. Reject symlink/path replacement and never recurse-delete directories. Update journal progress after every item.

**Step 5: Execute both atomically from the product perspective**

Apply file actions and conversation actions under the same journal, with compensation on failure. Never report committed if either side is uncertain. A process interruption must leave a durable `applying`/`recovery-required` record discoverable after restart.

**Step 6: Implement `undo`**

Require a committed/recovery-required recovery record owned by the same session/caller. Re-check current revisions, restore the original conversation/native state and original files, update journal/manifest status, and return a new revision. On conflict, leave the recovery record actionable and report the conflicting item IDs.

Run D4 tests after each transaction slice. Expected: all transaction, conflict, partial-failure, idempotency and undo tests pass.

---

### Task 4: Wire the service into the gateway and legacy compatibility path

**Files:**
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/ipc.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-gateway.ts`
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/remote-service.ts` only where the existing D6 adapter requires the injected service
- Create/Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-service.integration.test.ts`

**Step 1: Construct the service at main-process composition root**

Inject the actual session store, runtime adapters, D1 rewind store, root authorization, and host lock. Do not construct a second strategy inside IPC or remote handlers.

**Step 2: Register the single service**

Call `setAgentRewindService(service)` once during main-process initialization. Keep remote file authorization explicit and default-deny.

**Step 3: Route old calls safely**

The legacy `rewind_session` input maps to `conversation` mode only. Missing anchor maps to explicit `session-start`. It must not call `rewindFilesFromSnapshot`, `rewindPiSession`, `resetClaudeSession`, or `resetPiSession` from the gateway path.

**Step 4: Add integration tests**

Verify IPC sender guard, remote caller ownership, legacy conversation-only behavior, new service registration, and no model-tool registration side effect.

Run the focused IPC/remote/D4 suites and `git diff --check`.

---

### Task 5: Validate the whole D4 boundary and hand off D5/D6/D7

**Files:**
- Modify: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-service.test.ts`
- Create: `/Users/mac/profer/profer-main/apps/electron/src/main/lib/agent-rewind-service.matrix.test.ts`

**Step 1: Add the capability matrix**

Cover Claude/Pi × managed/project × conversation/files/both × clean/conflict/missing evidence × old/new protocol. Include first-turn failure, intermediate tool messages, fork mapping and external modification cases.

**Step 2: Run independent verification**

```bash
cd /Users/mac/profer/profer-main
bun test ./apps/electron/src/main/lib/agent-rewind-service.test.ts
bun test ./apps/electron/src/main/lib/agent-rewind-service.matrix.test.ts
bun test ./apps/electron/src/main/lib/agent-rewind-contract.test.ts
bun run --filter=@profer/shared typecheck
bun run --filter=@profer/session-store typecheck
bun run --filter=@profer/electron typecheck
bun run --filter=@profer/electron build:main
bun run --filter=@profer/electron build:preload
bun run --filter=@profer/electron build:renderer
git diff --check
```

Expected: D4-specific tests and shared/session-store typechecks pass. Existing unrelated WIP failures must be reported separately with file/error attribution; do not claim the full Electron build is green unless it actually is.

**Step 3: Update task graph and handoff**

Mark the D4 preflight and D4 implementation nodes with actual evidence. D7 remains blocked until D5/D6/D4 are reconciled on one integration commit/worktree. Report exact files, test output, capability gaps, and whether R0 conversation-only can be safely enabled.
