# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

**重要提示：**
- 当功能发生变化时，请保持此文件和 `README.md` 同步更新。请更新文档以反映当前状态，但是需要经过我的允许后再修改。
- 所有的注释和日志优先采用中文，保留必要的专业术语部分。
- 所有的依赖包的安装都要先进行搜索，综合判断依赖采用的版本，而不是默认采用某个版本。
- 状态管理上我们全部采用 Jotai 来实现。
- 这是个开源项目，本地存储优先，善用配置文件优于大部分默认采用 localstorage，不采用本地数据库方案。
- 保证充分的组件化以及人类的可读性，每次完成改动后都要思考这一点，运行@code-simplifier 来简化优化代码，保持简单直接不过渡设计的风格。
- 在 UI 设计上采用更现代的方案，UI 组件推荐采用 ShadcnUI，在合适的情况下，用卡片和阴影取代边框，用符合主题的饱满色彩，设置界面要设置背景，为未来做不同主题留下空间。
- 同一个交互/同一类 UI 元素只允许一套实现、一套视觉：滚动条、悬停、显隐等行为必须复用现成组件与 token（滚动统一走 `<ScrollRegion>` + `--scrollbar-thumb-*`，见 `docs/design/2026-10-27-scrollbar-spec.md`），不得为单个区域另写 CSS/JS 或另定颜色；发现两套并存时先合并，再继续改功能。
- 界面里绝对禁止出现横向滚动条，但**不禁止横向滚动**：内容必须仍能横向滚动（触控板横滑 / Shift+滚轮 / 拖拽 / `scrollLeft`），只是不绘制横条（全局 `::-webkit-scrollbar:horizontal` 已强制 `height: 0`）；不得用 `overflow-x: hidden` 或强行换行来“消灭”横条。
- 采用 BDD 行为驱动开发的方案。

> 本文件与 `CLAUDE.md` 保持同一套项目约束；平台相关命令必须按当前宿主系统和运行时检测结果执行。

## 项目概述

Profer 是一个集成通用 AI Agent 的下一代人工智能软件，采用 Electron 桌面应用架构。脱胎于开源项目 Proma (github.com/ErlichLiu/Proma)，经深度改造而来。

> **改名记录**：2026-06-21 从 Proma 改名为 Profer。应用名/数据目录/GitHub 仓库均已更名；代码包名已同步改为 `@profer/*`（不再保留 `@proma/*` 作用域）。

## Monorepo 结构

Bun workspace monorepo：

```
profer/
├── packages/
│   ├── shared/                # 共享类型、IPC 通道常量、配置、工具函数 (v0.1.46)
│   ├── core/                  # AI Provider 适配器、SSE、代码高亮服务 (v0.2.12)
│   ├── ui/                    # 共享 UI 组件 (CodeBlock, MermaidBlock) (v0.2.0)
│   ├── session-core/          # headless session 读取/分组/搜索/渲染 (v0.1.1)
│   ├── session-store/         # Node-only 会话持久化：索引/消息/事件/工作区存储与操作契约 (v0.1.0)
│   ├── project-core/          # headless 项目编排：图构建、状态回放、查询 (v0.1.0)
│   ├── agent-runtime/         # 宿主无关的 Agent 执行契约与运行时生命周期工具 (v0.1.0)
│   ├── agent-provider-claude/ # Claude Agent SDK provider：query 流、权限、后台任务 (v0.1.0)
│   ├── agent-provider-pi/     # Pi Agent SDK provider：完整适配器、消息转换、Pi 工具集成 (v0.1.0)
│   ├── agent-fabric/          # Agent Node / Task Graph / Capability / Policy 契约与纯函数 (v0.1.0)
│   ├── edition-contract/      # 发行版能力契约：账号会话/代管凭据路由/发行版标识，不依赖 Electron (v0.1.0)
│   ├── office-engine/         # DOCX/PPTX/XLSX 双平面版式解析引擎 (v0.1.0)
│   └── plugin-api/            # 第三方插件公开契约 (v0.1.1)
└── apps/
    ├── electron/              # Electron 桌面应用 (v0.16.10)
    │   └── src/
    │       ├── main/          # 主进程 + 服务层 (main/lib/)
    │       ├── preload/       # IPC 上下文桥接
    │       └── renderer/      # React UI (Vite + Tailwind + Radix UI)
    └── cli/                   # 命令行工具：会话渐进式读取 list/info/outline/search/export (v0.1.1)
```

**包命名规范**：`@profer/*` 作用域（`@profer/core`、`@profer/shared`、`@profer/ui`、`@profer/electron` 等，共 13 个 `packages/*` + 2 个 `apps/*`）

**依赖管理**：package.json 中使用 `workspace:*` 引用内部包

### 包职责详解

#### @profer/shared (v0.1.46)
- **导出模块**：`.`、`./types`、`./config`、`./utils`
- **关键类型**：`AgentMessage`、`ChatMessage`、`Channel`、`PermissionRequest`、`FeishuConfig`
- **依赖**：无运行时依赖（仅 TypeScript）

#### @profer/core (v0.2.12)
- **导出模块**：`.`、`./providers`、`./highlight`
- **关键功能**：Provider 适配器注册表、代码高亮（Shiki）
- **依赖**：`@profer/shared`、`highlight.js`、`shiki`
- **Peer 依赖**：`@anthropic-ai/claude-agent-sdk`、`@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`

#### @profer/ui (v0.2.0)
- **关键组件**：共享 React UI 组件库
- **导出模块**：`.`、`./primitives/*`、`./lib/*`、`./hooks/*`
- **依赖**：`@profer/core`、`beautiful-mermaid`、`mermaid`、`shiki`、Radix UI 系列
- **Peer 依赖**：`react@^18.3.0`、`react-dom@^18.3.0`

#### @profer/session-core (v0.1.1)
- **职责**：headless 核心——读取、分组、搜索、渲染 Profer Agent 会话。Electron 应用、profer CLI 和未来查询界面的单一事实来源
- **导出模块**：`.`（`group`、`outline`、`read`、`search`、`select`、`transcript`、`render-markdown`、`thinking-tags`、`tokens`）、`./node`（文件系统读取 + session 列表）
- **依赖**：`@profer/shared`

#### @profer/session-store (v0.1.0)
- **职责**：Node-only 的会话持久化层——会话索引、消息/事件、工作区与 blob 文件的读写契约与操作；不读 Electron `app.getPath`、不持有 provider SDK，运行时路径由宿主（`apps/electron/src/main/lib/session-store-host.ts`）注入
- **导出模块**：`.`（`contracts`、`paths`、index / message / metadata / blob / event / workspace / file / session store、`operations`）
- **依赖**：`@profer/project-core`、`@profer/session-core`、`@profer/shared`

