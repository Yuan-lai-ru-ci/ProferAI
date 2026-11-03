# 工作区项目模式实施规格

> 日期：2026-11-03（GMT+8）
> 状态：待实施；本文是文件级施工清单，依据《2026-10-19 工作区项目模式设计》v2
> 前置决定：存量 managed 工作区原样保留，不做迁移；本轮只新增 project 模式

## 1. 不变量

实施过程中任何一条被破坏都算回归：

| 编号 | 不变量 |
|---|---|
| I1 | managed 模式的路径、cwd、技能、预设、会话行为零变化 |
| I2 | project 模式下任何代码路径都不得递归删除 `rootPath` |
| I3 | 会话消息、checkpoint、blobs、attachments 不写入项目目录 |
| I4 | `rootPath` 不存在时不自动创建，抛明确错误 |
| I5 | 同一 `rootPath`（realpath 归一化后）只允许一个工作区 |
| I6 | 旧文件名（`workspace-profile.md`、`agent-presets.json`）继续可读，新项目写新名；项目模式预设新布局为 `presets/` 目录 + `_config.json` |
| I7 | 预设引用的 `skillSlugs` / `mcpServerNames` 缺失时不得静默剔除，必须产出结构化诊断 |
| I8 | `mcp.local.json` 不进入版本控制，且任何写入路径都不得把其内容合并回 `mcp.json` |
| I9 | 未知主版本的预设 schema 只读打开，不自动改写；未知字段原样保留 |

## 2. 数据模型

### 2.1 shared 类型

文件：`packages/shared/src/types/agent.ts`

```ts
export type WorkspaceStorageMode = 'managed' | 'project'

export interface AgentWorkspace {
  // ...现有字段不变
  /** project 模式：项目根绝对路径；managed 不落盘 */
  rootPath?: string
  /** 缺省视为 managed */
  storageMode?: WorkspaceStorageMode
}
```

### 2.2 索引 v4

文件：`apps/electron/src/main/lib/agent-workspace-manager.ts`

- `INDEX_VERSION` 3 → 4。
- 迁移逻辑：所有存量条目补 `storageMode: 'managed'`，不写 `rootPath`。
- `writeIndex` 前校验：
  - `project` 必须有 `rootPath`，且为绝对路径；
  - `managed` 不得有 `rootPath`；
  - `rootPath` 经 `realpathSync`（不存在时用 `resolve`）归一化后唯一。
- 读取时对缺失 `storageMode` 的条目按 `managed` 处理（双保险）。

### 2.3 项目清单 `profer.json`

新项目创建时写入：

```json
{
  "schema": "profer.project/1",
  "name": "my-project",
  "createdAt": "2026-11-03T00:00:00.000Z",
  "proferVersion": "0.16.17"
}
```

规则：

- 不写绝对路径、用户名、机器标识；
- 缺失但 `.profer/` 存在 → 视为旧格式，补写，不覆盖其他文件；
- `schema` 主版本不认识 → 只读打开，提示升级，不改写。

### 2.4 预设存储（项目模式）

文件：`preset-store.ts`（新，`PresetStore` 接口与目录 / 单文件两种后端）、`agent-preset-manager.ts`（改为经 `PresetStore` 读写）、`config-paths.ts`（新增目录路径函数）

| 路径 | 内容 | 是否提交 |
|---|---|---|
| `<root>/.profer/presets/_config.json` | `schema: "profer.presets/1"`、`defaultPresetReference`、`defaultPresetExplicitlyCleared`、`disabledGlobalPresetIds`、`disabledWorkspacePresetIds`、`migrationDiagnostics` | 是 |
| `<root>/.profer/presets/<presetId>.json` | 单个 `AgentPreset`，带 `schema: "profer.preset/1"`；不写 `scope` / `workspaceSlug` / `enabledInWorkspace` | 是 |
| `<root>/.profer/agent-presets.json` | 旧单文件，仅兼容读；首次写入时拆分，原文件保留 | 遗留（目录存在时忽略，建议迁移后删除） |
| `~/.profer/agent-workspaces/<slug>/agent-presets.json` | managed 保持单文件，零变化（I1） | — |

