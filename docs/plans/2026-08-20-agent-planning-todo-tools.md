# Agent Planning Todo Tools Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Claude/Pi Agent 可以直接列出、读取、创建和更新 Profer 规划中心 Todo；暂不开放删除。

**Architecture:** 新增 runtime-neutral 的规划 Todo 操作层，按当前 Agent workspace 类型选择本地 SQLite 或 Team Server；写操作统一广播规划变更和 Agent 操作反馈，个人 Todo 记录当前 session 关联。Claude 通过 in-process MCP 注册，Pi 通过 `sdk.defineTool()` 注册同名 `mcp__planning__*` 工具。

**Tech Stack:** Electron main process、TypeScript、Claude SDK MCP/Zod、Pi SDK custom tools/TypeBox、现有 planning-manager/team-planning-service。

---

### Task 1: 新增共享规划 Todo 操作层

**Files:**
- Create: `apps/electron/src/main/lib/planning-agent-operations.ts`
- Test: `apps/electron/src/main/lib/planning-agent-operations.test.ts`

**Steps:**
1. 建立 `list/get/create/update` 操作，context 使用 `sessionId` 和可选 `workspaceId`。
2. 团队 workspace 调用 `listTeamTodos/createTeamTodo/updateTeamTodo`；其他情况调用本地 `planning-manager`。
3. 创建/更新成功后广播 `planning:changed` 和 `planning:agent-operation`；本地创建/更新使用已有 session 关联能力。
4. 团队更新和本地更新都传递 `expectedUpdatedAt`，保留并返回冲突错误。
5. 用 mock 验证本地/团队路由、成功广播和缺失 Todo 行为。

### Task 2: 暴露 Claude MCP 工具

**Files:**
- Create: `apps/electron/src/main/lib/planning-agent-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Test: `apps/electron/src/main/lib/planning-agent-tools.test.ts`

**Steps:**
1. 使用 Zod 暴露 `list_todos/get_todo/create_todo/update_todo`。
2. 写操作 schema 只允许规划字段，更新要求 `expectedUpdatedAt`。
3. 将工具注册到 `mcpServers.planning`，不开放 delete。
4. 在编排器中为 Claude 注入该 MCP，保持与预设裁剪逻辑一致。
5. 添加注册契约测试。

### Task 3: 暴露 Pi custom tools

**Files:**
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`

**Steps:**
1. 将现有只读 `mcp__planning__get_todo` 扩展为四个工具。
2. 传入 session/workspace context，并支持 `disabledTools` 的单工具裁剪。
3. 更新已有注册数量和名称断言，补充写入工具存在性断言。
4. 运行 Pi bridge 测试。

### Task 4: 更新 Agent 使用说明并验证

**Files:**
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`

**Steps:**
1. 增加 runtime-aware 规划 Todo 工具说明，明确区分规划 Todo 与任务图。
2. 说明更新前先读取并携带 `expectedUpdatedAt`，删除仍需通过规划中心 UI。
3. 运行相关单测、Electron 主进程 typecheck，并重新读取改动确认闭环。