#### @profer/project-core (v0.1.0)
- **职责**：headless 项目编排——图构建、状态回放和查询；由 Electron 应用、CLI 和未来查询界面共用
- **导出模块**：`.`
- **依赖**：`@profer/shared`

#### @profer/agent-runtime (v0.1.0)
- **职责**：宿主无关的 Agent 执行契约与纯运行时生命周期工具（协调器、运行所有权、重试、错误模式、outcome）
- **导出模块**：`.`、`./error-patterns`、`./runtime-guards`、`./runtime-routing-adapter`
- **依赖**：`@profer/shared`

#### @profer/agent-provider-claude (v0.1.0)
- **职责**：Claude Agent SDK provider——宿主无关的 query 流、权限、后台任务与进程生命周期适配
- **导出模块**：`.`、`./background-task-manager`、`./task-events`、`./write-target-guard`
- **依赖**：`@anthropic-ai/claude-agent-sdk@0.3.201`、`@profer/agent-runtime`、`@profer/core`、`@profer/shared`

#### @profer/agent-provider-pi (v0.1.0)
- **职责**：宿主无关的 Pi Agent SDK provider——完整适配器、消息转换与 Pi 工具集成
- **导出模块**：`.`、`./pi-agent-adapter`、`./ports`、`./pi/*`、`./host/minimal-pi-host`
- **依赖**：`@profer/agent-runtime`、`@profer/core`、`@profer/shared`、`typebox`、`undici`
- **Peer 依赖**：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`（均为 `0.86.1`）

#### @profer/agent-fabric (v0.1.0)
- **职责**：Agent Node / Task Protocol / Task Graph / Capability / Policy / Event / Artifact / Result 统一契约与纯函数行为（状态机、策略收窄、事件重放、审批绑定）；不绑定 Electron、Claude SDK 或 Pi runtime
- **导出模块**：`.`
- **依赖**：无运行时依赖

#### @profer/edition-contract (v0.1.0)
- **职责**：发行版能力契约——账号会话、代管凭据路由与发行版标识；执行链只依赖本包，不直接依赖商业模块。Electron 侧的装配点在 `apps/electron/src/main/lib/edition/`
- **导出模块**：`.`
- **依赖**：`@profer/shared`

#### @profer/office-engine (v0.1.0)
- **职责**：DOCX / PPTX / XLSX 双平面版式解析（语义重排平面 + 归一化空间拓扑平面，带引用锚点），零第三方依赖
- **导出模块**：`.`、`./node`（Node-only 运行时）
- **依赖**：`@profer/shared`

#### @profer/plugin-api (v0.1.1)
- **职责**：第三方插件公开契约（含 `PROFER_PLUGIN_IPC_CHANNELS`）
- **导出模块**：`.`
- **依赖**：无运行时依赖

#### @profer/electron (v0.16.10)
- **职责**：Electron 桌面应用主体，集成所有包
- **关键依赖**：
  - `@anthropic-ai/claude-agent-sdk@0.3.201` - Agent SDK
  - `electron@^43.2.0` - 桌面框架
  - `@larksuiteoapi/node-sdk` - 飞书集成
  - Radix UI、TipTap、Tailwind CSS
  - 文件解析：`pdf-parse`、`officeparser`、`word-extractor`

#### @profer/cli (v0.1.1)
- **职责**：命令行工具——面向有限上下文的 Agent 消费者，提供会话的渐进式读取（`list` / `info` / `outline` / `search` / `export`）
- **依赖**：`@profer/session-core`、`@profer/shared`（bin：`profer`）

## 常用命令

```bash
# 开发模式（推荐 - Vite HMR；Electron 只启动一次，不因代码变化抢焦点重启）
bun run dev

# 手动开发模式（需要分别查看 Vite / Electron 日志时）
# 终端 1: cd apps/electron && bun run dev:vite
# 终端 2: cd apps/electron && bun run dev:electron

# 说明：renderer 修改即时由 Vite HMR 生效；main/preload 仍会持续构建到 dist，
# 但不会自动重启 Electron。修改 main/preload 后需手动重新执行 bun run dev 才加载新代码。

# 构建并运行
bun run electron:start

# 仅构建
bun run electron:build

# 类型检查（所有包）
bun run typecheck

# 单包类型检查
cd packages/core && bun run typecheck

# 测试
bun test

# 打包分发（按目标平台执行）
cd apps/electron
bun run dist:fast     # 当前宿主架构快速打包（本机 macOS 可用于 arm64 验收）
bun run dist:mac      # macOS 当前架构验收包
bun run dist:win      # Windows x64 发布/验收包（必须在 Windows 构建主机执行）
# Windows 专属的 PowerShell/注册表 PATH/打包校验只在 Windows 主机执行；不要在 macOS shell 中执行 Windows 命令
```

### Electron 构建脚本（`apps/electron/` 目录下）

```bash
bun run build:main        # esbuild → dist/main.cjs
bun run build:preload     # esbuild → dist/preload.cjs
bun run build:renderer    # Vite → dist/renderer/
bun run build:resources   # 复制 resources/ 到 dist/
bun run generate:icons    # 生成应用图标
```

## 运行时环境

使用 Bun 代替 Node.js/npm/pnpm：

- `bun install` 安装依赖，`bun run <script>` 运行脚本
- `bun test` 运行测试（内置测试运行器，`import { test, expect } from "bun:test"`）
- Bun 自动加载 .env 文件（无需 dotenv）
- 优先使用 Bun 原生 API：`Bun.file` > `node:fs`，`Bun.$\`command\`` > `execa`

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| **运行时** | Bun | 1.2.5+ |
| **语言** | TypeScript | 5.0.0+ |
| **桌面框架** | Electron | 43.2.0 |
| **前端框架** | React | 18.3.1 |
| **状态管理** | Jotai | 2.17.1 |
| **UI 组件** | Radix UI | 最新 |
| **样式** | Tailwind CSS | 3.4.17 |
| **富文本编辑器** | TipTap | 3.19.0 |
| **代码高亮** | Shiki | 3.22.0 |
| **Markdown** | React Markdown | 10.1.0 |
| **图表** | Beautiful Mermaid | 最新 |
| **数学公式** | KaTeX | 0.16+ |
| **构建工具** | Vite | 6.0.3 |
| **打包工具** | esbuild | 0.24.0+ |
| **分发工具** | Electron Builder | 25.1.8 |
| **Agent SDK** | @anthropic-ai/claude-agent-sdk | 0.3.201 |
| **飞书 SDK** | @larksuiteoapi/node-sdk | 最新 |

## 核心架构

### IPC 通信模式（最重要的架构模式）

类型定义 → 主进程处理 → Preload 桥接 → 渲染进程调用：