读写规则：

- `PresetStore` 接口：`readConfig(slug)`、`writeConfig(slug, config)`、`readPreset(slug, id)`、`writePreset(slug, preset)`、`deletePreset(slug, id)`、`listDiagnostics(slug)`；内部按 `storageMode` 选目录或单文件，上层 CRUD 与错误码不变。
- 目录优先：`presets/` 存在时忽略 `agent-presets.json`；目录不存在时读旧单文件（行为与 managed 一致）。
- 拆分时机：首次写入（改预设 / 改默认 / 改禁用清单）；写 `_config.json` + N 个预设文件，逐文件 `writeJsonFileAtomic`，失败只回滚本次新写文件。
- 删除预设：删文件 + 清 `_config.json` 引用；默认引用指向被删预设时回退到 standard 并记 `default-missing` 诊断，不静默。
- 文件名 = `presetId`，只允许 `[A-Za-z0-9_-]`，其他字符拒绝写入（防路径穿越）。
- 内置预设（`standard` / `code` / `minimal`）不落盘。
- 写锁：`.profer/.lock`，与 watcher / 多实例共用。

### 2.5 预设 schema 版本与引用校验

`_config.json` / 单预设文件的 `schema` 解析：

| 读到的 schema | 行为 |
|---|---|
| `profer.presets/1`、`profer.preset/1` | 正常读写 |
| 缺失 | 视为 `/0`（旧单文件），可读，首次写入升级 |
| `profer.presets/2` 等未知主版本 | 只读：可列出、可选用，禁止保存与迁移；提示升级 |
| 非法 JSON / 非法 `presetId` | 单文件跳过并记 `invalid-file`，其他预设照常 |

未知字段必须 round-trip 保留；`preset.version`（实体版本）与 schema 版本无关，不触发自动改写。

引用校验（新 `preset-reference-diagnostics.ts`）：

```ts
export type PresetReferenceIssueKind =
  | 'missing-skill' | 'missing-mcp' | 'unavailable-mcp'
  | 'local-only-mcp' | 'stale-workspace-reference' | 'invalid-file'

export interface PresetReferenceIssue {
  presetId: string
  kind: PresetReferenceIssueKind
  ref: string
  detail?: string
}
```

- 解析顺序：项目 `skills/` → 全局 `global-skills/`；MCP 用 `mcp.json` ← `mcp.local.json` 的合并结果。
- 只读诊断，不修改预设文件；`updateAgentPreset` / 导出 / 保存前都不得过滤缺失项。
- 只有显式修复 API（`prunePresetReferences(slug, presetId, refs)`）才改写白名单，且必须返回 before/after 供 UI 确认。
- 现有枚举清洗（`disabledTools` / `suppressPromptSections` / `disabledToolGroups`）保持原逻辑，不纳入本校验。

### 2.6 MCP 密钥分离

- `<root>/.profer/mcp.json`：提交，非敏感配置，密钥用 `${env:VAR}`。
- `<root>/.profer/mcp.local.json`：不提交（命中 `*.local.json`），本机覆盖层；按 server name 深度合并，local 覆盖 base。
- 只读合并，写入只写 `mcp.json`；保存时检测疑似明文密钥（`sk-` / `ghp_` / `xoxb-` / 长随机串）并提示，不自动改写。
- local 新增的 server 标记 `local-only`，预设白名单引用它时产出 `local-only-mcp` 诊断。

## 3. 路径契约

### 3.1 新增 `workspace-locator.ts`

文件：`apps/electron/src/main/lib/workspace-locator.ts`（新）

```ts
export interface WorkspaceLocation {
  configDir: string   // managed: ~/.profer/agent-workspaces/<slug>
                      // project: <rootPath>/.profer
  rootPath: string    // managed: 同 configDir；project: 项目根
  mode: WorkspaceStorageMode
}

export function resolveWorkspaceLocation(slug: string): WorkspaceLocation
export function invalidateWorkspaceLocation(slug?: string): void
```

约束：

