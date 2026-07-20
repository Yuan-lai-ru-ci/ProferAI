# 论文知识库 paperpipe 集成 — 状态交接

## 2026-07-19 更新：论文知识库前端工作台已实现（待运行时验收）

本次新增的工作台改动只涉及以下文件：

- `packages/shared/src/types/knowledge-base.ts`：新增设备本地的 `PaperWorkbenchRecord`、`KnowledgeBaseWorkbenchState`、patch 类型和 3 个 IPC 通道。
- `apps/electron/src/main/lib/config-paths.ts`：新增 `~/.profer[-dev]/knowledge-base-workbench.json` 路径。
- `apps/electron/src/main/lib/kb-workbench-service.ts`：新增崩溃安全的本地收藏、个人标签、笔记和阅读进度持久化服务（使用已有 `safe-file` 原子写入）。
- `apps/electron/src/main/ipc.ts`、`apps/electron/src/preload/index.ts`：暴露工作台状态读取、单篇 patch 和批量本地记录清除 API。
- `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`：移除两处 `false && paperKnowledgeBaseEnabled`，恢复正常侧栏与 Rail 入口。
- `apps/electron/src/renderer/components/knowledge-base/knowledge-base-workbench-utils.ts`：新增论文合并、筛选、排序和进度格式化纯函数。
- `apps/electron/src/renderer/components/knowledge-base/KnowledgeBasePanel.tsx`：升级为三栏工作台。

已实现的 UI 功能：

- 论文库局部搜索、个人标签筛选、仅收藏、最近/标题/年份/收藏优先排序；
- 语义搜索结果视图与返回论文库；
- 左侧多选和批量收藏、添加个人标签、批量删除；
- 中央阅读器：论文元数据、arXiv/DOI 外链、收藏、单篇删除、Markdown 阅读和滚动阅读进度；
- 右侧个人工作区：个人标签、自动保存笔记、进度显示；
- 导入、刷新、空态、加载和错误态；
- 个人状态只存本机，不改变 paperpipe 论文主数据协议。

验证结果：

- `git diff --check`：本次涉及文件无空白错误。
- esbuild：Electron main、preload、`kb-workbench-service.ts` 和 `KnowledgeBasePanel.tsx` 都已成功 bundle。
- 全量 `tsc --noEmit -p apps/electron/tsconfig.json`：没有知识库工作台文件报错；当前失败均为工作树既有的 `team-notification-service`、`preload` 事件类型、`ProjectGraphPanel`、`TeamActivityFeed`、`DetachedPreviewApp`、`SubscriptionSettings` 类型错误。
- Vite production build 在进入组件编译前即因既有 Tailwind `content` 配置为空、`globals.css` 的 `border-border` `@apply` 失败中止；不是本次面板样式导致。
- 尚未启动 Electron 做人工端到端验收；运行环境的 Bash PATH 未包含 Bun，但可使用 `C:\Program Files\nodejs\node.exe` 调用本地工具链。建议在正常 Windows 终端执行 `bun run dev` 后验证入口、导入、纸张阅读、笔记/标签持久化和 paperpipe 删除。


**接管时间**: 2026-07-18 10:15  
**当前时间**: 2026-07-18 10:30

## 诊断结果

### ✅ 已完成的工作

1. **服务端连通性验证**
   - paperpipe-bridge.service 运行正常（systemd，宿主机端口 9876）
   - Docker 容器 → host.docker.internal:9876 连通性正常
   - 服务端路由 `server/src/routes/services/paperpipe.js` 已创建并挂载

2. **TypeScript 类型错误修复**
   - 修复 `ipc.ts` 缺失的类型导入（SkillFileContent、SkillFileNode）
   - 修复 `preload/index.ts` 缺失的类型导入（WorkspaceMemorySummary、SkillFileContent、SkillFileNode）
   - 剩余 15 个类型错误全是既存问题（TeamActivityFeed 图标类型等），与 paperpipe 集成无关

3. **代码架构检查**
   - `kb-paperpipe.ts` (522 行) 逻辑清晰：
     - arXiv 论文 → paperpipe 服务端
     - 本地 PDF → MinerU 解析 → 上传 paperpipe
     - 搜索：服务端优先，fallback 本地关键词
     - 列表：服务端 + 本地合并
     - 获取：本地优先（有缓存），fallback 服务端
     - 删除：本地 + 服务端同步
   - IPC handlers 已全部切换到 kb-paperpipe
   - MCP 工具已适配（kb-agent-tools.ts）

### 🟡 待验证的部分

1. **端到端功能测试**（未执行）
   - 需要启动 dev 环境实际测试
   - 测试场景：
     - 导入 arXiv 论文（通过 arXiv ID）
     - 上传本地 PDF（通过 MinerU）
     - 搜索论文（paperpipe FTS5）
     - 查看论文详情
     - 删除论文
   - 可能遇到的问题：
     - 运行时错误（类型不匹配、API 格式不一致等）
     - UI 交互问题（错误提示、加载状态等）
     - 服务端性能问题（大 PDF 上传、搜索超时等）

2. **数据迁移**（未实施）
   - 本地 `index.json` 中的旧论文未同步到 paperpipe 服务端
   - 用户升级后，旧数据只能通过本地关键词搜索，无法享受服务端语义搜索
   - 建议：编写一次性迁移脚本或在客户端首次启动时自动同步