1. **类型 & 常量**：`@profer/shared` 定义 IPC 通道名称常量和请求/响应类型
2. **主进程处理**：`main/ipc.ts`（4682 行）注册 `ipcMain.handle()` 处理器，调用 `main/lib/` 服务；实际 `ipcMain.handle` 共 522 处（另有 8 处 `ipcMain.on`），其中 `ipc.ts` 248 处，其余分散在 35 个 `main/lib/` 子模块（planning / global-skill / channel / feishu / plugins 等，最大单文件 21 处）
3. **Preload 桥接**：`preload/index.ts`（3760 行）通过 `contextBridge.exposeInMainWorld` 暴露类型安全的 API；`ElectronAPI` 接口顶层 538 个成员（其中 7 个是 `auth` / `knowledge` / `globalSkill` / `skillMaster` 等分组对象），按分组展开后共 585 个键、其中 578 个是可调用方法
4. **渲染进程**：通过 `window.electronAPI.*` 调用，Jotai atoms 中封装调用逻辑

添加新 IPC 通道时，需要同步修改这四个位置。`packages/shared/src/types/*.ts` 与 `packages/plugin-api` 共声明 23 个 `*_IPC_CHANNELS` 常量组、461 条通道字符串（AST 统计，全部为字面量）。

#### 主要 IPC 通道组

- `IPC_CHANNELS` - 基础通道（运行时、Git、环境）
- `CHANNEL_IPC_CHANNELS` - 渠道管理
- `CHAT_IPC_CHANNELS` - Chat 功能
- `AGENT_IPC_CHANNELS` - Agent 功能
- `ENVIRONMENT_IPC_CHANNELS` - 环境检查
- `PROXY_IPC_CHANNELS` - 代理设置
- `SYSTEM_PROMPT_IPC_CHANNELS` - 系统提示词
- `MEMORY_IPC_CHANNELS` - 记忆功能
- `CHAT_TOOL_IPC_CHANNELS` - Chat 工具
- `FEISHU_IPC_CHANNELS` - 飞书集成
- `GITHUB_RELEASE_IPC_CHANNELS` - GitHub 发布

### 主进程服务层（`main/lib/`）

#### 核心服务

| 服务 | 职责 |
|------|------|
| `agent-orchestrator.ts` | Agent 核心编排层（约 3860 行）：并发守卫、渠道查找、环境变量构建、SDK 路径解析、消息持久化、事件流处理、错误处理、自动标题生成 |
| `agent-collaboration-tools.ts` | Agent 协作委派工具（1607 行）：10 个 MCP 工具（delegate_agent / delegate_agents / wait_for_delegations / list_delegations / get_delegation_results / stop_delegation / stop_delegations / answer_delegation_question / continue_delegation / list_available_agent_models），子会话创建、等待、管理和恢复 |
| `adapters/claude-agent-adapter.ts` | 转发门面（387 字节）：`export * from '@profer/agent-provider-claude'`，保留旧入口供 agent-service / agent-orchestrator 与既有测试不改调用点；完整实现（2427 行，含 streamInput 持久化、工具权限注入、thinking signature 错误处理）在 `packages/agent-provider-claude` |
| `adapters/pi-agent-adapter.ts` | 转发门面（1362 字节）：继承并注入 Electron 宿主事实（渠道账号策略 / xAI OAuth 凭据），其余导出转发到 `@profer/agent-provider-pi`；完整实现（7841 行，含内置产品工具注册、AskUserQuestion 闭环）在 `packages/agent-provider-pi` |
| `agent-session-manager.ts` | Agent 会话管理（3054 行）：SDK 消息持久化（经 `@profer/session-store`）、会话元数据 CRUD、JSONL 存储、委派子会话元数据 |
| `agent-session-index.ts` | 转发门面（2 行）：索引 store 的实际实现已移入 `@profer/session-store`，这里只 re-export 保留旧调用点 |
| `session-store-host.ts` | 宿主适配（31 行）：把 Electron 运行时路径（config / sessions / workspaces / checkpoints，经 `config-paths` 解析）注入 `@profer/session-store`；存储包自身不读 `app.getPath` |
| `agent-prompt-builder.ts` | Agent 系统提示词构建（348 行）：动态上下文构建、内置 Agent 构建、工作区上下文注入 |
| `agent-service.ts` | Agent 运行服务入口（约 1300 行）：`runAgent()` 按 `agent-runtime-desktop-switch.ts` 的判定分流到桌面 runtime 链或旧编排器；含无界面运行与协作子会话执行 |
| `agent-headless-runner-registry.ts` | Headless runner 注册表：管理协作委派的 Agent 运行实例生命周期 |
| `agent-model-selection.ts` | 协作委派模型选择验证：确保委派子会话使用已启用的合法模型 |
| `agent-permission-service.ts` | Agent 权限管理：工具权限检查、权限模式管理 |
| `agent-ask-user-service.ts` | Agent 用户交互：AskUser 请求处理 |
| `agent-exit-plan-service.ts` | Agent 退出计划服务 |
| `agent-workspace-manager.ts` | 工作区管理（68KB）：MCP Server 配置、Skills 配置、工作区 CRUD |
| `chat-service.ts` | Chat 流式调用编排（38KB）：Provider 适配器集成、消息持久化、AbortController |
| `conversation-manager.ts` | 对话管理（37KB）：对话 CRUD、JSONL 消息存储（parentId-tree）、置顶、上下文分割、活跃分支 activePath、forkBranchAt 分叉 |
| `channel-manager.ts` | 渠道管理（82KB）：渠道 CRUD、API Key AES-256-GCM 加密（safeStorage）、连接测试、模型获取 |
| `edition/index.ts` | 发行版装配点（25 行）：按发行版向执行链注入 account（会话/恢复）与 credentials（代管路由/代管 Bearer）实现；商业模块只在此处汇编 |

#### 集成服务

| 服务 | 职责 |
|------|------|
| `feishu-bridge.ts` | 飞书集成（91KB）：消息同步、任务通知、OAuth 认证 |

#### 工具与文件

| 服务 | 职责 |
|------|------|
| `chat-tools/` | Chat 工具实现目录：内置工具函数 |
| `workspace-watcher.ts` | 工作区文件监听：文件系统变化监控 |
| `chat-tools-watcher.ts` | Chat 工具监听：工具配置变化监控 |
| `attachment-service.ts` | 附件管理：存储/读取/删除、文件对话框 |
| `document-parser.ts` | 文档解析：PDF/Office/文本文件提取 |

#### 系统服务

| 服务 | 职责 |
|------|------|
| `runtime-init.ts` | 运行时初始化：Shell 环境、Bun、Git 检测（`bun-finder.ts`、`git-detector.ts`、`shell-env.ts`） |
| `config-paths.ts` | 配置路径管理：`~/.profer/` 目录结构 |
| `user-profile-service.ts` | 用户档案持久化 |
| `settings-service.ts` | 应用设置持久化（主题等） |
| `updater/` | 自动更新：Electron Updater 集成（超时契约见下） |