- 只依赖 `getConfigDir()` 与索引文件，**不 import `agent-workspace-manager`**，避免循环依赖；
- 进程内 `Map<slug, WorkspaceLocation>` 缓存；manager 的增删改、索引写入后调用 `invalidate`；
- `configDir` 允许按需 `mkdir`；`rootPath` 永不 `mkdir`。

### 3.2 `config-paths.ts` 改造

文件：`apps/electron/src/main/lib/config-paths.ts`

- `getAgentWorkspacePath(slug)`：语义改为返回 `configDir`，签名不变；
- 新增 `getWorkspaceRootPath(slug)`：返回 `rootPath`；
- 以下函数内部改为走 locator，签名不变：
  - `getWorkspaceMcpPath`
  - `getWorkspaceSkillsDir`
  - `getInactiveSkillsDir`
  - `getWorkspaceAgentPresetsPath`（保留：managed 单文件；project 为旧单文件路径，仅兼容读）
  - `getWorkspaceFilesDir`
  - `getAgentSessionWorkspacePath`（managed 保持 `<configDir>/<sessionId>`；project 返回 `<configDir>/sessions/<sessionId>`，**只作为会话运行时存储目录，永不返回 `rootPath`**。它带 mkdir 副作用且被删除/复制路径复用，与 cwd 是两种语义，必须分离；cwd 由 §5 的 `resolveSessionCwd()` 单独解析）
- 新增预设 / MCP 路径函数：
  - `getWorkspacePresetsDir(slug): string | null`（project → `<configDir>/presets`；managed → `null`）
  - `getWorkspacePresetsConfigPath(slug)`（project → `<configDir>/presets/_config.json`；managed → `<configDir>/agent-presets.json`）
  - `getWorkspaceMcpLocalPath(slug)`（两种模式均 `<configDir>/mcp.local.json`）
- **调用方不得假设 `getWorkspaceAgentPresetsPath` 是唯一存储**：预设读写统一经 `PresetStore`（§2.4），路径函数只用于定位与迁移。
- profile / memory 路径：`agent-workspace-manager.ts` 内 `WORKSPACE_PROFILE_FILE` 改为解析函数，project 模式优先 `profile.md`，回退 `workspace-profile.md`。

### 3.3 缓存失效点

以下操作后必须 `invalidateWorkspaceLocation(slug)`：

- `createAgentWorkspace` / `createProjectWorkspace`
- `updateAgentWorkspace`（改名不影响路径，但归档状态不影响，可不调）
- `deleteAgentWorkspace` / `removeProjectWorkspace`
- 索引外部变更（团队同步、migration-service 写入后）

## 4. 文件级改动清单

### P0：契约与路径收口（不改行为）

| 文件 | 改动 | 测试 |
|---|---|---|
| `packages/shared/src/types/agent.ts` | 新增 `WorkspaceStorageMode`、两个字段 | 类型检查 |
| `apps/electron/src/main/lib/workspace-locator.ts` | 新建 | `workspace-locator.test.ts`（新） |
| `config-paths.ts` | workspace 级函数走 locator；新增 `getWorkspaceRootPath` | `config-paths` 相关既有测试 |
| `agent-workspace-manager.ts` | `INDEX_VERSION=4`；迁移补字段；写入校验；invalidate 接线 | `agent-workspace-manager` 既有测试 + 新增 v4 迁移用例 |
| `migration-service.ts` | 28 处路径调用核对，确保走新函数 | 既有测试 |
| `global-skill-manager.ts` | 技能路径按 locator 解析 | 既有测试 |

P0 验收：全量测试通过；13 个存量工作区的路径、技能、预设、会话 cwd 与改造前一致（可用快照对比脚本）。

### P1：项目模式核心

