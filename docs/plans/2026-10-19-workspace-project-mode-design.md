# 工作区项目模式（Project Mode）设计

> 日期：2026-10-19（GMT+8），v2 修订 2026-11-03
> 状态：范围已确认；存量 managed 工作区保留为过渡态，本轮不做存量迁移；本文不含代码改动
> 范围：新增 project 模式——绑定真实项目文件夹，项目内 `.profer/` 承载配置与资产，Agent cwd 为项目根
> 非范围：存量工作区迁移、团队工作区云同步协议、Agent 并发 worktree、项目模板市场

> **2026-11-04 修订（会话自包含）**：§3 的 L4「会话数据永远留中央」已被
> `docs/plans/2026-11-04-project-session-self-contained.md` 修订。project 工作区的
> 消息 JSONL、会话列表、任务图、Harness、Pi transcript、绑定该工作区的定时任务
> 改为落在 `<root>/.profer/`；managed 工作区行为不变。全局索引与 automations 索引
> 保留为实时权威 + 跨项目视图，项目内文件是可移植副本与恢复来源。

## 1. 背景

当前 Profer 的「工作区」是纯应用内概念：

- 索引只有 `id / name / slug / type`，**没有路径字段**（`packages/shared/src/types/agent.ts`）；
- 目录固定为 `~/.profer/agent-workspaces/<slug>/`（开发版 `~/.profer-dev/`）；
- Agent 的 cwd 是 `~/.profer/agent-workspaces/<slug>/<sessionId>/`（`config-paths.ts#getAgentSessionWorkspacePath`）；
- 用户真实项目只能作为「附加目录」出现，靠绝对路径读写；
- 删除工作区会 `rm -rf` 整个目录（`agent-workspace-manager.ts#deleteAgentWorkspace`）。

这带来三个结构性问题：

1. **Agent 不在项目里工作**：相对路径、`git status`、构建命令都落在会话沙箱，用户项目是「外部目录」。
2. **配置不可携带**：profile、memory、skills、mcp、presets 都锁在 `~/.profer`，换机器、团队共享、随仓库版本化都做不到。
3. **「工作区」与「项目」语义分裂**：应用里叫项目，磁盘上是配置目录，用户无法用 Finder 直接对应。

目标形态对齐 Claude Code / Cursor：**一个真实文件夹 = 一个项目，项目内 `.profer/` 承载可协作配置，Agent 直接在该文件夹工作。**

## 2. 现状事实（改造前核对）

| 项 | 事实 | 代码位置 |
|---|---|---|
| 索引版本 | v3，字段 `id/name/slug/type/archived/...` | `agent-workspace-manager.ts` |
| 工作区根 | `~/.profer/agent-workspaces/<slug>/`，首次访问自动 mkdir | `config-paths.ts#getAgentWorkspacePath` |
| 会话 cwd | `<工作区根>/<sessionId>/`，有 parity 测试禁止退化为工作区根 | `agent-runtime-cwd-isolation.parity.test.ts` |
| 附加目录 | `collectAttachedDirectories` 聚合 session extraDirs / attached / 工作区根 / workspace-files | `agent-directory-utils.ts` |
| 文件监听 | 递归监听整个 `agent-workspaces/`，跳过 node_modules 等噪声目录 | `workspace-watcher.ts` |
| 删除 | 删除索引条目并 `rmSync` 工作区目录 | `agent-workspace-manager.ts` |
| 团队工作区 | `slug = team-<id>`，数据在云端，本地无项目概念 | `agent-workspaces.json` |
| 预设存储 | 每个工作区单文件 `agent-presets.json`，含 `presets[]` + `defaultPresetId` / `defaultPresetReference` / `disabledGlobalPresetIds` | `config-paths.ts#getWorkspaceAgentPresetsPath`、`agent-preset-manager.ts#readConfig` |
| 路径函数调用面 | `agent-workspace-manager.ts` 44 处、`migration-service.ts` 28 处，另有全局技能、IPC、桥接、预览等 | `grep getAgentWorkspacePath` |

`getAgentWorkspacePath(slug)` 是「slug 即路径」的隐式契约，这是本次改造真正的工程量所在。

## 3. 概念模型：拆成四层

| 层 | 定义 | 项目模式归属 |
|---|---|---|
| L1 项目 | 用户选定的真实文件夹（`rootPath`） | 用户磁盘，Profer 只记录路径 |
| L2 配置容器 | profile / memory / skills / mcp / presets / workspace-files | `<root>/.profer/` |
| L3 执行目录 | Agent 的 cwd 与相对路径基准 | `<root>`（项目根） |
| L4 会话数据 | 消息、checkpoint、附件、blobs、索引 | `~/.profer/`（中央，不随项目走） |