### 📦 工作树状态

```
On branch main
Your branch and 'origin/main' have diverged,
and have 25 and 1 different commits each, respectively.

Changes not staged for commit:
  - 45 个文件已修改
  - 2 个文件删除（kb-chunker.ts, kb-embedder.ts）

Untracked files:
  - apps/electron/src/main/lib/kb-paperpipe.ts (新建，522 行)
  - server/src/routes/services/paperpipe.js (新建，~300 行)
  - scripts/fix-bridge-*.py (4 个 bridge 修复脚本)
  - server/scripts/deploy-website.sh
  - server/src/db/config-store.js
  - server/src/routes/account/config.js
  - server/src/routes/admin/config.js
  - server/src/routes/public/ (目录)
```

**提交前必做**：
1. 端到端功能测试（至少测通一次完整流程）
2. 如果发现运行时错误，修复后再提交
3. 考虑是否需要数据迁移方案

## 下一步行动建议

### 方案 A：立即测试（推荐）

```bash
cd D:/profer/Proma-main
(unset CLAUDE_CONFIG_DIR; bun run dev)
```

然后在应用中：
1. 点击侧边栏 "论文知识库"
2. 尝试导入一篇 arXiv 论文（如 2306.05427，服务端日志显示正在处理这篇）
3. 观察是否有报错
4. 尝试搜索、查看、删除

**预期问题**：
- ❌ 可能出现：`Cannot find module 'kb-arxiv'`（如果 kb-arxiv.ts 被删除了）
- ❌ 可能出现：API 格式不匹配（服务端返回字段与客户端期望不一致）
- ❌ 可能出现：UI 卡住或无响应（超时、错误处理不当）

### 方案 B：先修复已知风险

在测试前检查以下文件是否存在：
- `apps/electron/src/main/lib/kb-arxiv.ts`（kb-agent-tools.ts 第 58 行导入了它）
- 如果不存在，需要恢复或重写 arXiv 搜索功能

### 方案 C：分阶段提交

如果时间紧迫，可以：
1. 先提交类型修复（ipc.ts, preload/index.ts 的导入）
2. 论文知识库功能暂不提交，留待测试通过后再提交

## 关键文件清单

| 文件 | 状态 | 说明 |
|------|------|------|
| `apps/electron/src/main/lib/kb-paperpipe.ts` | ✅ 新建 | 522 行，替代 kb-service.ts |
| `apps/electron/src/main/lib/kb-service.ts` | ✅ 精简 | 433→66 行，保留 getKBStats fallback |
| `apps/electron/src/main/lib/kb-agent-tools.ts` | ✅ 修改 | 切换到 kb-paperpipe |
| `apps/electron/src/main/ipc.ts` | ✅ 修改 | 7 个 KB handler 切换 + 类型导入修复 |
| `apps/electron/src/preload/index.ts` | ✅ 修改 | 类型导入修复 |
| `server/src/routes/services/paperpipe.js` | ✅ 新建 | ~300 行，代理到 paperpipe-bridge |
| `server/index.js` | ✅ 修改 | 挂载 paperpipe 路由 |
| `apps/electron/src/main/lib/kb-chunker.ts` | ✅ 删除 | paperpipe 替代 |
| `apps/electron/src/main/lib/kb-embedder.ts` | ✅ 删除 | LEANN 替代 |
| `apps/electron/src/main/lib/kb-arxiv.ts` | ❓ 未检查 | 需要确认是否存在 |

## 测试清单

- [ ] arXiv 论文导入（输入 arXiv ID，如 2306.05427）
- [ ] 本地 PDF 上传（选择一个 PDF 文件）
- [ ] 论文列表显示（查看所有已导入论文）
- [ ] 论文搜索（输入关键词，如 "attention mechanism"）
- [ ] 论文详情查看（点击某篇论文）
- [ ] 论文删除（删除一篇测试论文）
- [ ] MCP 工具调用（在 Agent 会话中问 "搜索关于 transformer 的论文"）
- [ ] 错误处理（输入无效 arXiv ID，观察错误提示）

## 已知问题

1. **数据迁移缺失**：本地旧论文不会自动同步到服务端
2. **kb-arxiv.ts 依赖**：kb-agent-tools.ts 第 58 行导入了它，如果被删除会报错
3. **错误提示不友好**：很多地方直接 throw Error，UI 可能显示原始错误信息

## 服务端状态

- **paperpipe-bridge.service**: ✅ active (systemd)
- **papi 版本**: 1.10.2
- **FTS5 搜索索引**: ✅ search.db 已构建
- **测试论文**: 2306.05427 (正在添加中), 2103.05236, 1706.03762

## 相关文档

- 工作区级 note: `~/.profer/agent-workspaces/profer/workspace-files/.context/note.md` (2026-07-18 条目)
- 前一次会话: `~/.profer/agent-workspaces/profer/a07cc271-212b-40eb-b402-86ca7b1df174/.context/note.md`
- 计划文档: `~/.profer/agent-workspaces/profer/a07cc271-212b-40eb-b402-86ca7b1df174/.context/plan/kb-paperpipe-integration.md`