#### 自动更新的超时契约（不要退化）

`electron-updater` 6.8.9 的 `ElectronHttpExecutor` **没有任何请求超时**，provider 配置里的
`timeout` 字段也不会被任何 provider 读取（已在 `node_modules/electron-updater/out` 核对）。
只要连接建立后对方不回数据（代理半开、CDN 卡住、丢包不回 RST），`checkForUpdates()`
既不 resolve 也不 reject，界面就会永久停在「正在检查」，而且 in-flight 锁永不释放，
之后每次手动检查都合并进同一个死 Promise。

因此四条约束必须同时成立，缺一条就会复现「版本获取无限转圈」：

1. `auto-updater.ts` 的 `withDeadline` 给每个源的元数据检查（`UPDATE_CHECK_DEADLINE_MS`）
   和整轮检查（`UPDATE_CHECK_TOTAL_DEADLINE_MS`）各封一道硬顶，超时即收敛成 `error` 状态；
2. in-flight 任务带时间戳，超过 `UPDATE_INFLIGHT_STALE_MS` 允许新检查接管（`hasLiveInFlight`）；
3. 检查阶段**不等待下载**：`checkSource` 只负责发现版本，下载由 `startBackgroundDownload`
   在后台跑，用 `download-progress` 事件驱动状态，并用 `UPDATE_DOWNLOAD_STALL_MS` 判定停滞；
4. 放弃一轮时必须清掉 `electron-updater` 内部的 `checkForUpdatesPromise` / `downloadPromise`
   缓存（`releaseStuckUpdaterPromise`）。这两个字段只在 resolve/reject 时清空，超时只是
   「我们不等了」，底层 promise 仍挂起；不清缓存的话下一次检查/下载会直接复用它，症状从
   「无限转圈」变成「每次检查都超时」，用户只能重启应用。

渲染层同样有两道兜底：`AboutSettings` 的 `CHECK_UI_DEADLINE_MS` 保证按钮一定会恢复可点，
`update-deadline.test.ts` / `auto-updater-timeout.test.ts` 守住上述行为。

### AI Provider 适配器（`packages/core/src/providers/`）

基于适配器模式的多 Provider 支持，通过注册表统一管理：

#### 核心架构
- `ProviderAdapter` 接口：定义统一的 `sendMessage()` 流式方法
- `provider-registry.ts`：Provider 注册表，按 `providerId` 查找适配器
- `sse-reader.ts`：通用 SSE 流读取器（fetch + ReadableStream）

#### 支持的 Provider

| Provider | 适配器 | API 协议 | 特性 |
|----------|--------|----------|------|
| **Anthropic** | `anthropic-adapter.ts` | Messages API | extended_thinking、多模态 |
| **OpenAI** | `openai-adapter.ts` | Chat Completions | 标准 OpenAI 协议 |
| **DeepSeek** | `anthropic-adapter.ts` | Messages API | Anthropic 兼容 |
| **智谱 AI** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **MiniMax** | `anthropic-adapter.ts` | Messages API | Anthropic 兼容 |
| **豆包** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **通义千问** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **Google** | `google-adapter.ts` | Generative Language API | Gemini 系列 |
| **Custom** | `openai-adapter.ts` | Chat Completions | 自定义 OpenAI 兼容端点 |

#### 多模态支持
- **图片**：各 Provider 格式不同，适配器自动转换
- **文档**：提取文本后注入 `<file>` XML 标签

### Jotai 状态管理（`renderer/atoms/`）

| Atom 文件 | 管理的状态 |
|-----------|-----------|
| `chat-atoms.ts` | 对话列表、当前消息、流式状态（Map 结构支持多对话并行）、模型选择、上下文设置、并排模式、思考模式、待上传附件 |
| `agent-atoms.ts` | Agent 会话列表、当前会话、流式状态（`AgentStreamState`）、工作区选择、渠道选择、权限/AskUser 请求队列（按 sessionId Map） |
| `active-view.ts` | 主面板视图切换（'conversations' / 'automations' / 'agent-skills'） |
| `app-mode.ts` | 应用模式（'chat' / 'agent' / 'scratch'） |
| `settings-tab.ts` | 设置面板当前标签页 |
| `automation-atoms.ts` | 定时任务状态（automationsAtom、automationFormAtom） |
| `credits-atoms.ts` | 积分余额和用量统计 |
| `theme.ts` | 主题模式（light / dark / system） |
| `user-profile.ts` | 用户档案（姓名 + 头像） |
| `updater.ts` | 自动更新状态（检查/下载/安装），优雅降级（updater 不可用时保持 idle） |

### 渲染进程组件架构（`renderer/components/`）

- **`app-shell/`**：三面板布局（LeftSidebar | NavigatorPanel | MainContentPanel），侧边栏含模式切换、置顶对话、日期分组列表、流式指示器、余额显示、委派子会话树形折叠
- **`chat/`**：聊天核心 — ChatView（消息加载/流式订阅）、ChatHeader（模型选择/上下文设置）、ChatInput（Tiptap 富文本编辑器）、ChatMessages（消息列表/自动滚动）、ParallelChatMessages（并排模式）
- **`agent/`**：Agent 模式 — AgentView（3595 行，纯展示 + 交互，IPC 监听已提升到全局）、AgentHeader（渠道/模型选择）、AgentMessages（消息列表 + 工具活动）、SDKMessageRenderer（83KB，SDK 消息渲染，含协作工具 UI）、SidePanel（67KB，右侧面板）、PermissionBanner/AskUserBanner（权限/问答请求 UI）、MentionList（@ 提及文件/工作区）、ProcessBlockGroup（工具调用分组展示）、TaskProgressCard（任务进度卡片）；工作区切换器已随工作区模型收敛移除
- **`agent-skills/`**：Agent 技能全屏管理视图 — AgentSkillsView（982 行，Skills + MCP 管理）、SkillCard/SkillDetailSheet/McpCard/McpDetailSheet、ImportSkillDialog、useAgentSkillsData
- **`settings/`**：设置面板（30+ 个组件） — GeneralSettings、AppearanceSettings（含经典/现代风格切换）、ChannelSettings/ChannelForm、AgentSettings、McpServerForm、AboutSettings、FeishuSettings、DingTalkSettings、WeChatSettings、PromptSettings、ToolSettings、MemorySettings、ShortcutSettings、VoiceInputSettings、ProxySettings、MigrationSettings、StorageSettings、CreditsSettings（积分与用量）、BrandManager（Logo/品牌定制）、BotHubSettings/BotDefaultSettings、UpdateDialog、ReleaseNotesViewer；含 `primitives/` 可复用表单组件（团队工作区设置页已随团队运行时移除）
- **`file-browser/`**：文件浏览器 — FileBrowser（工作区文件树浏览）
- **`diff/`**：Diff 与 Markdown 编辑器 — DiffView/DiffTabContent（DiffTabContent 1310 行，并排 diff 展示）、PreviewPanel/PreviewTabContent（Markdown 预览）、MarkdownRichEditor/MarkdownEditorToolbar（富文本编辑）、MarkdownToc（目录导航）、PreviewFindBar（预览内搜索）、WorktreeSelector
- **`ai-elements/`**：AI 展示组件 — Markdown 渲染、代码块、Mermaid 图、推理折叠、上下文分割线、富文本输入
- **`automation/`**：定时任务 UI — AutomationsListView（347 行，任务列表）、AutomationFormView（1221 行，任务编辑表单）
- **`auth/`**：认证 — LoginDialog、JoinWorkspaceDialog
- **`scratch-pad/`**：草稿本 — ScratchPadView（340 行）
- **`quick-task/`**：快速任务窗口 — QuickTaskApp（462 行）
- **`onboarding/`**：新手引导 — OnboardingView
- **`tutorial/`**：教程横幅 — TutorialBanner
- **`welcome/`**：欢迎页 — WelcomeView、WelcomeEmptyState
- **`session-preview/`**：会话预览 — SessionMiniMapPopover
- **`ui/`**：Radix UI 组件（现代化设计，CSS 变量主题）