核心判断：**只有 L2 进项目，L4 永远留中央。** 理由：

- 会话数据体积大（单个工作区可到数百 MB），进项目会污染 git、拖慢 clone；
- 会话含隐私内容，不应默认随仓库共享；
- 会话索引需要跨项目检索，放项目内会退化成「每仓库一个孤岛」；
- L2 是「换机器就生效」的配置资产，才值得版本化。

## 4. 目录布局

### 4.1 项目模式

```text
/Users/mac/src/my-project/
├── .profer/
│   ├── profer.json             # 品牌锚点 + 项目清单（schema/name/createdAt）
│   ├── profile.md              # 项目资料（兼容读取旧名 workspace-profile.md）
│   ├── memory/
│   │   ├── MEMORY.md           # 索引
│   │   └── archive/            # 正文
│   ├── skills/                 # 项目级技能
│   ├── skills-inactive/        # 停用技能
│   ├── mcp.json                # 项目 MCP（提交；密钥写 ${env:VAR}）
│   ├── mcp.local.json          # 本机 MCP 密钥覆盖（gitignore，不提交）
│   ├── presets/                # 岗位库（提交，一个岗位一个文件）
│   │   ├── _config.json        # 默认预设引用、禁用清单、schema 版本
│   │   └── <preset-id>.json    # 单个用户预设（AgentPreset 实体）
│   ├── workspace-files/        # 调研、证据、产物
│   ├── sessions/               # 仅临时产物，默认 gitignore
│   ├── .gitignore
│   └── .lock                   # 多实例互斥（P2）
├── src/
└── package.json
```

预设是 v2 之后唯一改变存储形态的资产：单文件改为 `presets/` 目录（理由与读写规则见 §5.4）。项目内旧版 `agent-presets.json` 单文件仍可读，首次写入时拆分为目录布局（§5.4.1）。

### 4.2 中央目录（不变）

```text
~/.profer/
├── agent-workspaces.json       # 索引，新增 rootPath / storageMode
├── agent-sessions/             # 会话消息与元数据
├── agent-checkpoints/          # Pi checkpoint
├── blobs/  attachments/        # 附件与二进制
├── global-skills/              # 全局技能（跨项目）
├── channels.json  auth-tokens.enc
└── agent-workspaces/<slug>/    # 仅 managed 模式仍使用
```

### 4.3 默认 `.profer/.gitignore`

```gitignore
sessions/
cache/
workspace-files/
*.local.json
.lock
```

`workspace-files/`（调研、证据、产物）默认忽略，避免截图、导出、临时产物污染仓库；需要随项目共享时用 `git add -f` 显式加入。`profile.md`、`memory/` 默认**不**忽略，但首次生成时提示用户：不要写入凭据、token、过于私人的信息。`mcp.json` 只放可提交配置，密钥写 `${env:VAR}`；本机密钥放 `mcp.local.json`，已被 `*.local.json` 覆盖（§5.5.2）。`presets/` 与 `_config.json` 默认提交，岗位库是团队资产。

开发版与正式版共用项目内 `.profer`，不按 `.profer-dev` 分裂，避免同一项目出现两份配置。

## 5. 数据模型

### 5.1 类型变更

```ts
export type WorkspaceStorageMode = 'managed' | 'project'

export interface AgentWorkspace {
  // ...现有字段保持不变
  /** 项目模式：用户项目根绝对路径；managed 模式不落盘 */
  rootPath?: string
  /** 缺省视为 managed，保证旧数据零迁移 */
  storageMode?: WorkspaceStorageMode
}
```

### 5.2 索引 v3 → v4

- 为所有存量工作区补 `storageMode: 'managed'`（幂等）。
- `rootPath` 不做批量补写。
- 新增唯一性约束：同一 `rootPath`（`realpath` 归一化、大小写按平台处理）只允许一个工作区。
- 索引写入前校验：`project` 模式必须有 `rootPath`；`managed` 模式不得有 `rootPath`。

### 5.3 语义约束

- `slug` 继续存在，但**不再是路径来源**，只作为内部稳定 ID / 兼容键。
- `name` 可与文件夹名不同，允许用户重命名显示名。
- `rootPath` 一旦绑定不可静默变更；改路径必须走「重新定位」显式操作。

### 5.4 预设存储：`presets/` 目录（岗位库）