| 文件 | 改动 |
|---|---|
| `agent-workspace-manager.ts` | 新增 `createProjectWorkspace(rootPath, name?)`、`openProjectWorkspace(rootPath)`、`removeProjectWorkspace(id)`；`deleteAgentWorkspace` 按 mode 分支 |
| `agent-session-manager.ts` | 会话创建 / fork / reset 的 cwd 解析改走 §5 |
| `agent-orchestrator.ts` | `agentCwd` 解析改走 §5；提示词上下文传 `rootPath` |
| `agent-service.ts` | `buildRuntimeHeadlessRunContext` 的 cwd 改走 §5 |
| `agent-directory-utils.ts` | `collectAttachedDirectories`：project 模式加 `rootPath`，不重复加 configDir |
| `apps/electron/src/main/ipc.ts` | 新增 IPC：选择文件夹、创建项目、打开项目、移除项目、检查路径 |
| `apps/electron/src/preload/index.ts` | 对应桥接方法 |
| `renderer/hooks/useProjectActions.ts` | 创建流程支持「选择文件夹」分支 |
| `renderer/components/app-shell/left-sidebar/sidebar-dialogs.tsx`、`use-left-sidebar.ts` | 创建/打开入口、路径失效提示 |
| `agent-runtime-cwd-isolation.parity.test.ts` | 按 mode 分叉断言 |

### P2：配置资产与监听

| 文件 | 改动 |
|---|---|
| `config-paths.ts` | profile/memory/skills/mcp/presets/files 全部按 mode 解析；新增 `getWorkspacePresetsDir`、`getWorkspacePresetsConfigPath`、`getWorkspaceMcpLocalPath` |
| `agent-workspace-manager.ts` | 读写 profile/memory 兼容新旧文件名；创建骨架生成 `presets/_config.json` |
| `agent-preset-manager.ts` | 抽出 `PresetStore`；`readConfig` / `writeConfig` 按 mode 分派；旧单文件拆分；目录写锁 |
| `preset-store.ts`（新） | 目录 / 单文件两种后端；原子写、失败回滚、删除时清理 `_config.json` 引用 |
| `preset-reference-diagnostics.ts`（新） | `skillSlugs` / `mcpServerNames` 引用解析与诊断（§2.5） |
| `agent-preset-operations.ts` | 保存 / 导出不过滤缺失引用；新增显式修复入口（返回 before/after） |
| `workspace-mcp-config.ts` | `mcp.json` ← `mcp.local.json` 单向合并；明文密钥检测；project 模式读 `<root>/.profer/mcp.json` |
| `file-preview-service.ts` / 文件浏览器 | 根目录按 mode 切换，`.profer` 可展开 |
| renderer 预设页 | 岗位卡片缺失角标、`local-only` 标记、schema 只读提示、clone 后缺项引导 |
| `workspace-watcher.ts` | 多根监听：managed 根 + 每个 project 的 `.profer`；跳过 `sessions/` |
| `skill-master-manager.ts` / `global-skill-manager.ts` | 项目技能与全局技能的边界核对 |

### P3：品牌呈现

| 项 | 内容 |
|---|---|
| `profer.json` | 创建时生成；打开时校验 schema |
| 项目切换器 | 名称 + 路径 + `.profer` 徽标 |
| 空状态 / toast | 「已识别 Profer 项目」 |
| 设置页 | 「项目格式」说明：建议提交与默认忽略清单 |
| 官网 | `project-format` 文档页（仓库外，另行排期） |

## 5. cwd 解析规则

唯一实现放在 locator 旁的纯函数，三处调用：

```ts
export function resolveSessionCwd(workspace: AgentWorkspace | undefined, sessionId: string): string {
  if (!workspace) return homedir()
  const loc = resolveWorkspaceLocation(workspace.slug)
  if (loc.mode === 'project') return loc.rootPath
  return join(loc.configDir, sessionId)
}
```

调用点：

1. `agent-orchestrator.ts` 的 `agentCwd`；
2. `agent-service.ts#buildRuntimeHeadlessRunContext`；
3. `agent-session-manager.ts` 的 fork / reset / 复制路径。

验收断言：

- managed：`cwd === <configDir>/<sessionId>`，且不等于 `configDir`；
- project：`cwd === rootPath`，同项目两个会话 cwd 相同（显式断言，防止回退）；
- 无工作区：`cwd === homedir()`。

## 6. 生命周期

### 6.1 创建 project 工作区

