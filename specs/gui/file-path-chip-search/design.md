# 文件路径 Chip 搜索与候选选择 — 设计文档

> 最后更新: 2026-08-18

## 架构概览

搜索由主进程服务执行，renderer 只通过 IPC 发起、取消和接收候选结果。搜索服务按“当前会话 cwd → 工作区文件目录 → 会话附加目录/附加文件父目录”的授权根目录构造搜索范围，不调用现有跨工作区全局 fallback。

每个 chip 在 renderer 维护候选列表、当前选中路径、搜索状态和搜索游标。首次 chip 点击复用一次简单搜索并在命中后打开；搜索按钮点击继续取下一个候选；长按搜索按钮使用更深的扫描深度。所有搜索使用异步/可取消的主进程任务，结果按规范化绝对路径去重。

附加目录根行的直接叉按钮移入 DropdownMenu 的更多操作菜单，复用现有目录树的 detach 回调，不删除磁盘内容。

## 文件变更范围

- `apps/electron/src/main/lib/file-search-service.ts`：新增受授权根目录约束的异步、可取消、逐个候选搜索服务。
- `apps/electron/src/main/lib/file-search-service.test.ts`：覆盖浅层/深度搜索、去重、取消、根目录边界。
- `apps/electron/src/main/ipc.ts`：新增文件候选搜索与取消 IPC handler；从 session/workspace 元数据组装授权根目录。
- `apps/electron/src/preload/index.ts`：暴露搜索/取消 API 和类型。
- `packages/shared/src/types/runtime.ts`：增加搜索请求、候选、状态相关共享类型（如项目现有类型结构需要）。
- `apps/electron/src/renderer/components/ai-elements/file-path-chip.tsx`：拆分 chip 与搜索按钮，管理候选、选中路径、首次点击、长按、取消、右键候选菜单和 spinner。
- `apps/electron/src/renderer/components/ai-elements/file-path-chip.test.ts`：覆盖搜索状态纯逻辑/候选去重/单文件名与完整路径显示。
- `apps/electron/src/renderer/components/agent/SidePanel.tsx`：附加目录根行去掉直接叉按钮，更多菜单加入“移除附加”。
- `apps/electron/src/renderer/components/agent/SidePanel.test.tsx`（若当前测试基础设施适合组件测试）：覆盖菜单入口；否则用纯函数/渲染 smoke 测试覆盖。

## 1. 搜索服务

### 接口

```ts
interface FileSearchRequest {
  requestId: string
  sessionId: string
  targetName: string
  roots: string[]
  maxDepth: number
  excludedPaths?: string[]
  alreadyFound: string[]
}

interface FileSearchCandidate {
  path: string
  relativePath?: string
}

interface FileSearchResult {
  requestId: string
  candidate?: FileSearchCandidate
  done: boolean
  cancelled: boolean
  error?: string
}
```

实际接口优先复用现有 IPC 类型和事件模式；以上字段表达行为契约，不要求逐字实现。

### 搜索策略

- `simple` 使用较浅深度；`deep` 使用更深但有上限的深度。
- 每次请求最多返回一个未出现在 `alreadyFound` 的候选。
- 遍历目录使用异步 API，分批让出事件循环；禁止在 renderer 或 IPC handler 中执行长时间同步递归。
- 跳过 `.git`、`node_modules`、`dist`、构建缓存等高噪声目录。
- 每个请求持有 AbortController；取消后停止后续扫描和结果提交。
- 根目录在主进程重新根据 sessionId 校验/构造，不能信任 renderer 单独提交的任意路径。
- 并发搜索限制在每个 session/chip 一个 in-flight 任务，避免重复扫描。

## 2. IPC 与 preload

- `file:search-candidate`：启动一次 simple/deep 搜索，返回 requestId 或候选结果流事件。
- `file:cancel-search`：按 requestId 取消搜索。
- 结果事件包含 requestId，renderer 只接受当前 requestId 的结果，防止旧任务覆盖新状态。
- 失败、取消、无更多候选都返回终态，保证 spinner 必然关闭。
- 现有 `file:resolve-path` 和预览 IPC 保持兼容；候选选中后沿用现有 `openPreview`。

## 3. Chip 交互

### 显示

默认显示带图标的单文件名 chip，右键 chip 本体在单文件名与完整路径两种 chip 文本之间切换。搜索按钮作为 chip trailing control，使用搜索图标；搜索中显示可点击的 Loader2，点击立即取消。

### 交互状态

```text
unsearched + click chip -> simple search -> candidate -> select + open preview
unsearched + click search -> simple search -> candidate -> select, no preview
searched + click chip -> open selected candidate
search button click -> next simple candidate
search button long press -> next deep candidate
searching + click spinner -> cancel -> idle
search button right click -> candidate menu -> select path
```

- 候选按绝对路径去重并保留发现顺序。
- 选择菜单展示完整路径；选中路径改变当前预览目标和 chip 的悬停真实路径。
- 没有候选时菜单显示空状态；没有更多候选时搜索按钮保持可用但给出无更多结果反馈。
- 长按计时参考 `ContextUsageBadge` 的 `LONG_PRESS_DURATION`，使用其一半；应抽取共享常量或保持明确同步，避免复制魔数。
- 防止长按触发后又触发 click；pointerup/cancel/unmount 清理 timer。

## 4. 附加目录菜单

`AttachedDirTree` 根行从直接 `Button(X)` 改为 `DropdownMenu` 的 `MoreHorizontal` 按钮。菜单至少提供：

- 在文件夹中显示（若当前目录已有该操作能力）
- 添加到聊天（若回调存在）
- 移除附加（调用现有 `onDetach`，不删除物理目录）

菜单行为与附加文件的更多操作一致，根行点击展开目录不受影响。

## 5. 数据流与取消

```text
chip/search button
  -> renderer start request
  -> main validates session roots
  -> async scanner yields one candidate
  -> IPC result(requestId)
  -> renderer append candidate + select if needed
  -> spinner off / open preview if first chip click
```

取消路径：`spinner click -> cancel IPC -> AbortController.abort -> terminal cancelled -> renderer clears inFlight`。即使取消响应和候选结果竞态到达，renderer 也检查 requestId、取消标记和候选去重后再更新。

## 接口兼容性与风险

- 现有预览路径解析 API 不删除、不改变返回含义。
- 现有 chip 的绝对/相对路径识别和 Windows 分隔符处理保留。
- 搜索范围由主进程授权根目录决定，不能因搜索功能扩大访问权限。
- 搜索服务若不可用，chip 仍可沿现有预览解析路径降级；UI 显示搜索失败，不阻塞打开流程。
- 组件改动较大，需先补纯逻辑测试，再做 dev Electron 手动验证：首次点击、逐次候选、长按、取消、右键选择、同名文件和附加目录菜单。

> 设计实现如与现有 IPC/组件约定冲突，以项目类型定义和安全授权链路为准，并在实现后回写本设计文档。