预设 = 岗位 + 工作环境（提示词段、能力集、推理档位、权限模式、Skill / MCP 子集），所以项目模式下的 `presets/` 在产品上叫「岗位库」。v2 原计划用单个 `presets.json`；本次修订（并入预设系统）改为目录：一个岗位一个文件，便于 code review、diff 和单条回滚。

| 路径 | 内容 | 是否提交 |
|---|---|---|
| `.profer/presets/_config.json` | 工作区级开关：`schema`、`defaultPresetReference`、`defaultPresetExplicitlyCleared`、`disabledGlobalPresetIds`、`disabledWorkspacePresetIds`、`migrationDiagnostics` | 是 |
| `.profer/presets/<presetId>.json` | 单个用户预设（`AgentPreset` 实体），文件名 = 稳定 ID | 是 |
| `.profer/agent-presets.json` | 旧版单文件，仅兼容读取；新写入不再生成 | 遗留（目录存在时忽略，建议迁移后删除） |
| `~/.profer/agent-presets.json` | 用户全局预设，仍在中央，不进项目 | — |
| `~/.profer/agent-workspaces/<slug>/agent-presets.json` | managed 工作区预设，本轮保持单文件不变 | — |

`_config.json` 示例：

```json
{
  "schema": "profer.presets/1",
  "defaultPresetReference": { "presetId": "0b6f1f0e-...", "presetScope": "workspace" },
  "defaultPresetExplicitlyCleared": false,
  "disabledGlobalPresetIds": ["global-release"],
  "disabledWorkspacePresetIds": []
}
```

单预设文件示例：

```json
{
  "schema": "profer.preset/1",
  "id": "0b6f1f0e-...",
  "name": "代码审查",
  "description": "只读审查，禁止写文件",
  "version": "1.0.0",
  "promptSections": ["你是代码审查岗位……"],
  "disabledToolGroups": ["task-graph"],
  "skillSlugs": ["code-review"],
  "mcpServerNames": ["github"],
  "createdAt": 1762000000000,
  "updatedAt": 1762000000000
}
```

规则：

1. **不落盘 `scope` / `workspaceSlug` / `enabledInWorkspace`**：这些是「当前工作区」的派生状态，写进文件会让项目 clone 到另一台机器后引用失效。读取时由 manager 补齐为 `workspace` + 当前 slug。
2. **内置预设不落盘**：`standard` / `code` / `minimal` 以源码为准，`presets/` 只放用户自定义岗位，不允许出现 `standard.json`。
3. **`defaultPresetReference` 不写 `workspaceSlug`**：workspace 作用域引用在项目内省略 slug，读取时注入当前工作区；若文件带有其他 slug（跨机器 clone 残留），按「可重绑定引用」处理并记诊断，不静默丢弃。
4. **文件名 = `presetId`**：重命名岗位只改文件内 `name`，不移动文件；避开大小写、空格与中文文件名在 Windows / macOS 上的差异。UI 展示名永远取 `name`。
5. **原子写 + 目录级锁**：`_config.json` 与单预设文件分别 `writeJsonFileAtomic`，写入前取 `.profer/.lock`；删除预设 = 删文件 + 清理 `_config.json` 引用，默认预设指向被删岗位时回退并记诊断。
6. **managed 不变**：managed 工作区继续用 `agent-presets.json` 单文件，本轮不改布局；manager 内部抽 `PresetStore` 读写接口，两种布局共用同一套 CRUD 语义与错误码。

#### 5.4.1 旧单文件兼容与迁移

- 读取优先级：`presets/` 目录存在 → 只读目录，**忽略**遗留 `agent-presets.json`（避免两份数据合并出幽灵预设），并在诊断中提示「存在遗留单文件」；`presets/` 不存在且 `agent-presets.json` 存在 → 按旧结构读取，行为与当前 managed 一致。
- 首次写入（改预设 / 改默认 / 改禁用清单）时执行拆分：写 `presets/_config.json` + 每个预设一个文件，**不删除**旧文件；旧文件保留供人工核对，UI 提示可删除。
- 拆分后旧文件不再被读取；若用户手动恢复旧文件而目录已存在，仍以目录为准。
- v2 草案里的 `presets.json` 文件名从未发布，不做兼容。

### 5.5 预设相关三条硬约束

#### 5.5.1 引用一致性：`skillSlugs` / `mcpServerNames` 缺失不静默

预设通过 `skillSlugs`、`mcpServerNames` 白名单裁剪运行时能力。岗位库随 git 走，但被引用的全局技能与本机 MCP 不一定随仓库走，clone 后必然出现「引用悬空」。