### 全局 Hooks（`renderer/hooks/`）

| Hook | 职责 |
|------|------|
| `useGlobalAgentListeners` | 全局 Agent IPC 监听器，在 `main.tsx` 顶层挂载，使用 `useStore()` 直接操作 atoms。处理流式事件、完成/错误、标题更新、权限请求、AskUser 请求，永不随组件卸载销毁 |
| `useBackgroundTasks` | 后台任务管理（Agent/Shell 任务的增删改查），按 sessionId 隔离 |

### 渲染进程初始化组件（`renderer/main.tsx`）

| 组件 | 职责 |
|------|------|
| `ThemeInitializer` | 从主进程加载主题设置、监听系统主题变化、同步到 DOM |
| `AgentSettingsInitializer` | 加载 Agent 渠道/模型/工作区设置、订阅 MCP/文件变化事件 |
| `AgentListenersInitializer` | 挂载 `useGlobalAgentListeners`，全局 Agent IPC 监听 |
| `UpdaterInitializer` | 订阅主进程推送的自动更新状态变化事件 |

### 本地文件存储（`~/.profer/`）

```
~/.profer/
├── channels.json           # 渠道配置（API Key 经 safeStorage 加密）
├── conversations.json      # 对话索引（元数据，轻量）
├── conversations/          # 消息存储
│   └── {uuid}.jsonl        # 每对话一个 JSONL 文件，追加写入
├── agent-sessions.json     # Agent 会话索引
├── agent-sessions/         # Agent 会话消息存储
│   └── {uuid}.jsonl        # 每会话一个 JSONL 文件
├── agent-workspaces/       # Agent 工作区目录
│   └── {workspace-slug}/
│       ├── {session-id}/   # 会话工作目录
│       ├── workspace-files/# 工作区持久文件
│       ├── mcp.json        # MCP Server 配置
│       └── skills/         # Skills 配置目录
├── attachments/            # 附件文件
│   └── {conversationId}/
│       └── {uuid}.ext
├── user-profile.json       # 用户档案 { userName, avatar }
├── settings.json           # 应用设置 { themeMode }
└── sdk-config/             # Agent SDK 配置目录
    └── projects/           # SDK 项目配置
```

**关键设计**：
- JSON 配置 + JSONL 追加日志，无本地数据库，文件可移植
- Agent 工作区按 slug 隔离，每个会话独立目录
- MCP 配置和 Skills 按工作区管理

> **2026-10-11 变更**：团队工作区运行时已移除，团队文件同步与 `workspace-files/` 缓存语义不再适用。

## 团队服务器

> 🔴 **团队服务器已迁移至独立私有 git 仓库**（原 `server/`），不再随本公开仓库发布。公开仓库中**没有** `server/` 目录。
>
> 在公开仓库中：不要提交、讨论 server 源码结构、服务器 IP、部署路径、凭据等敏感信息。server 开发/发布请在私有仓库中操作。

## 默认 Skills（`apps/electron/default-skills/`）

应用启动时 semver 比较自动同步到 `~/.profer/default-skills/` 和各工作区。共 19 个：

| Skill | 用途 |
|-------|------|
| `automation` | Profer 内嵌定时任务 Skill |
| `brainstorming` | 创意工作前需求探索和设计 |
| `docx` | Word 文档创建/读取/编辑 |
| `executing-plans` | 带审查检查点的实现计划执行 |
| `find-skills` | 发现和安装 Skills |
| `guizang-ppt-skill` | 横向翻页网页 PPT 生成 |
| `in-app-browser` | 应用内受管浏览器操作 |
| `lark-delivery` | 飞书交付 |
| `pdf` | PDF 文档处理 |
| `pptx` | PowerPoint 演示文稿 |
| `present-visualization` | 会话内可视化（图表/结构/对比） |
| `profer-coach` | Profer 使用顾问，优化工作流 |
| `profer-theme-authoring` | 主题/皮肤创作 |
| `session-cleaner` | 会话 JSONL 清洗为 Markdown |
| `skill-creator` | Skill 创建/编辑/评估 |
| `tool-builder` | 自定义 HTTP 工具管理 |
| `user-sense` | 用户感知/偏好推断 |
| `writing-plans` | 多步骤任务实施计划 |
| `xlsx` | 电子表格处理 |

## 构建工具

- **主进程/Preload**：esbuild (`--bundle --platform=node --format=cjs --external:electron --external:@anthropic-ai/claude-agent-sdk`)
- **渲染进程**：Vite + React 插件 + Tailwind CSS + HMR
- **开发热重载**：渲染进程通过 Vite HMR 即时生效；主进程/Preload 持续 watch 构建到 dist，但默认不自动重启 Electron，避免窗口反复抢焦点。修改 main/preload 后手动重启开发版。
- **打包分发**：electron-builder（配置见 `electron-builder.yml`）

### 重要：打包配置注意事项