1. 系统目录选择器选文件夹。
2. 校验清单：
   - 路径存在且是目录；
   - 可读写（实际写入一个临时探针文件后删除）；
   - 不是文件系统根；
   - 不在 `~/.profer` / `~/.profer-dev` 内；
   - `realpath` 后不与现有 `rootPath` 重复。
3. 若 `<root>/.profer` 已存在 → 转「打开已有项目」，不覆盖。
4. 生成骨架（只创建缺失项）：
   - `profer.json`、`profile.md`、`memory/MEMORY.md`
   - `skills/`、`skills-inactive/`、`workspace-files/`
   - `mcp.json`（`{ "mcpServers": {} }`）、`presets/_config.json`（`profer.presets/1` 空结构，不预生成岗位文件）
   - `.gitignore`
5. 写索引：`storageMode: 'project'`、`rootPath: realpath`、`slug` 继续用现有 slugify。
6. 失败回滚：只删除本次新建的文件；**不删除项目内任何既有内容**。

### 6.2 打开已有项目

- 读 `profer.json`；缺失则补写，不覆盖其他文件。
- 缺失的目录/文件按骨架补齐，已存在的跳过。
- 若该项目已被索引绑定 → 直接返回既有工作区，不新建条目。

### 6.3 移除 project 工作区

- 仅删除索引条目。
- 二次确认文案必须明确：「只从 Profer 移除，不会删除项目文件或 `.profer`」。
- 会话记录保留（仍可按 sessionId 访问），但 UI 不再展示。

### 6.4 路径失效

- 启动时与打开工作区时 `stat(rootPath)`。
- 失效状态不落盘；UI 显示「项目路径不可用」，提供「重新定位」「从列表移除」。
- 失效期间禁止新建会话，禁止任何自动 `mkdir`。

## 7. 文件监听

- managed：保持现有 `startWorkspaceWatcher` 对 `agent-workspaces/` 的递归监听。
- project：为每个 `<root>/.profer` 单独建 watcher，跳过 `sessions/` 与噪声目录。
- 项目源码变化不进入 `WORKSPACE_FILES_CHANGED`，交给 git diff / 预览链路。
- 本机 FSEvents 不派发的已知问题：沿用现有逐目录 `fs.watch` 方案，不引入 chokidar 递归。

## 8. 品牌落地

### 8.1 `.profer/.gitignore`

```gitignore
sessions/
.cache/
*.local.json
.lock
```

`profile.md`、`memory/`、`skills/`、`mcp.json`、`presets/`（含 `_config.json`）默认纳入版本控制；`mcp.local.json` 被 `*.local.json` 忽略，永不提交。岗位库是团队资产，默认提交；会话与缓存不提交。

### 8.2 首次创建提示

一句话，不打断流程：「`.profer` 会随项目提交；请勿在 profile.md / memory 中写入密钥；MCP 密钥请放 `mcp.local.json`（不会提交）。」

### 8.3 UI 标识

- 项目切换器：名称 + 路径副标题 + `.profer` 徽标；
- 打开已有配置：toast「已识别 Profer 项目」；
- 文件树：`.profer` 品牌图标 + 「在 Finder / 资源管理器中显示」。

## 9. 验收用例

