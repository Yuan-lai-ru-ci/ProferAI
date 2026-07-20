# 论文知识库入口关闭记录

**时间**: 2026-07-18 10:30  
**操作**: 暂时关闭论文知识库功能的所有用户可见入口

## 修改内容

### 1. LeftSidebar.tsx（侧边栏）

**文件**: `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`

修改了两处入口：

#### 顶部导航栏图标（第 2021 行）
```tsx
// 修改前
{paperKnowledgeBaseEnabled && (
  <Tooltip>
    ...
  </Tooltip>
)}

// 修改后
{/* 论文知识库入口已暂时关闭 */}
{false && paperKnowledgeBaseEnabled && (
  <Tooltip>
    ...
  </Tooltip>
)}
```

#### 侧边栏列表项（第 2182 行）
```tsx
// 修改前
{/* 论文知识库入口 */}
{paperKnowledgeBaseEnabled && (
  <div className="px-3 pb-0.5">
    ...
  </div>
)}

// 修改后
{/* 论文知识库入口已暂时关闭 */}
{false && paperKnowledgeBaseEnabled && (
  <div className="px-3 pb-0.5">
    ...
  </div>
)}
```

### 2. GeneralSettings.tsx（设置页面）

**文件**: `apps/electron/src/renderer/components/settings/GeneralSettings.tsx`

**位置**: 第 683-694 行

```tsx
// 修改前
<SettingsToggle
  label="论文知识库"
  description="在侧边栏显示论文知识库入口，支持 arXiv 和本地论文 PDF 导入与语义搜索"
  checked={paperKnowledgeBaseEnabled}
  onCheckedChange={(checked) => { ... }}
/>

// 修改后
{/* 论文知识库设置已暂时关闭 */}
{false && (
<SettingsToggle
  label="论文知识库"
  description="在侧边栏显示论文知识库入口，支持 arXiv 和本地论文 PDF 导入与语义搜索"
  checked={paperKnowledgeBaseEnabled}
  onCheckedChange={(checked) => { ... }}
/>
)}
```

## 验证结果

- ✅ TypeScript 编译无新增错误（依然是 5 个既存错误）
- ✅ 代码逻辑完整保留，只是通过 `false &&` 条件禁用渲染
- ✅ 所有导入和 atom 依赖保持不变，方便后续恢复

## 恢复方法

需要重新启用论文知识库时，只需将三处的 `false &&` 删除即可：

```tsx
// 恢复方法：删除 false &&
{paperKnowledgeBaseEnabled && (
  ...
)}
```

## 未修改的部分

以下代码保持不变，论文知识库后端功能完整保留：

- ✅ `kb-paperpipe.ts` — 论文知识库核心逻辑
- ✅ `kb-agent-tools.ts` — MCP 工具（Agent 可以通过工具调用，但用户无法从 UI 访问）
- ✅ `ipc.ts` — IPC handlers
- ✅ `KnowledgeBasePanel.tsx` — 知识库面板组件
- ✅ `server/src/routes/services/paperpipe.js` — 服务端路由
- ✅ `paperKnowledgeBaseEnabledAtom` — Atom 定义和默认值

## 影响范围

- ❌ 用户无法从侧边栏访问论文知识库
- ❌ 用户无法在设置中看到论文知识库开关
- ✅ 如果用户之前已开启，atom 值保留（但 UI 不渲染）
- ✅ Agent 的 MCP 工具 `search_knowledge_base` 等依然可用（如果 Agent 主动调用）
- ✅ 服务端 API 依然可访问（如果有其他客户端调用）

## 相关文档

- 论文知识库开发交接：`.context/handoff.md`
- 诊断报告：`.context/paperpipe-diagnosis.md`
- 行动指南：`.context/todo.md`