**Agent SDK 打包要求（必须遵守）：**
- `@anthropic-ai/claude-agent-sdk` 必须使用 `--external` 参数排除在 esbuild 打包之外
- **0.2.113+ 架构变化**：SDK 主包已不再携带 JS CLI 入口（`cli.js`）和 `vendor/ripgrep/`，改为按平台分发 native binary（`claude` / `claude.exe`，单文件 214-252 MB），通过 `optionalDependencies` 安装到 `@anthropic-ai/claude-agent-sdk-{platform}-{arch}/` 子包
- `apps/electron/package.json` 必须显式声明当前 CI 矩阵覆盖的平台子包为 `optionalDependencies`（darwin-arm64 / darwin-x64 / win32-x64），否则 bun workspace 不会把它们链接到 `apps/electron/node_modules/`
- `electron-builder.yml` 的 `files` 配置要同时包含主包和所有平台子包：
  ```yaml
  files:
    - dist/**/*
    - package.json
    - node_modules/@anthropic-ai/claude-agent-sdk/**/*
    - node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**/*
    - node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/**/*
    - node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**/*
    - "!node_modules/@profer/**"
  ```
  > 注：`apps/electron/electron-builder.yml` 的这条排除规则已于 2026-10-18 从 `@proma` 订正为 `@profer`；改名后旧规则不再匹配任何目录，会把 workspace symlink 一并打进包。
- SDK 主包和同级平台子包会被复制到 `app/node_modules/@anthropic-ai/`，Node.js 的模块解析能从 `app/dist/main.cjs` 找到
- `agent-orchestrator.ts` 中 `resolveSDKCliPath()` 解析到 SDK 主包入口后，沿 `..` 到 `@anthropic-ai/` 同级目录，再拼 `claude-agent-sdk-${platform}-${arch}/{claude|claude.exe}` 得到 binary 路径

**跨平台打包限制：**
- 正式稳定发布默认仍只发布 Windows x64；Linux 正式签名发布暂未接入。
- macOS 具备 `macos-14` Apple Silicon (`darwin-arm64`) 的手动验收 workflow：`.github/workflows/macos-package.yml`。它只跑便携测试、typecheck、Mac 构建与包验证，并上传 Actions Artifact；不自动创建 Release。
- macOS 当前仅支持无签名、无公证的 arm64 验收包。只有用户明确要求时，才可将该 Artifact 作为测试版资产加入 GitHub Pre-release；不能把它当作正式稳定 Mac 发布。
- macOS 正式签名/公证发布仍未接入。Apple Silicon runner 不会构建 darwin-x64；Intel 需要 x64 runner 单独构建。

**不使用 extraResources 放 binary 的原因：**
- `extraResources` 会将文件复制到 `Contents/Resources/` 目录，路径与 node_modules 解析不一致
- 直接使用 `files` 配置让 Node.js 的模块解析能正确找到 SDK

**修改打包配置时的检查清单：**
1. ✅ 确认 SDK 在 esbuild 中使用 `--external` 参数
2. ✅ 确认 SDK 主包 + 所有目标平台子包都在 `files` 配置中
3. ✅ 确认 `apps/electron/package.json` 的 `optionalDependencies` 列出了所有目标平台子包
4. ✅ `bun install` 后验证 `apps/electron/node_modules/@anthropic-ai/claude-agent-sdk-{platform}-{arch}/` symlink 存在且 binary 可执行
5. ✅ 本地测试打包后的应用 Agent 功能（`CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist:fast`）

**其他依赖的打包策略：**
- **原则**：只有 `electron` 和 `@anthropic-ai/claude-agent-sdk` 需要标记为 `--external`
- `electron`：由 Electron 运行时提供，必须 external
- `@anthropic-ai/claude-agent-sdk`：有特殊打包要求（含 214 MB native binary），必须 external + 在 files 中包含主包和平台子包
- **所有其他依赖**（如 `electron-updater`、`undici`、`chokidar` 等）：应该让 esbuild 打包进 `main.cjs`
  - ✅ 优点：避免遗漏子依赖，简化 electron-builder 配置
  - ❌ 如果标记为 external：必须在 `electron-builder.yml` 的 `files` 中手动列出所有子依赖
- **常见错误**：将普通 npm 包标记为 external 但忘记在 `files` 中包含，导致打包后找不到模块（如 `Cannot find module 'universalify'`）

## 代码风格

- 永远不要使用 `any` 类型 — 创建合适的 interface
- 对象类型优先使用 interface 而不是 type
- 尽可能使用 `import type` 进行仅类型导入
- 注释和日志采用中文，保留专业术语
- **路径别名**：`@/` → `apps/electron/src/renderer/`

## TypeScript 配置

- Module: `"Preserve"` + `"moduleResolution": "bundler"`
- JSX: `"react-jsx"`，严格模式启用，Target: ESNext
- 所有包 `"type": "module"`，导入时使用 `.ts` 扩展名

## 版本管理

提交代码时始终递增受影响包的 patch 版本（如 `0.1.18` → `0.1.19`），影响多个包则都要递增。

### 默认 Skills 版本契约（`apps/electron/default-skills/`）

修改任何 `default-skills/<skill>/` 内容时，**必须同步递增该 Skill `SKILL.md` frontmatter 的 `version` 字段**（patch +1）。

**为什么**：`seedDefaultSkills()` 通过 semver 比较决定是否将 bundle 中的 Skill 同步到老用户的 `~/.profer/default-skills/`（全局元 skill 库）。**version 不变 = `seedDefaultSkills` 不会用新版覆盖全局库**。

> 2026-08-14 起，`upgradeDefaultSkillsInWorkspaces()` 语义已收窄：**只做「缺失即注入」**，不再对已存在的工作区 skill 做基于 version 的全量覆盖。工作区已装 skill 的更新改由「全局元 Skill → 手动同步」机制掌控（见下）。

### 全局元 Skill（master）与工作区同步

- **全局元 Skill 库** = `~/.profer/default-skills/{slug}/`，是唯一编辑源，用户可编辑、有版本历史、可回退。
- 历史快照：`~/.profer/default-skills-history/{slug}/v{n}/`（v1 为出厂基线/首次保存），版本索引 `index.json`。
- 保存即 bump：`skill-master-manager.ts:saveMasterSkill` 自动把 frontmatter `version` patch+1 并落盘一条快照；`rollbackMasterSkill` 回退并保留一条新回退记录。
- **工作区同步**：`syncMasterSkillToWorkspace` 手动把元 skill 覆盖到选定个人工作区 `skills/{slug}`，写 `.source.json`（`sourceKind:'master'` + baseline 内容哈希）。
- **冲突检测**：基于内容哈希（`detectSkillConflict`），工作区副本相对上次同步基线被改过即视为冲突；非强制同步会拒绝覆盖，由 UI 让用户选择「覆盖/跳过」。
- UI 入口：Agent 技能视图「元 Skill」tab（编辑/版本回退/同步到工作区），`MasterSkillsTab.tsx` / `MasterSkillDetailSheet.tsx` / `SyncMasterSkillDialog.tsx`。
- 团队市场与跨工作区导入逻辑不受影响；master 同步只作用于个人工作区本地 skills。

**早期实现曾用"无条件 cpSync"绕开 seed 约束**，但每次启动同步 4MB+ 文件会阻塞主进程导致启动卡顿，已恢复为 semver 比较（见 `config-paths.ts:seedDefaultSkills`）。

