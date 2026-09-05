# Capability Gating Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the existing Agent preset gate into one shared capability registry for browser, clipboard, preview, image, web, and PPT materials, so Claude, Pi, prompts, schemas, and settings consume the same group/tool definitions.

**Architecture:** Keep business implementations in their current modules. Add shared capability metadata alongside the existing preset tool-group registry: each capability group declares its id, UI label/hint, prompt suppression key when applicable, and tool short names. Runtime code derives disabled groups and tool filtering from this registry; capability-specific injection points receive the effective disabled set. Disabled capabilities are hard-gated: they are not registered and cannot be restored by task intent or Agent-side preset changes.

**Tech Stack:** TypeScript, Bun tests, Electron main process, React renderer, `@profer/shared`, Claude in-process MCP, Pi custom tools.

---

### Task 1: Extend the shared capability registry

**Files:**
- Modify: `packages/shared/src/types/agent-preset.ts`
- Check: `packages/shared/src/index.ts`
- Test: `apps/electron/src/main/lib/agent-preset-manager.test.ts`

**Steps:**
1. Add the six capability group ids to the shared group tuple: `browser`, `clipboard`, `preview`, `image`, `web`, `ppt-materials`.
2. Add shared metadata for each group: stable id, display label, concise UI hint, and the complete short-name list. Keep existing workflow groups unchanged.
3. Add an explicit `AGENT_PRESET_CAPABILITY_GROUPS` alias/metadata export for renderer and runtime consumers, without putting implementation logic in shared.
4. Extend the group-to-prompt suppression mapping only where an existing prompt section exists; leave capability-specific prompt sections absent until runtime can prove their tools are registered.
5. Add/adjust tests proving all group ids and tool names are accepted by preset validation and that the registry has no duplicate tool short names.
6. Run the focused shared/preset tests.

### Task 2: Make preset schemas and settings consume the registry

**Files:**
- Modify: `apps/electron/src/main/lib/agent-preset-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/renderer/components/agent-skills/AgentPresetSettings.tsx`
- Modify: `apps/electron/src/main/lib/agent-preset-manager.ts` only if validation currently hard-codes the old group tuple

**Steps:**
1. Replace duplicated Zod/TypeBox group literal unions with the shared capability group tuple converted to the local schema format.
2. Replace the renderer `TOOL_GROUP_OPTIONS` and per-group tool lookup with shared registry metadata.
3. Preserve the current UX semantics: toggling a group disables all tools in that group; single-tool controls remain available for registered tool names.
4. Ensure old presets with only the original four groups continue to resolve unchanged.
5. Add schema/renderer-facing unit assertions where existing test patterns allow it.
6. Run typecheck and focused preset tests.

### Task 3: Apply hard gates to Claude injection points

**Files:**
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/claude-browser-tools.ts` only if needed for tool-level filtering
- Modify: `apps/electron/src/main/lib/claude-clipboard-tools.ts` only if needed for tool-level filtering
- Modify: `apps/electron/src/main/lib/agent-preview-tools.ts` only if needed for tool-level filtering
- Modify: `apps/electron/src/main/lib/agent-image-output-tools.ts` and `agent-gpt-image-tools.ts` only if needed
- Modify: `apps/electron/src/main/lib/ppt-material-agent-tools.ts` only if needed

**Steps:**
1. Derive the effective disabled group set from the resolved preset, including the existing `allowSubagents=false` behavior.
2. Gate Claude browser, clipboard, preview, image output/generation, and PPT material injections by their shared groups.
3. Gate PPT materials by both the hard preset gate and the existing PPT task gate; task intent must never override a preset-disabled group.
4. Keep authorization roots and permission callbacks unchanged.
5. Do not inject capability-specific prompt/tool metadata when its group is disabled.
6. Add orchestrator/injection tests that assert each disabled capability server is absent.
7. Run focused Claude and orchestrator tests.

### Task 4: Apply hard gates to Pi builtin tools

**Files:**
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` only if custom/native tool handling needs a shared filter
- Test: `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`

**Steps:**
1. Gate browser tools with `browser`, clipboard tools with `clipboard`, preview tools with `preview`, image tools with `image`, and WebSearch/WebFetch with `web`.
2. Gate PPT material tools consistently with the Claude path; if PPT material tools are Claude-only today, preserve that fact and ensure no Pi MCP conversion reintroduces them.
3. Continue applying `disabledTools` after group gating using the shared tool-name filter.
4. Add a table-driven test covering each new group and proving unrelated groups remain present.
5. Run the focused Pi tests and typecheck.

### Task 5: Align prompt, mention, and runtime capability snapshots

**Files:**
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/pi-task-prompt.ts` only if tool-name compression needs the new groups
- Tests: existing prompt/orchestrator tests plus a focused regression test if needed

**Steps:**
1. Pass the effective disabled capability set into prompt construction.
2. Ensure prompts do not describe or name disabled browser, clipboard, preview, image, web, or PPT material tools.
3. Filter explicit mentions against actual loaded tools and the same registry-derived group policy.
4. Keep the existing “disabled capability” response behavior available to the Agent through a concise capability status, without exposing implementation details or bypass instructions.
5. Ensure active queue-message policy snapshots retain the same hard gate until the current run finishes.
6. Add regression tests for disabled groups plus explicit mentions and PPT intent.
7. Run focused prompt/orchestrator tests.

### Task 6: Remove Agent-side elevation through preset tools

**Files:**
- Modify: `apps/electron/src/main/lib/agent-preset-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts` if effective policy needs to be carried into tool context
- Tests: preset tool tests and Pi builtin tests

**Steps:**
1. Keep preset read/list capability available only if it does not expose disabled tool details unnecessarily.
2. Remove or gate Agent-side preset mutation and default-setting tools from ordinary Agent runs.
3. Prevent `preset_switch_session` from switching to a less-restricted preset from within the Agent run; user UI remains the control plane for changing the next-run preset.
4. Return a structured, user-readable refusal when an Agent attempts to elevate capabilities.
5. Preserve user UI IPC behavior and existing preset management workflows.
6. Add tests for attempted elevation from a disabled capability configuration.
7. Run the focused preset and adapter tests.

### Task 7: Full verification and working-tree audit

**Files:**
- No new implementation files unless a failing test requires one.
- Check: all modified files and existing dirty files.

**Steps:**
1. Run focused tests for shared preset registry, preset manager, Claude injection, Pi builtin tools, prompt builder, and orchestrator.
2. Run Electron typecheck and `git diff --check`.
3. Re-read the final registry and all six injection paths to verify there is no duplicated capability list left in runtime/UI code.
4. Report any intentionally preserved boundary, especially native Read/Bash/Edit/Write and AskUserQuestion, which remain core tools rather than preset-cropped groups.