- 加载时逐项解析引用，产出结构化诊断 `PresetReferenceDiagnostic`：
  - `missing-skill`：白名单 slug 在项目 `skills/` 与全局 `global-skills/` 中都不存在；
  - `missing-mcp`：白名单 server 在合并后的 MCP 配置中不存在；
  - `unavailable-mcp`：server 存在但缺必需 env 变量或被停用；
  - `local-only-mcp`：server 只来自 `mcp.local.json`，跨机器不可复现；
  - `stale-workspace-reference`：`defaultPresetReference` 的 slug 与当前工作区不一致。
- **禁止静默剔除**：读取、保存、导出任何环节都不得把缺失项从白名单里删掉——一旦删掉，用户下次保存就把原始引用永久丢失。缺失项保留在文件中，只在 UI 标注（预设卡片角标 + 详情列出缺失清单）。
- 只有用户显式操作（「移除失效引用」/「改绑」）才修改白名单；批量修复入口必须展示变更 diff。
- 默认预设引用解析失败时不静默回退 `standard`：记录诊断、UI 提示「默认岗位不可用」，运行时按既有 `PRESET_NOT_FOUND` / `PRESET_UNKNOWN_REFERENCE` 错误码抛出，并允许一键改绑。
- 与现有枚举清洗的边界：`disabledTools` / `suppressPromptSections` / `disabledToolGroups` 是封闭枚举，未知值无意义，可继续静默剔除；`skillSlugs` / `mcpServerNames` 是跨文件引用，剔除会丢数据，必须走诊断。这条区分写进代码注释与测试。

#### 5.5.2 `mcp.local.json`：密钥与可提交配置分离

- `.profer/mcp.json` 进版本控制，只放服务器定义与非敏感配置；密钥一律写 `${env:VAR}` 引用。
- `.profer/mcp.local.json` 是本机覆盖层，命中 `.gitignore` 的 `*.local.json`，**永不提交**；存放明文 token、本机路径、个人 header。
- 合并规则：按 server name 深度合并，local 覆盖 base；local 允许新增 server，但该 server 标记 `local-only`，预设白名单引用它时给出 `local-only-mcp` 诊断。
- **单向合并**：读取时 base ← local；写入时只写 `mcp.json`，任何情况下不把 local 内容回写进 `mcp.json`，防止密钥被顺手提交。
- 保存 `mcp.json` 时检测疑似明文密钥（长随机串、`sk-`、`ghp_`、`xoxb-` 等前缀）→ 提示迁移到 local 或 env，不自动改写。
- 首次创建项目骨架只生成 `mcp.json`，不生成 `mcp.local.json`；后者在用户首次填写本机密钥时创建。

#### 5.5.3 预设 schema 版本兼容

- 目录布局带两级 schema：`presets/_config.json` 为 `profer.presets/1`，单预设文件为 `profer.preset/1`。
- 主版本相同 → 正常读写；主版本更高（不认识的 `/2`）→ 该项目预设**只读打开**：可查看、可选用、禁止保存与迁移，提示升级 Profer，不自动改写。
- 未知字段必须原样保留（读入 → 写回 round-trip），避免旧版本 Profer 打开新项目后抹掉新字段。
- 旧单文件无 `schema` 字段 → 视为 `profer.presets/0` 兼容读，首次写入升级为 `/1`。
- 单个 `<presetId>.json` 解析失败或字段非法 → 该预设标记 `invalid-file` 诊断并跳过，其他预设照常加载；不因一个坏文件丢弃整库。
- `preset.version`（实体版本，如 `1.4.0`）与 schema 版本是两件事：前者标识岗位内容演进，后者标识文件格式；除「是否可读」外都不触发自动改写。

## 6. 路径解析契约

新增纯模块 `apps/electron/src/main/lib/workspace-locator.ts`：

```ts
export interface WorkspaceLocation {
  /** L2 配置容器：managed = ~/.profer/agent-workspaces/<slug>，project = <root>/.profer */
  configDir: string
  /** L3 执行根：managed = configDir，project = rootPath */
  rootPath: string
  mode: WorkspaceStorageMode
}

export function resolveWorkspaceLocation(slug: string): WorkspaceLocation
export function invalidateWorkspaceLocation(slug?: string): void
```

设计要点：