### 发版流程（本地发布，顺序不固定，2026-08-18 起；2026-10-31 起允许 macOS 先发）

正式发版由本地脚本完成，macOS 与 Windows 可以任意顺序执行：先跑的一方负责推送源码/tag、创建并发布 GitHub Release；后跑的一方检测到已发布 Release 后只补充自己的资产，不重复创建。`release.yml` 仅保留手动触发的构建验证，绝不因 tag 自动构建或写入 GitHub Release，避免双重构建和两个发布者竞争同一 Release。

- Windows x64：`node scripts/push-release.cjs X.Y.Z`，构建签名安装包、上传国内更新源、创建或补充 Windows 资产。
- macOS arm64（Apple Silicon）：`node scripts/push-mac-release.cjs X.Y.Z`，构建 ad-hoc 签名包、上传 macOS 更新源、创建或补充 macOS 资产；允许先创建 tag/Release。

两者都要求 tag 与 package.json/CHANGELOG 首条版本一致，已存在的本地/远端 tag 必须指向 HEAD；脚本不 rebase、不强推 tag。`--allow-published-release` 只用于“补充已发布 Release”，不会放宽版本与 tag 一致性。无签名 Windows 测试包若需同步国内源，也只能走明确确认的临时测试流程，不能调用正式 `push-release.cjs`，不能伪造 `latest.yml.sig`。`.github/workflows/macos-package.yml` 仅做手动构建验收，不写入 GitHub Release。

```bash
# 1) 先提交 package.json、CHANGELOG.json 和本次客户端代码；工作树必须干净
# 2) 任意顺序执行（示例：macOS 先创建 tag/Release，Windows 后补资产）
node scripts/push-mac-release.cjs X.Y.Z
node scripts/push-release.cjs X.Y.Z
# 脚本不 rebase、不强推 tag；远端 main 或同名 tag 不一致会明确失败。
```

> 注意：tag 与 package.json/CHANGELOG 首条版本必须一致。GitHub API 503 时脚本会有限重试，并在每次上传后按资产名、大小与 `uploaded` 状态收敛验证。

两个构建目标编译时注入 `__PROFER_BUILD_TARGET__`（`oss` / `commercial`），互不串扰。

**新增 Skill 不需要先注入 default-skills 目录的旧版本**——`upgradeDefaultSkillsInWorkspaces` 会通过"目标缺失即注入"路径让所有老工作区自动获得。

## Agent SDK 集成架构

基于 `@anthropic-ai/claude-agent-sdk@0.3.201` 实现 Agent 模式，与 Chat 模式并行。

### 核心流程

```
用户输入 → agent-orchestrator.ts (SDK 编排)
  ↓
SDK query() → SDKMessage 流
  ↓
convertSDKMessage() → AgentEvent[]
  ↓
webContents.send() → IPC 推送
  ↓
useGlobalAgentListeners (全局监听) → store.set(atoms)
  ↓
React UI 更新
```

### 关键组件

#### agent-orchestrator.ts（核心编排层，约 3860 行）
- **并发守卫**：同一会话不允许并行请求
- **渠道管理**：查找渠道 + API Key 解密
- **环境构建**：环境变量 + SDK 路径解析
- **消息持久化**：SDK 消息存储到 JSONL
- **事件流处理**：文本累积 + 工具调用解析
- **错误处理**：SDK 错误映射 + 重试逻辑
- **自动标题**：首次对话自动生成标题

#### agent-prompt-builder.ts（提示词构建，348 行）
- **系统提示词生成**：基于工作区配置
- **动态上下文构建**：注入工作区信息
- **内置 Agent 构建**：预定义 Agent 配置

#### agent-permission-service.ts（权限管理）
- **工具权限检查**：基于权限规则
- **权限模式管理**：safe / ask / allow-all

### 关键设计

- **SDK 调用**：`sdk.query({ prompt, options: { apiKey, model, permissionMode, cwd, abortController } })`
- **事件转换**：`convertSDKMessage()`（`@profer/shared`）将 SDK 原始消息转为统一的 `AgentEvent` 类型
- **工具匹配**：`packages/shared/src/agent/tool-matching.ts` — 无状态 `ToolIndex` + `extractToolStarts` / `extractToolResults` 解析工具调用
- **状态管理**：`applyAgentEvent()` 纯函数更新 `AgentStreamState`，支持流式增量更新
- **全局 IPC 监听**：`useGlobalAgentListeners`（`renderer/hooks/`）在 `main.tsx` 顶层挂载，通过 `useStore()` 直接操作 atoms，永不销毁。确保页面切换（如设置页）时流式输出、权限请求不丢失
- **权限请求排队**：权限/AskUser 请求按 sessionId 入队到 Map atoms（`allPendingPermissionRequestsAtom` / `allPendingAskUserRequestsAtom`），不区分当前/后台会话，SDK Promise 等待用户回来响应
- **工作区隔离**：每个工作区独立的 MCP Server 配置和 cwd，Agent 会话按工作区过滤

### SDK 版本升级注意事项

**`@anthropic-ai/claude-agent-sdk` 0.2.113+ `options.env` 语义为"替换"**

