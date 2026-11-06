# 项目会话数据自包含（Project Session Self-Contained）

> 日期：2026-11-04（GMT+8）
> 状态：已实现（v0.17.x）
> 关联：`2026-10-19-workspace-project-mode-design.md` §3 L4 的定向修订

## 1. 目标

project（有文件夹）工作区的会话数据随项目文件夹走：拷走、备份、换机器后重新绑定项目即可恢复。

纳入项目 `.profer` 的数据：

| 数据 | 位置 |
|---|---|
| 会话列表 | `<root>/.profer/sessions/index.json` |
| 消息 JSONL | `<root>/.profer/sessions/<sid>/messages.jsonl` |
| 任务图 | `<root>/.profer/sessions/<sid>/<sid>-graph.jsonl` |
| Pi Harness | `<root>/.profer/sessions/<sid>/<sid>-pi-harness.jsonl` |
| Pi transcript | `<root>/.profer/sessions/<sid>/pi/*.jsonl` |
| 绑定工作区的定时任务 | `<root>/.profer/automations.json` |
| 会话私有产物 | `<root>/.profer/sessions/<sid>/`（原有） |

managed（无文件夹）工作区完全不变：

- 消息：`~/.profer/agent-sessions/<sid>.jsonl`
- transcript：`~/.profer/sdk-config/sessions/pi/`
- 会话目录：`~/.profer/agent-workspaces/<slug>/<sid>/`

## 2. 权威源与副本

- **实时权威仍是全局索引**：`~/.profer/agent-sessions.json`、`~/.profer/automations.json` 保持单写者、原子写，跨项目列表/搜索/移动端不需要扫描磁盘。
- **项目内文件是可移植副本**：每次索引落盘后按工作区镜像；项目内条目参与启动对账。
- **对账规则**：同 ID 按 `updatedAt` 取新；项目条目的 `workspaceId` 归一到当前绑定的工作区 id。项目从另一台机器拷来、全局索引缺失时直接合并回来。
- **失败不阻断**：项目只读/离线时镜像失败只记日志，全局索引照常工作。

## 3. 布局解析

`packages/session-store` 新增会话布局注册表：

```ts
type SessionStorageLayout = { kind: 'project'; dataDir: string } | { kind: 'managed' }
```

- `sessionMessagesPath` / `sessionGraphPath` / `sessionHarnessPath` 按 `sessionId` 查表；未注册时回退 managed。
- `SessionMeta.storageLayout: 'project' | 'managed'` 是持久标记；历史会话缺省时按「项目内 messages.jsonl 是否存在」推断，升级不丢历史。
- Pi transcript 目录由 `getPiTranscriptDirForSession(sessionId)` 解析；`SessionManager.create(cwd, sessionDir)` 原生支持自定义目录。

## 4. 存量迁移

`migrateProjectSessionLayouts()`：

1. 只处理 `storageMode === 'project'` 且 `rootPath` 存在的项目；
2. 跳过运行中的会话；
3. 逐会话搬 messages / graph / harness / transcript（跨卷 rename 失败回退 copy+delete，目标已存在不覆盖）；
4. 写 `storageLayout: 'project'`、更新 `piSessionFile`；
5. 每个项目全部成功后写 `<root>/.profer/sessions/.layout-v2.json` 与 `profer.json#sessionLayout = 2`；
6. 迁移前备份全局 `agent-sessions.json` / `automations.json` 到 `~/.profer/.migration-backup/<timestamp>/`。

触发时机：启动后 3s 异步执行（随后再补齐 Pi transcript 路径）；打开/创建/重新定位项目后按项目异步执行。

回滚：`rollbackProjectSessionLayouts()` 把文件搬回中央、`storageLayout` 复位 `managed`、删除项目索引与迁移标记、`sessionLayout` 复位 1。

## 5. 定时任务

- 绑定 project 工作区的任务镜像到 `<root>/.profer/automations.json`（含 triggers）。
- 无工作区任务只留全局。
- 项目路径失效时调度器直接 `blocked`，不再尝试建会话。

## 6. 与备份/导出的关系

- **项目文件夹本身就是完整备份单元**：直接复制文件夹即可恢复。
- v2 导出允许显式选中 project 工作区，但只支持 `sessions` 组件：会话消息、任务图、Harness、transcript、项目会话索引会进入归档；项目 `.profer` 配置（profile/memory/skills/mcp/presets）随 git 版本化，不进入备份，避免跨项目覆盖。
- 导入仍拒绝 project 目标（配置搬运边界未变）；项目会话归档可在导入时恢复为 managed 布局，再由项目迁移回到项目内。

## 7. 风险与边界

| 风险 | 处理 |
|---|---|
| 旧版本打开新布局 | `profer.json#sessionLayout = 2` 标记；不支持降级，发布说明标注 |
| 项目离线/只读 | 镜像失败只记日志；调度任务 blocked；迁移跳过 |
| zip/网盘/共享盘带走对话 | `.profer/.gitignore` 排除 git，但压缩包仍会带上，需在 UI 提示 |
| blobs / checkpoints | 本期仍留中央（跨会话去重与体积考虑），后续单独评估 |
| 索引双写不一致 | 全局权威 + 项目副本按 updatedAt 对账；项目索引可删除重建 |

## 8. 测试

- `agent-session-manager.project-storage.test.ts`：两种布局的路径、迁移、历史兼容、Pi transcript 目录。
- `project-session-index.test.ts`：项目列表镜像、跨机器对账、跨项目迁移。
- `automation-project-mirror.test.ts`：任务镜像、无工作区隔离、对账、改绑。
- `project-session-layout-migration.test.ts`：迁移、运行中跳过、幂等、回滚。