1. **locator 自己读索引**，只依赖 `getConfigDir()`，不依赖 `agent-workspace-manager`，避免循环依赖。
2. 进程内缓存 `slug → location`，工作区增删改时由 manager 调用 `invalidate`。
3. `config-paths.ts` 的 workspace 级函数（`getWorkspaceMcpPath`、`getWorkspaceMcpLocalPath`、`getWorkspaceSkillsDir`、`getInactiveSkillsDir`、`getWorkspacePresetsDir`、`getWorkspacePresetsConfigPath`、`getWorkspaceAgentPresetsPath`、`getWorkspaceFilesDir`、profile/memory 路径）内部改为走 locator，**对外签名保持 `(slug)` 不变**。
4. `getAgentWorkspacePath(slug)` 保留，语义改为 `configDir`；新增 `getWorkspaceRootPath(slug)` 返回 L3 根。
5. mkdir 副作用只允许作用于 `configDir`；`rootPath` 不存在时**绝不自动创建**，抛 `WorkspaceRootMissingError`。

预设是唯一有「文件 → 目录」形态变化的资产，路径契约需分开表达：

| 函数 | managed 返回 | project 返回 |
|---|---|---|
| `getWorkspaceAgentPresetsPath(slug)` | `<configDir>/agent-presets.json`（保持现状） | `<configDir>/agent-presets.json`（旧文件，仅兼容读） |
| `getWorkspacePresetsDir(slug)` | 不适用（单文件布局，返回 `null`） | `<configDir>/presets` |
| `getWorkspacePresetsConfigPath(slug)` | `<configDir>/agent-presets.json`（单文件即配置） | `<configDir>/presets/_config.json` |
| `getWorkspaceMcpLocalPath(slug)` | `<configDir>/mcp.local.json` | `<configDir>/mcp.local.json` |

调用方不得假设 `getWorkspaceAgentPresetsPath` 是唯一存储：预设读写统一经 `PresetStore`（按 `storageMode` 选目录或单文件），路径函数只用于定位与迁移。

这一层做完，90% 调用点无需修改；只有需要「项目根语义」的地方显式改用 `getWorkspaceRootPath`。

## 7. 执行目录（cwd）语义

### 7.1 规则

| 模式 | 会话 cwd | 说明 |
|---|---|---|
| `project` | `rootPath` | 与 Claude Code 一致，相对路径直接落在项目 |
| `managed` | `<configDir>/<sessionId>` | 维持现状，parity 测试继续生效 |
| 无工作区 | 用户主目录 | 维持现状 |

### 7.2 为什么不保留会话子目录

会话子目录隔离解决的是「并发会话互相踩文件」。但代价是 Agent 永远不在项目根，`./report.md` 不进项目，`git status` 看到的不是用户仓库。对「在项目里干活」的产品目标，这个代价不可接受。

并发改为分层兜底：

1. **第一阶段**：同项目多会话共享 cwd，靠用户/Agent 自觉与 git 分支持续兜底；会话之间的临时文件约定写到 `.profer/sessions/<sessionId>/`。
2. **第二阶段（P4）**：引入 git worktree 隔离，每个会话可选独立 worktree，彻底消除写冲突。

### 7.3 parity 测试的处置

`agent-runtime-cwd-isolation.parity.test.ts` 不能删除，改为按 `storageMode` 分叉断言：

- `managed`：cwd 必须等于 `<configDir>/<sessionId>`，禁止退化为 configDir；
- `project`：cwd 必须等于 `rootPath`，且同一项目两个会话 cwd 相同（这是**预期行为**，需显式断言，防止未来误改回子目录）。

### 7.4 checkpoint 与临时产物

- Pi checkpoint 保持在中央 `~/.profer/agent-checkpoints/`，按 sessionId 隔离，不进项目。
- 项目模式不再把会话目录当作工作台；`sessions/<id>/` 仅存放用户显式要求「放在项目内的临时产物」，默认 gitignore。
- 现有 managed 会话的历史目录原样保留，不做搬迁。

## 8. 完整生命周期

### 8.1 创建项目模式工作区

1. 用户选择文件夹（系统目录选择器，复用现有授权目录入口）。
2. 校验：存在、是目录、可读写、不是文件系统根、不在 `~/.profer` / `~/.profer-dev` 内、不是已有工作区的 `rootPath`。
3. 若 `<root>/.profer` 已存在 → 走「打开已有项目」而非覆盖。
4. 生成 `.profer` 骨架：`profer.json`、`profile.md`、`memory/MEMORY.md`、`skills/`、`skills-inactive/`、`mcp.json`（`{ "mcpServers": {} }`）、`presets/_config.json`（`profer.presets/1` 空结构，不预生成任何岗位文件）、`workspace-files/`、`.gitignore`。
5. 写索引（`storageMode: 'project'`，`rootPath` 为 `realpath` 结果）。
6. 失败回滚：只清理本次新建的 `.profer` 内文件，**绝不删除项目内其他内容**。

### 8.2 打开已有项目