- SDK 将 `options.env` **替换** 传递给子进程（0.2.111/0.2.112 短暂改为叠加，0.2.113 恢复替换）
- 如果传 `env` 时只给 `ANTHROPIC_*` 相关变量，子进程会丢失 `PATH` / `HOME` / `SHELL` 等关键变量，导致 SDK 调用 `npx` / `git` 等命令失败
- **正确做法**：`agent-orchestrator.ts` 的 `buildSdkEnv()` 末尾显式 `{ ...cleanEnv, ...customEnv }` 合并 `process.env`，再剥离不希望泄漏的 `ANTHROPIC_*` 变量
- **修改 `buildSdkEnv()` 时的检查清单**：
  1. ✅ 基于 `process.env` 合并，保证 PATH / HOME / SHELL 等继承到子进程
  2. ✅ 过滤掉不希望泄漏的 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS`、`ANTHROPIC_MODEL` 等
  3. ✅ 新增的 SDK 识别的环境变量必须显式加入 `sdkEnv`
- 若未来升级到后续大版本导致语义再次变化，需重新评估本加固逻辑

**关键 Breaking Changes（升级参考）**：
- `0.2.91`: `sandbox.failIfUnavailable` 默认从 `false` 变为 `true`（目前项目未使用 sandbox 选项）
- `0.2.111`: `options.env` 从"替换"变为"叠加"
- `0.2.113`:
  - `options.env` 回退为"替换"
  - **SDK 包结构重构**：删除 `cli.js`，改为平台 native binary（通过 `@anthropic-ai/claude-agent-sdk-{platform}-{arch}` optionalDependency 分发），ripgrep 编译进 binary
  - 详见上方"打包配置注意事项"段落
- `0.2.120`: `query()` 省略 `settingSources` 时默认加载所有来源（Proma 已显式传 `['user', 'project']`，不受影响）
- `0.3.142`: SDK/headless 默认使用 Task 工具（`TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList`）替代已废弃的 `TodoWrite`；MCP server 默认后台连接，慢连接会在 `init` 中呈现 `pending`
- `0.3.143`: `@anthropic-ai/sdk` 与 `@modelcontextprotocol/sdk` 改为 peerDependencies；bun/npm/pnpm 会自动安装

### 共享类型（`@profer/shared`）

- `AgentEvent`：Agent 事件（text / tool_start / tool_result / done / error）
- `AgentSessionMeta`：会话元数据（id / title / channelId / workspaceId）
- `AgentMessage`：持久化消息（role + content blocks）
- `AgentSendInput`：发送请求输入
- `AGENT_IPC_CHANNELS`：Agent 相关 IPC 通道常量
- `WorkspaceCapabilities`：工作区能力（MCP Server 列表 + Skills 列表）

## 创作参考

遵循 [craft-agents-oss](https://github.com/craftship/craft-agents-oss) 的模式：

- **会话管理**：收件箱/归档工作流
- **权限模式**：safe / ask / allow-all
- **Agent SDK**：@anthropic-ai/claude-agent-sdk（[v1 文档](https://platform.claude.com/docs/en/agent-sdk/typescript)、[v2 文档](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)）
- **MCP 集成**：Model Context Protocol 用于外部数据源
- **凭证存储**：AES-256-GCM 加密
- **配置位置**：`~/.profer/`（类似 `~/.craft-agent/`）

## 核心特性

### 已实现功能

- ✅ **多 Provider 支持**：Anthropic、OpenAI、DeepSeek、Kimi、智谱、MiniMax、豆包、通义千问、Google、自定义端点
- ✅ **Agent SDK 集成**：基于 Claude Agent SDK 的完整 Agent 模式
- ✅ **飞书集成**：消息同步、任务通知、OAuth 认证（2555 行核心服务）
- ✅ **工作区管理**：多工作区隔离、MCP Server 配置、Agent 技能全屏管理、团队文件管理
- ✅ **权限系统**：工具权限检查、用户确认流程
- ✅ **Automation 定时任务**：持久化调度、运行历史、手动运行、失败保护、飞书通知
- ✅ **记忆系统**：跨会话记忆存储与检索
- ✅ **自动更新**：Electron Updater 集成
- ✅ **代理支持**：系统代理检测与配置
- ✅ **文档解析**：PDF、Office、文本文件提取
- ✅ **多模态支持**：图片、文档附件
- ✅ **Chat 工具**：内置工具系统 + 动态加载

### 架构亮点

- **并发守卫**：同一会话防止并行请求冲突
- **全局监听**：Agent IPC 监听器永不销毁，确保后台会话不丢失
- **权限排队**：按 sessionId 隔离权限请求，支持多会话并行
- **文件监听**：工作区文件、MCP 配置、Chat 工具实时监控
- **事件流处理**：SDK 消息流式转换与累积
- **错误映射**：SDK 错误统一转换为应用错误

## 更新日志

> 2026-06-20

### 安全修复
- JWT_SECRET 改为强制要求环境变量（`server/src/config.js`），拒绝默认值
- Admin 密码改为 `ADMIN_PASSWORD` 环境变量，未设置则随机生成（`server/src/db.js`）
- 文件上传增加 `MAX_FILE_SIZE` 上限（默认 500MB），Content-Length 预检 + buffer 双校验（`server/src/routes/files.js`）

### 服务端模块化
- `server/index.js` 拆分为 `src/{config,db,utils,middleware,routes/{auth,workspaces,invitations,sync,files,heartbeat}}`
- 修复 `safePath()` 跨平台路径分隔符 bug（Windows `\` 不兼容 `root + '/'` 前缀检查，改用 `pathSep`）

### Agent 编排层拆分
- `agent-orchestrator.ts` 提取 `agent-retry-utils.ts`、`agent-prompt-utils.ts`、`agent-sdk-cli-path.ts`、`agent-directory-utils.ts`
- `feishu-bridge.ts` 补充提取 `feishu/group-utils.ts`

### 团队文件管理体验收尾
- 团队模式主界面改为文件管理主区 + 可收起 Agent 侧栏，窗口控制按钮嵌入文件管理顶栏，保留可拖动标题栏区域
- 上传按钮改为稳定的分裂按钮，支持上传文件和上传文件夹，修复窄宽度下顶栏文字换行与展开菜单点击问题
- 团队文件预览优先使用本地 `workspace-files/` 缓存；自己上传的文件直接使用本地路径，缓存缺失或其他成员文件再下载
- 拖拽导入遵循目标目录：拖到当前目录空白处进入当前目录，拖到文件夹卡片 / 列表行 / 树节点直接进入该文件夹
- 团队文件可拖入右侧 Agent 面板解读，并使用专用拖拽类型避免和普通本地文件拖拽冲突

### Bug 修复
- Hono v4 `*` 通配符 `c.req.param('*')` 返回 undefined，DELETE/DOWNLOAD 改为 `:path{.+}` 命名通配符
- 删除团队文件时间步清理本地 `workspace-files/` 副本
- Electron 拖拽兼容：`dataTransfer.items` 为空时回退到 `dataTransfer.files`
- `<input webkitdirectory>` 在 Electron 不工作，改用 `dialog.showOpenDialog` + `readDirectoryRecursive` 原生方案
- 服务端上传自动补齐父目录 `is_directory=1` 条目（确保客户端 `buildFileTree` 正确构建树）

### 测试
- 新增 `agent-retry-utils.test.ts`、`agent-directory-utils.test.ts`、`server/src/utils.test.js`（37 用例）

### 部署
- 团队服务器部署详情已随 server 迁移至本地私有仓库 `server-private.git`，公开仓库不再记录服务器地址与路径。

## 后续计划

### 高优先级
- HTTPS + 域名（nginx + Let's Encrypt）
- 数据库定期备份（SQLite 单文件）
- 注册限流（防暴力注册）
- 工作区解散/恢复机制（冷静期 + 到期清理）
- 邀请列表管理（pending/accepted/expired）
- 文件搜索功能

### 中优先级
- ~~PC 客户端自动更新（electron-updater）~~ ✅ 已完成（v0.12.27+，双渠道：国内服务器 + GitHub）
- 邀请过期自动清理（定时任务）
- 拖动稳定性优化
- feishu-bridge 继续拆分（command-handlers、chat-history）
- 错误监控（服务端日志收集）

### 低优先级
- Skill 市场（Phase 3）
- 审计日志、使用统计
- 多团队服务器配置
- E2E 测试（多客户端完整流程）
- 客户端签名（Windows/macOS）
