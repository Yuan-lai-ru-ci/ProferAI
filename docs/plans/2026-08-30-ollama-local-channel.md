# Ollama 本地渠道 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Profer 现有 Channel 体系中加入 Ollama 优先的本地模型渠道，同时支持 Chat、Claude Agent 与 Pi Agent，并保留通用本地 OpenAI 兼容入口。

**Architecture:** 新增 `ollama` ProviderType，单个渠道保存一个 Ollama 服务根地址和模型列表。Chat 通过 Ollama OpenAI-compatible `/v1` 入口运行；Claude Agent 与 Pi Agent 通过 Anthropic-compatible `/v1/messages` 入口运行。Ollama 原生 `/api/tags` 只用于模型发现，服务生命周期仍由用户管理。凭据按会话解析，空 API Key 在 Ollama 协议中使用本地哨兵值 `ollama`，不上传 Profer 服务端。

**Tech Stack:** TypeScript, Electron main/preload IPC, React, @profer/shared, @profer/core, Claude Agent SDK, Pi SDK, Bun tests.

---

### Task 1: 共享 Provider 与 URL 规则

**Files:**
- Modify: `packages/shared/src/types/channel.ts`
- Modify: `apps/electron/src/main/lib/channel-url-routing.ts`
- Test: `apps/electron/src/main/lib/channel-url-routing.test.ts`

**Steps:**
1. 为 `ProviderType`、默认 Chat URL、默认 Agent URL、显示名称和 Agent 兼容集合加入 `ollama`。
2. 约定用户配置的 `baseUrl` 为 Ollama 服务根地址（默认 `http://127.0.0.1:11434`），Chat 运行时归一化到 `/v1`，Agent 运行时归一化到根地址。
3. 添加 localhost、已有 `/v1`、已有 `/anthropic` 路径的归一化测试，确保迁移不重复拼接路径。
4. 运行 `bun test apps/electron/src/main/lib/channel-url-routing.test.ts`。

### Task 2: Ollama 模型发现与连接测试

**Files:**
- Modify: `apps/electron/src/main/lib/channel-manager.ts`
- Test: `apps/electron/src/main/lib/local-first-channel-listing.test.ts` 或新增同目录 Ollama 测试

**Steps:**
1. 增加 Ollama `/api/tags` 响应解析，映射 `name`、`size`、`modified_at` 为现有 `ChannelModel`，保留手动模型。
2. `fetchModels` 对 `ollama` 优先走原生 tags；API Key 可为空，不发送空 Bearer。
3. `testChannel` / `testChannelDirect` 对 Ollama 做服务可达和模型请求测试，区分未启动、模型不存在、认证/HTTP 错误。
4. 添加超时和非 JSON 响应的稳定错误消息测试。
5. 运行相关 Bun 测试。

### Task 3: Claude 与 Pi Agent 双协议适配

**Files:**
- Modify: `apps/electron/src/main/lib/adapters/pi-model-registry.ts`
- Modify: `apps/electron/src/main/lib/agent-runtime-credentials.ts`（如需哨兵凭据）
- Modify: `apps/electron/src/main/lib/agent-orchestrator-p0-guards.ts` 或其认证 helper（仅在源码确认必要时）
- Test: `apps/electron/src/main/lib/adapters/pi-model-registry.test.ts`

**Steps:**
1. 将 Ollama 映射到 Pi 的 `anthropic-messages` API，base URL 使用 Agent 根地址并请求 `/v1/messages`。
2. 使用 `ollama` 本地认证哨兵值，确保 Claude SDK 环境使用 `ANTHROPIC_AUTH_TOKEN`，不写入全局 `process.env`。
3. 默认本地模型 profile 为零成本、保守上下文和 max tokens；不臆测 thinking 能力，按模型/运行时兼容性处理。
4. 验证 Pi 动态 provider 注册结果和 Claude SDK credentials 的 URL/认证字段。
5. 运行 Pi registry 与相关 Agent 单测。

### Task 4: ChannelForm 与模型选择体验

**Files:**
- Modify: `apps/electron/src/renderer/components/settings/ChannelForm.tsx`
- Modify: `apps/electron/src/renderer/lib/model-logo.ts`（如需 Ollama 图标）
- Modify: 相关 Provider 类型测试/选择器测试

**Steps:**
1. 在本地/全球供应商选项中加入 Ollama，默认地址和名称切换逻辑复用现有表单。
2. Ollama API Key 设为可选，拉取模型和测试按钮只要求 Base URL；空 key 传给主进程后由主进程处理。
3. 展示“仅本机访问 / 请求发送到局域网设备 / 请求将发送到远程服务”的地址范围提示，并显示 Chat 与 Agent 两个协议预览。
4. 模型发现按钮文案改为适配 Ollama 的“读取本机模型”，不触发下载。
5. 验证暗色/亮色、错误、空模型和加载状态沿用现有设置组件。

### Task 5: Runtime 选择与回归验证

**Files:**
- Modify: 仅在实际过滤/类型分支遗漏时修改对应 Agent/Chat selector 文件
- Test: 相关 renderer/main 测试

**Steps:**
1. 确认 Ollama 在 Chat、Pi Agent 和 Claude Agent 的模型选择链路中均可见。
2. 确认不会被商业渠道、官方渠道或云端额度逻辑误处理。
3. 添加或更新 provider filtering 测试。
4. 运行 `cd apps/electron && npx tsc --noEmit` 与所有相关 `bun test`。
5. 重新读取变更文件，检查没有 API Key 日志、全局环境变量串用或错误路径拼接。

## 实际实现与验证记录（2026-08-30）

- 已新增 `ollama` ProviderType，并复用现有 Channel 加密存储、模型选择和 Agent 兼容性同步链路。
- Chat 使用 OpenAI-compatible `POST /v1/chat/completions`；Claude/Pi Agent 使用 Anthropic-compatible `POST /v1/messages`。
- Ollama 服务根地址默认 `http://127.0.0.1:11434`；用户误填 `/v1` 时会在两种协议中分别正确归一化。
- 模型发现只调用 `GET /api/tags`，映射本机已安装模型，不执行服务启动、模型下载或删除。
- API Key 可为空；Chat、Pi 和 Claude 均在请求/运行时边界使用 `ollama` 哨兵值，不写入全局 `process.env`。
- 设置页加入 Ollama 入口、可选 Key、读取本机模型按钮、Chat/Agent 端点预览，以及 localhost/LAN/远程地址提示。
- 验证通过：126 项聚焦 Bun 测试（最终加入 Pi Ollama 注册后为 127 项）、Electron/core TypeScript noEmit、Electron main/preload 构建、`git diff --check`。
- 未执行真实 Ollama 连接测试：本次没有启动、安装 Ollama 或拉取模型，符合“不代管理本地服务”的约束。

### Task 6: 交付文档与工作树检查

**Files:**
- Modify: `docs/plans/2026-08-30-ollama-local-channel.md`
- Optional: `CLAUDE.md` only if a stable project rule is discovered

**Steps:**
1. 记录实际实现与计划差异、已验证能力和未能在本机验证的 Ollama 集成项。
2. 运行 `git diff --check` 和 `git status --short`。
3. 不执行安装、启动 Ollama、模型下载、发布或远端写入。