识别 `<root>/.profer` 是否存在，存在即复用配置；缺失的条目按骨架补齐，已存在的文件不覆盖。UI 标注「已识别 Profer 配置」。

### 8.3 绑定（managed → project）——本轮暂缓

> v2 决定：存量工作区保持 managed，不提供迁移入口。本节保留为后续独立立项的设计参考。

1. 用户选择目标文件夹。
2. 预检：目标 `.profer` 是否已有内容；有冲突则列出清单，要求选择「合并 / 取消」。
3. 复制配置资产（profile、memory、skills、skills-inactive、mcp.json、presets、workspace-files），**不复制会话数据**；presets 若为旧单文件，按 §5.4.1 拆分为 `presets/` 目录，`defaultPresetReference` 读取时按当前工作区解析（文件内不落盘 slug）。
4. 原 `~/.profer/agent-workspaces/<slug>/` 重命名为 `<slug>.migrated-<ts>` 作为回滚备份，不立即删除。
5. 索引切换 `storageMode` 与 `rootPath`；会话历史仍指向原 workspaceId，不受影响。

### 8.4 移除与删除

| 操作 | 行为 |
|---|---|
| 从 Profer 移除（project） | 仅删索引条目；项目文件与 `.profer` 全部保留；可随时重新打开 |
| 删除 `.profer` 配置 | 独立操作，二次确认，校验路径必须位于项目根内；默认保留 `profile.md` 与 `memory/`，需勾选才删 |
| 删除工作区（managed） | 维持现状：删索引 + 删目录 |
| 归档 / 收纳 | 两种模式一致，只改索引状态，不动磁盘 |

硬性红线：**项目模式下任何路径都不能出现对 `rootPath` 本身的递归删除。** 删除函数需按 `storageMode` 分支，并有单测断言项目内文件在移除后仍存在。

### 8.5 路径失效

- 启动时与打开工作区时 `stat(rootPath)`。
- 失效状态不落盘为破坏性字段，UI 显示「项目路径不可用」并提供「重新定位 / 从列表移除」。
- 失效期间禁止在该工作区新建会话，避免在错误路径重建目录。

## 9. 文件监听与文件浏览器

- 项目模式只监听 `<root>/.profer`（递归，跳过 `sessions/`），不再递归监听整个项目源码树。
- 项目源码变化交给现有 git diff / 预览链路，不进入 `WORKSPACE_FILES_CHANGED` 事件流。
- `workspace-watcher.ts` 的根目录 watcher 需要支持「多根」：`agent-workspaces/`（managed）+ 每个 project 的 `.profer`。
- 文件浏览器默认根从 configDir 改为 rootPath，`.profer` 作为可展开节点；仍遵守现有路径越界校验。

## 10. 权限与提示词

### 10.1 授权目录

- `collectAttachedDirectories` 在 project 模式下加入 `rootPath`，不再重复加入 configDir（它已在 rootPath 内）。
- 敏感文件规则不变：`.env`、`.git/config`、凭据文件仍按现有策略处理，不因 cwd 变化放开。
- 预览与附件路径校验继续使用 `realpath`，防止符号链接越界。

### 10.2 提示词

- 工作区路径声明改为 `rootPath`，并明确「当前目录即项目根」。
- 移除「工作区根 vs 会话目录」的双路径说明，减少 Agent 误判。
- `projectCandidates` 探测在 project 模式下直接使用 rootPath，不再从附加目录反推。

## 11. 迁移与兼容

> v2 决定：本轮不做存量迁移。managed 是长期保留的过渡态，不是待清理的技术债。

| 场景 | 策略 |
|---|---|
| 存量个人工作区 | 保持 managed，索引补字段，零文件移动 |
| 存量团队工作区 | 固定 managed，不参与本轮；云同步模型未定义 rootPath 冲突 |
| 存量会话 | 不动；managed 会话 cwd 规则不变 |
| 新工作区 | 默认 project（功能开关打开后）；开关关闭时仍可建 managed |
| 跨设备 | `.profer` 随 git 走，另一台机器「打开项目」即复用配置（含岗位库）；会话历史不跟随 |
| 预设布局 | 项目模式用 `presets/` 目录；managed 保持 `agent-presets.json` 单文件；项目内旧单文件首次写入时拆分，旧文件保留不删 |
| 回滚 | 关闭开关 + 忽略 `storageMode` 即回到旧行为；已绑定的项目需手动移除索引后重建 |

功能开关：`workspace.projectMode.enabled`，默认关闭，P1 验收通过后打开。开关只影响新建入口与 cwd 解析，不影响已存在数据。