| 编号 | 用例 | 通过标准 |
|---|---|---|
| A1 | 新建 project 工作区 | `.profer` 骨架完整（含 `presets/_config.json`）；`profer.json` schema 正确；索引有 `rootPath` |
| A2 | project 会话执行 `pwd` | 返回项目根 |
| A3 | 同项目两个会话 | cwd 相同，且都等于项目根 |
| A4 | managed 会话升级后 | cwd 仍为 `<configDir>/<sessionId>` |
| A5 | 移除 project 工作区 | 项目文件与 `.profer` 全部存在，索引条目消失 |
| A6 | 删除路径审计 | 单测断言 project 分支从未以 `rootPath` 为参数调用 `rmSync` |
| A7 | 重复绑定同一文件夹 | 被拒绝，提示已绑定 |
| A8 | 项目被移动 | UI 显示路径失效；不自动重建目录 |
| A9 | 打开已有 `.profer` | 不覆盖既有文件；缺失项补齐 |
| A10 | 项目技能 / 预设 / MCP | 从 `.profer` 生效，重启后保持；岗位来自 `presets/` 目录 |
| A11 | 项目源码变化 | 不触发工作区文件事件 |
| A12 | 存量 13 个工作区 | 路径、技能、预设、cwd 与改造前快照一致 |
| A13 | **clone 恢复岗位** | 新机器 `git clone` 后打开项目：`presets/` 内岗位全部可见，`defaultPresetReference` 解析到当前工作区（无 slug 残留），默认岗位生效 |
| A14 | 岗位引用缺失 | 删除被引用的技能或 MCP 后加载：产出 `missing-skill` / `missing-mcp` 诊断；白名单原样保留，保存后文件字节不变 |
| A15 | `mcp.local.json` 隔离 | local 内容不出现在 `mcp.json`，不进 `git status`；本机 MCP 生效；`local-only` server 被引用时有诊断 |
| A16 | 预设 schema 未知版本 | 手工改 `_config.json` 为 `profer.presets/2`：可查看不可保存，提示升级，文件不被改写 |
| A17 | 旧单文件迁移 | 只有 `.profer/agent-presets.json` 时可读；首次写入生成 `presets/` 与 `_config.json`，旧文件保留且内容不变 |
| A18 | 单个岗位文件损坏 | 一个 `<id>.json` 非法 JSON：其余岗位正常加载，坏文件标记 `invalid-file`，不被删除 |

## 10. 实施顺序与检查点

| 步骤 | 内容 | 检查点 |
|---|---|---|
| Step 0 | 建分支；生成存量行为快照（路径、cwd、技能清单） | 快照可复现 |
| Step 1 | P0 契约与路径收口 | `bun run typecheck`、聚焦测试、全量测试、A12 |
| Step 2 | P1 创建/打开/移除 + cwd | A1–A9、手工验收 |
| Step 3 | P2 配置资产 + watcher | A10、A11、A13–A18 |
| Step 4 | P3 品牌呈现 | 视觉自查（含小尺寸图标） |

每步结束执行：`git diff --check`、`bun test --isolate`、`cd apps/electron && bun run typecheck`。验证结果按「已跑 / 未跑」分别记录，不合并表述。

## 11. 风险与回滚

| 风险 | 对策 |
|---|---|
| 删除分支误删项目 | I2 + A6 单测 + code review 重点项 |
| 路径函数遗漏 | locator 收口；`grep -r "agent-workspaces"` 审计 |
| 旧版本读到 v4 索引 | 旧代码忽略未知字段；但旧 `deleteAgentWorkspace` 会删目录 → 回滚前先移除 project 条目 |
| watcher 事件风暴 | 只监听 `.profer`，跳过 sessions |
| 技能/预设路径假设 | A10 + 跨工作区引用测试 |
| 岗位引用悬空 | A14 诊断 + 白名单不剔除；UI 标注缺失项 |
| 密钥随 `.profer` 入库 | `*.local.json` 忽略 + 写入不回写 local + 明文密钥提示（I8） |
| 预设 schema 漂移 | I9 + A16；未知版本只读，未知字段 round-trip |
| 目录与单文件双轨分叉 | `PresetStore` 单一入口；A17 覆盖迁移；managed 仅单文件 |
| 品牌过度侵入 | 只写 `.profer`，不碰项目根其他文件 |

回滚步骤：

1. 关闭 `workspace.projectMode.enabled`；
2. 对所有 project 条目执行「移除」（只删索引，不碰磁盘）；
3. 旧版本可正常读取剩余 managed 条目。

## 12. 本轮不做

- 存量 managed → project 迁移；
- managed 工作区预设目录化（保持 `agent-presets.json` 单文件，本轮零变化）；
- 预设市场 / 岗位模板分发（只做仓库内岗位库）；
- 团队工作区绑定本地路径；
- git worktree 会话隔离；
- `profer init` CLI / 模板市场；
- checkpoint 清理与存储根迁移（独立立项）。
