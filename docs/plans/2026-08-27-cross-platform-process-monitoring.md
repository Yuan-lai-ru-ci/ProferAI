# Cross-Platform Process Monitoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Profer's runtime process panel and process termination work on macOS while preserving the existing Windows implementation and PID/start-time safety checks.

**Architecture:** Keep Windows PowerShell/WMI/netstat/taskkill behavior in a Windows adapter, add a POSIX adapter for macOS using `ps`, `lsof`, `process.kill`, and process groups, then expose platform-neutral functions from `process-monitor.ts`. The runtime registry and IPC will call the neutral functions without knowing the host OS. Unknown/unsupported platforms must fail closed and return empty results rather than invoke Windows commands.

**Tech Stack:** Electron main process, Node.js `child_process`, `ps`, `lsof`, POSIX signals/process groups, Bun tests.

---

### Task 1: Add platform-neutral process-monitor seams and macOS parsing tests

**Files:**
- Modify: `apps/electron/src/main/lib/process-monitor.ts`
- Modify: `apps/electron/src/main/lib/process-monitor.test.ts`

**Step 1: Write failing tests**

Add pure-parser tests for:
- macOS `ps -axo pid=,ppid=,lstart=,comm=,args=` output becoming PID/name/command/startTime/parent PID records;
- macOS `lsof -nP -iTCP -sTCP:LISTEN -F pnPc` output becoming port-to-PID mappings;
- malformed lines and unavailable command output being ignored.

**Step 2: Run focused tests**

Run: `cd /d/profer/Profer-main/apps/electron && bun test src/main/lib/process-monitor.test.ts`

Expected: FAIL because parser exports do not exist.

**Step 3: Implement minimal pure helpers**

Add typed internal/public helpers for parsing POSIX process and lsof output. Keep existing `extractRequestedPort` behavior unchanged. Use `Date.parse` for `lstart`; preserve command line from `args`; use `comm` as fallback name. Do not use shell interpolation for parser inputs.

**Step 4: Run focused tests**

Run the same focused test command.

Expected: PASS.

---

### Task 2: Implement macOS process discovery and port mapping

**Files:**
- Modify: `apps/electron/src/main/lib/process-monitor.ts`
- Modify: `apps/electron/src/main/lib/process-monitor.test.ts`

**Step 1: Add command-runner seams/tests**

Provide injectable command execution seams or small platform functions so tests can verify the macOS branch without invoking the host command table. Test `captureOsSnapshot` on `darwin` with fixture `ps`/`lsof` output and verify `win32` remains routed to the existing PowerShell implementation.

**Step 2: Implement POSIX queries**

Add:
- `listPortPidMapPosix()` using `lsof` with argument arrays and parsing;
- `captureOsSnapshotPosix()` using `ps` plus `lsof`, with short-lived async execution and safe failure to empty maps;
- `listProcessesPosix()`, `isSameProcessPosix()`, `listProcessTreePosix()`, and `getProcessInfoPosix()` using `ps` data.

Use a platform-neutral `captureOsSnapshot`, `listProcesses`, `isSameProcess`, `listProcessTree`, and related API. Keep compatibility aliases only if existing tests/imports need them; remove `Win` suffix from runtime call sites, not necessarily from private implementation names.

**Step 3: Add process-tree matching tests**

Verify macOS records can match explicit ports and cwd/command tokens, retain start-time checks, exclude the current process, and handle a missing `lsof`/`ps` result without throwing.

**Step 4: Run focused tests**

Run: `cd /d/profer/Profer-main/apps/electron && bun test src/main/lib/process-monitor.test.ts src/main/lib/runtime-process-registry.test.ts`

Expected: PASS.

---

### Task 3: Implement POSIX graceful termination and wire the registry

**Files:**
- Modify: `apps/electron/src/main/lib/process-monitor.ts`
- Modify: `apps/electron/src/main/lib/runtime-process-registry.ts`
- Modify: `apps/electron/src/main/lib/runtime-process-registry.test.ts`

**Step 1: Add termination tests**

Test the platform-neutral termination function with injected signal/command seams:
- Windows uses existing `taskkill.exe` behavior;
- macOS sends a graceful signal to the process group when available, waits, rechecks PID+startTime, then sends SIGKILL only to the same process/group;
- no platform invokes `taskkill.exe` on macOS;
- invalid PID/start time fails closed.

**Step 2: Implement POSIX termination**

For macOS/Linux, use `process.kill(-pid, 'SIGTERM')` for detached process groups, with fallback to `process.kill(pid, 'SIGTERM')` when the group is unavailable. After the grace period, recheck identity and force with SIGKILL. Avoid killing an unrelated reused PID.

**Step 3: Replace registry Win-only calls**

Change `runtime-process-registry.ts` to call platform-neutral `listPortPidMap`, `listProcessTree`, and `listAliveProcesses`. Preserve ownership, 30-second inspection cadence, command/cwd evidence, and record schema.

**Step 4: Run tests**

Run: `cd /d/profer/Profer-main/apps/electron && bun test src/main/lib/process-monitor.test.ts src/main/lib/runtime-process-registry.test.ts`

Expected: PASS.

---

### Task 4: Wire IPC and SDK-task fallback to platform-neutral APIs

**Files:**
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/main/lib/process-monitor.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` only if the neutral termination API requires an adapter call change

**Step 1: Update imports and calls**

Replace IPC imports/calls that directly reference `isSameProcess`/`terminateProcessTreeGracefully` only if needed by the new neutral API. Ensure `GET_SESSION_PROCESS_COUNT`, `LIST_SESSION_PROCESSES`, and `KILL_PROCESS` remain protected by the existing sender/session ownership checks.

**Step 2: Preserve SDK task behavior**

Make `mapSdkShellTasks` use the neutral snapshot on macOS. Do not broaden ownership based on arbitrary renderer-provided paths.

**Step 3: Add/adjust integration-level tests**

Verify IPC process handlers continue to reject unowned records and PID/start-time mismatches. Keep tests isolated from real OS process tables through injected monitor seams where possible.

**Step 4: Run main-process typecheck and focused tests**

Run:
- `cd /d/profer/Profer-main/apps/electron && npx tsc --noEmit`
- `bun test src/main/lib/process-monitor.test.ts src/main/lib/runtime-process-registry.test.ts`

Expected: typecheck and tests pass.

---

### Task 5: Verify and document the result

**Files:**
- Modify: `C:\Users\yuan\.profer\agent-workspaces\profer-dev\workspace-files\.context\profer-macos-windows-hardcode-audit-2026-08-27.md`
- Modify: `C:\Users\yuan\.profer\agent-workspaces\profer-dev\7dd1fb2f-306e-4649-b06c-b733e9b6a1d6\.context\todo.md`

**Step 1: Run the complete relevant test subset**

Run: `cd /d/profer/Profer-main/apps/electron && bun test src/main/lib/process-monitor.test.ts src/main/lib/runtime-process-registry.test.ts src/main/lib/adapters/pi-agent-bash.test.ts`

Expected: PASS.

**Step 2: Re-read changed files and inspect git diff**

Confirm no packaging, heatmap, generated `out-*`, or unrelated user changes were touched.

**Step 3: Record evidence**

Document the new POSIX implementation, test/typecheck results, and remaining limitation: real macOS smoke testing requires an Apple Silicon Mac.

**Step 4: Commit only implementation files if requested later**

Do not commit unrelated pre-existing worktree changes.