## 12. 分期与验收

> v2 工期：P0–P2 合计 **6–8 个工作日**；P3 只保留 UI 与品牌呈现，迁移向导取消。

### P0 契约与路径收口（2 天）

- 类型字段、索引 v4、`workspace-locator`、`config-paths` 内部切换、`invalidate` 接线。
- 不改任何行为，不改 UI。
- 验收：全量测试通过；存量工作区路径、技能、预设、会话 cwd 与改造前逐项一致。

### P1 项目模式核心（2–3 天）

- 创建 / 打开 / 绑定 / 移除、cwd 切换、删除语义、rootMissing。
- 验收：
  1. 新建项目会话 `pwd` 返回项目根；
  2. managed 会话 cwd 不变；
  3. 移除工作区后项目文件与 `.profer` 均存在；
  4. 同一文件夹不能重复绑定；
  5. 路径被移动后 UI 显示失效且不重建目录。

### P2 配置资产与监听（3–4 天）

- profile / memory / skills / mcp / presets / workspace-files 读写全部走 `.profer`；watcher 多根；文件浏览器。
- 预设改目录布局：`PresetStore` 抽象、`presets/_config.json`、旧单文件兼容与拆分、引用一致性诊断、`mcp.local.json` 合并、schema 版本闸门。
- 验收：
  1. 项目内技能、预设、MCP 生效且重启后保持；
  2. `.profer` 外文件不触发工作区事件；
  3. 多实例锁生效；
  4. **clone 恢复岗位**：新机器 `git clone` 后打开项目，`presets/` 内全部岗位可见、默认岗位生效、`skillSlugs` / `mcpServerNames` 缺失项有明确提示且未被自动剔除；
  5. `mcp.local.json` 内容不进入 git，也不被回写进 `mcp.json`。

### P3 UI 与品牌呈现（2 天）

- 项目切换器显示路径与 `.profer` 徽标、失效提示、首次创建隐私提示、空状态文案。
- 不包含绑定迁移向导（v2 暂缓）。

### P4 并发与团队（独立评估）

- git worktree 会话隔离；团队工作区的 rootPath 模型与同步协议。

合计 P0–P3 约 **6–8 个工作日**（单人，含回归），不含 P4。

## 13. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 删除语义写错 | 删掉用户代码 | 按模式分支 + 单测断言；项目模式禁止递归删除 rootPath |
| cwd 隔离回归 | remote/automation 会话串线 | parity 测试按模式分叉，保留 managed 断言 |
| 路径函数遗漏 | 部分功能仍写中央目录 | locator 统一收口；grep 审计 `agent-workspaces` 硬编码 |
| watcher 事件风暴 | CPU 飙高、IPC 刷屏 | 只 watch `.profer`，跳过 sessions 与噪声目录 |
| skills/presets slug 假定 | 项目模式找不到技能 / 岗位引用悬空 | 路径全部走 locator；预设引用走一致性诊断（§5.5.1），缺失不静默剔除 |
| 岗位库跨机器失效 | clone 后预设白名单指向不存在的技能 / MCP | 诊断 + UI 标注；`mcp.local.json` 与 `${env:VAR}` 分离密钥 |
| `.profer` 进 git 泄露 | 隐私与密钥 | 默认 gitignore 敏感子目录；首次创建提示；`${env:VAR}` 支持 |
| Windows 路径差异 | 大小写、长路径、符号链接 | `realpath` 归一化；路径比较按平台处理；CI 覆盖 win32 单测 |
| 多实例同时打开 | 配置写冲突 | `.profer/.lock` + 写入前校验（P2） |

## 14. 待决问题

1. **项目名与文件夹名**：默认取文件夹名，允许改显示名；是否允许同名不同路径并存？（建议允许，UI 显示路径区分）
2. **monorepo 子目录**：rootPath 允许指向子目录，`.profer` 建在子目录；是否需要「向上查找已有 .profer」？（建议 P3 再加）
3. **团队工作区**：是否长期保持 managed，还是未来也绑定本地 clone？（建议保持 managed，等同步协议单独立项）
4. **会话临时产物**：`.profer/sessions/` 是否保留，还是全部走系统临时目录？（建议保留，便于用户找回）
5. **默认模式**：开关打开后，新建默认 project 还是让用户每次选择？（建议首次引导选择，之后记住偏好）

## 15. 品牌化：让 `.profer` 成为可识别的项目格式

目标不是「加一个隐藏目录」，而是让用户、团队和外部工具看到 `.profer` 就知道这是 Profer 项目，并且能安全地提交、共享、复用。

### 15.1 三层品牌锚点

| 层 | 载体 | 作用 |
|---|---|---|
| 目录 | `.profer/` | 固定名，开发版与正式版一致，不随配置根变化 |
| 机器可读 | `profer.json` | 格式标识、schema 版本、创建信息 |
| 人可读 | `profile.md` | 项目背景与工作方式，Agent 直接读取 |

### 15.2 `profer.json` schema

```json
{
  "schema": "profer.project/1",
  "name": "my-project",
  "createdAt": "2026-11-03T00:00:00.000Z",
  "proferVersion": "0.16.17"
}
```

规则：

- 只写格式元数据，**不写绝对路径**，项目移动后仍有效；
- 不写用户名、机器名、账号标识，避免隐私泄露；
- 遇到不认识的 `schema` 版本时以只读方式打开，提示升级 Profer，不自动改写；
- 缺失 `profer.json` 但存在 `.profer/` 时，视为旧格式并补写，不覆盖其他文件。

### 15.3 命名规范

- 目录与文件名统一小写：`.profer`、`profile.md`、`presets/`、`_config.json`、`mcp.json`；
- `presets/` 下一个岗位一个文件，文件名用稳定 ID（`<presetId>.json`），展示名写在文件内 `name`；
- 新项目写新名，读取兼容旧名：`profile.md` ← `workspace-profile.md`，`presets/` ← `agent-presets.json`（单文件，首次写入时拆分，见 §5.4.1）；
- **不生成** `AGENTS.md`、`CLAUDE.md`、`.cursor/` 等第三方文件，避免品牌越界和用户资产冲突。

### 15.4 岗位库：clone 即恢复

`.profer/presets/` 是项目里的**岗位库**：团队把「代码审查」「发布」「文档」这些岗位连同提示词、工具裁剪、Skill / MCP 子集一起提交，review 岗位变更和 review 代码走同一条 PR 流程。

- **clone 即恢复**：`git clone` → 「打开已有项目」→ `presets/*.json` 自动成为工作区预设，`_config.json` 的 `defaultPresetReference` 自动指向当前工作区（文件内不存 slug），不需要导入、不需要手工重建。
- **岗位与技能分工**：`skills/` 是操作手册（怎么做），`presets/` 是岗位（谁来做、能用什么工具、默认什么权限）。岗位通过 `skillSlugs` / `mcpServerNames` 引用技能与 MCP，所以 clone 后必须有引用一致性提示（§5.5.1），否则会出现「岗位在、能力没了」的静默降级。
- **可审查的粒度**：一个岗位一个文件，PR diff 只显示被改的那个岗位，不会因为新增一个岗位把整个 `presets.json` 刷成一大块。
- **品牌话术**：「这个仓库带了 4 个 Profer 岗位」比「有预设配置」更能说明 `.profer` 的价值；项目切换器与设置页统一用「岗位库」指代 `presets/`，UI 里「预设」仍作为技术名保留。
- **边界**：内置三预设不写入文件；不写 `workspaceSlug`、绝对路径、用户名；单个岗位文件损坏只影响该岗位，不影响整个岗位库。

### 15.5 产品呈现

- 项目切换器：项目名 + 路径副标题 + `.profer` 徽标；
- 打开已有 `.profer` 的项目：提示「已识别 Profer 项目」，而不是「新建」；
- 文件树：`.profer` 使用品牌图标，可一键在 Finder / 资源管理器中显示；
- 设置页增加「项目格式」说明，列出哪些文件建议提交、哪些默认忽略；
- 官网文档增加 `project-format` 页，作为团队共享与外部工具接入的公开契约。

### 15.6 品牌边界（明确不做）

- 不在项目根写入任何非 `.profer` 文件；
- 不把会话、checkpoint、缓存写进项目；
- 不强制 `git init`，不修改用户现有 `.gitignore`；
- 用户删除 `.profer` 后项目仍可正常打开，降级为「无配置项目」，不报错、不重建。

### 15.7 生态钩子（P4）

- `profer init`：在任意目录初始化 `.profer`（命令面板或 CLI）；
- 团队模板：把 `.profer` 作为可提交的团队配置单元；
- 导出/导入 `.profer` 包，用于跨机器复用。

## 16. 一句话结论

这次改造的本质不是「加一个 `.profer` 文件夹」，而是把「工作区」从**应用内沙箱**改造成**项目的一个视图**。只要守住两条边界——L2 配置进项目、L4 会话留中央，以及一条红线——项目模式下永不删除项目目录，工程量可控制在两周内，且可以按 P0→P3 逐段验收、随时回滚。
