# Agent 文件视觉预览 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Claude 和 Pi Agent 增加统一的 `inspect_preview` 内置工具，使 Agent 能在授权范围内实时读取文件内容并通过共享预览 renderer 观察视觉结果。

**Architecture:** 主进程新增 preview inspection domain service，负责授权、文件指纹、类型路由、结构化解析、预算与结果编排；Claude 通过 in-process MCP、Pi 通过 custom tool 暴露同一契约。视觉部分由独立的隐藏 renderer 复用现有 Office/Markdown/HTML 预览实现，并以 runtime image content block 返回。

**Tech Stack:** Electron 39、TypeScript、React、Claude Agent SDK MCP、Pi custom tools、Jotai（仅 UI 状态需要时）、Silurus/Ooxml viewer、现有 `file-preview-service` 和 `profer-file://` 协议、Bun test。

---

## Task 1: 固化共享输入输出类型与限制

**Files:**
- Modify: `packages/shared/src/types/agent.ts` 或现有 Agent 类型入口
- Modify: `packages/shared/src/index.ts`（若类型入口需要导出）
- Create: `packages/shared/src/types/agent-preview.test.ts`

**Step 1: Write the failing test**

增加测试，定义并断言：

- `InspectPreviewInput` 接受 `filePath`、`mode`、`scope`、`page`、`previousRevision`；
- kind、error code、visual image 元数据的联合类型不允许混用；
- 文件类型默认策略和截图预算常量有明确导出。

**Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/types/agent-preview.test.ts`

Expected: FAIL，因为共享类型/常量尚未存在。

**Step 3: Write minimal implementation**

新增共享接口和联合类型，至少包含：

- `InspectPreviewMode`、`InspectPreviewScope`；
- `AgentPreviewFileKind`；
- `InspectPreviewInput`；
- `InspectPreviewResult`；
- `InspectPreviewError`，含稳定 `code` 和 `retryable`；
- `AgentPreviewImage`，约束 `image/png` 等 runtime 可消费媒体类型；
- 文件大小、页数、图片数量、像素和 payload 限制。

保持类型位于 shared，不把主进程路径、BrowserWindow 或 renderer 类型泄露到 shared。

**Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/types/agent-preview.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add packages/shared/src/types/agent.ts packages/shared/src/types/agent-preview.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): define agent preview contract"
```

---

## Task 2: 实现文件授权、revision 和类型默认路由

**Files:**
- Create: `apps/electron/src/main/lib/preview-inspection-service.ts`
- Create: `apps/electron/src/main/lib/preview-inspection-service.test.ts`
- Reuse: `apps/electron/src/main/lib/agent-image-output-service.ts`
- Reuse: `apps/electron/src/main/lib/file-preview-service.ts`

**Step 1: Write the failing tests**

覆盖以下行为：

- 相对路径相对于 `agentCwd` 解析；
- 当前会话目录和 allowed roots 内的真实文件允许访问；
- 符号链接越界、未授权绝对路径、目录和不存在文件被拒绝；
- `.ts/.json/.csv` 默认 `content`，`.md/.html/.pptx/.png` 默认 `both`；
- `scope: page` 必须有正整数 page；
- `previousRevision` 返回变化布尔值；
- 读取前后文件 hash 不一致时返回 retryable 的 `file_changed_during_inspection`；
- 读取超过预算时返回稳定错误码。

测试应通过依赖注入提供 `agentCwd`、`allowedRoots` 和可替换的读文件/渲染函数，避免单测创建 Electron 窗口。

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/preview-inspection-service.test.ts`

Expected: FAIL，因为服务尚未存在。

**Step 3: Write minimal implementation**

实现公开 API，例如：

```ts
interface PreviewInspectionContext {
  agentCwd: string
  allowedRoots: string[]
}

inspectPreview(input: InspectPreviewInput, context: PreviewInspectionContext): Promise<PreviewInspectionResult | PreviewInspectionError>
```

要求：

- 统一使用 realpath、relative/isAbsolute 做授权校验；
- 不能向结果返回本机绝对路径；
- 使用内容 hash 生成 revision；metadata 采用安全的 name/size/modifiedAt；
- 复用 `resolveAndReadFile`、`convertOfficeToHtml` 等现有解析逻辑，避免复制 OOXML parser；
- 将 mode/scope/page 归一化并在服务层校验，而不是依赖 MCP schema；
- 将图片生成抽象成 `PreviewRenderer` 接口，先接入后续 hidden renderer 实现；
- 统一把异常转换为结构化错误，不在工具层重复处理。

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/preview-inspection-service.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/preview-inspection-service.ts apps/electron/src/main/lib/preview-inspection-service.test.ts
git commit -m "feat(agent): add authorized preview inspection service"
```

---

## Task 3: 抽取隐藏 renderer 的 IPC/窗口服务

**Files:**
- Create: `apps/electron/src/main/lib/agent-preview-renderer.ts`
- Create: `apps/electron/src/renderer/agent-preview/AgentPreviewRenderer.tsx`
- Modify: `apps/electron/src/main/index.ts` 或现有 BrowserWindow 生命周期入口
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Create: `apps/electron/src/main/lib/agent-preview-renderer.test.ts`

**Step 1: Write the failing tests**

测试 renderer service 的窗口复用和生命周期：

- 第一次请求创建隐藏窗口；
- 连续请求复用窗口但清理上一次任务；
- Abort/timeout 会取消任务并销毁 viewer；
- renderer 返回的 PNG 被转成安全的 image payload；
- renderer 不接受任意 URL，只接受主进程传入的受控 `profer-file://`/临时 HTML 资源；
- 文件不存在或资源加载超时返回可重试错误。

Electron API 应通过 mock 注入，单测不能依赖真实显示器或开发服务器。

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/agent-preview-renderer.test.ts`

Expected: FAIL。

**Step 3: Write minimal implementation**

实现主进程窗口服务：

- 创建 `show: false`、禁用不需要的导航能力的 BrowserWindow；
- 通过 preload 暴露窄接口：加载任务、通知 ready、传递 capture 结果；
- renderer 侧根据 `kind` 选择 Markdown/HTML 渲染或 Office viewer；
- PPTX/PDF 等多页文件支持 `overview`、`page`、`all`；
- 使用 `webContents.capturePage()`，限制 capture rectangle 和总像素；
- 等待 viewer ready、字体和资源加载，设置明确超时；
- 每次任务建立 request id，响应必须匹配当前 request id；
- 清理 React viewer、DOM、临时 URL 和超时计时器；
- 不复用用户当前的 `FilePreviewDialog` 实例，但尽量抽取其底层 viewer/渲染组件，确保结果一致。

如果现有 Vite renderer 入口不适合在隐藏窗口中加载，新增专用 route/entry，但不得复制 Office 解析器；必要的主进程解析仍复用 `file-preview-service`。

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/agent-preview-renderer.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/agent-preview-renderer.ts apps/electron/src/renderer/agent-preview apps/electron/src/main/index.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts
git commit -m "feat(agent): add hidden preview renderer"
```

---

## Task 4: 接入 Agent preview inspection domain service

**Files:**
- Modify: `apps/electron/src/main/lib/preview-inspection-service.ts`
- Modify: `apps/electron/src/main/lib/agent-image-output-service.ts`（仅在需要复用 image validation 时）
- Modify: 相关 `index.ts` 导出或依赖注入入口
- Extend: `apps/electron/src/main/lib/preview-inspection-service.test.ts`

**Step 1: Write the failing tests**

增加端到端的服务级 mock 测试：

- 文本文件返回 text content，不调用 renderer；
- Markdown/HTML `both` 返回结构化文本和 PNG；
- 图片返回图片 content 与 metadata；
- Office `overview/page/all` 将正确任务交给 renderer；
- PPTX 指定页只返回目标页图和对应文本；
- 结果不暴露绝对路径；
- renderer 失败、页码越界、revision 变化、预算超限都转换为统一结果。

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/preview-inspection-service.test.ts`

Expected: FAIL。

**Step 3: Write minimal implementation**

串联类型路由、结构化 parser 和 hidden renderer：

- 文本默认只读；显式要求 `visual` 时，只有支持视觉呈现的文本格式才渲染；
- 对 Office 文档保留 `file-preview-service` 的文本 fallback；
- 对图片直接校验格式和大小，不通过 Office renderer；
- 组装 runtime-neutral 的领域结果，再由 Claude/Pi adapter 各自转换 image block；
- 记录 warnings，例如解析截断、sheet/slide 数量受限和视觉降级。

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/preview-inspection-service.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/preview-inspection-service.ts apps/electron/src/main/lib/preview-inspection-service.test.ts
git commit -m "feat(agent): compose content and visual preview results"
```

---

## Task 5: 暴露 Claude MCP 工具

**Files:**
- Create: `apps/electron/src/main/lib/agent-preview-tools.ts`
- Create: `apps/electron/src/main/lib/agent-preview-tools.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`

**Step 1: Write the failing tests**

测试：

- Claude in-process MCP 注册一个名为 `inspect_preview` 的工具；
- schema 与 shared input 一致；
- 工具上下文带入当前 session 的 cwd/授权目录；
- 文本结果为 text block；
- 视觉结果为 SDK 支持的 image block，包含正确 mimeType；
- 错误结果不抛出未处理异常，返回稳定错误码和 retryable；
- 工具默认在普通 Agent 会话注入，不受 PPT capability 门禁限制；
- disabledTools/预设裁剪规则按现有工具注入机制生效（如该机制覆盖内置工具）。

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/agent-preview-tools.test.ts`

Expected: FAIL。

**Step 3: Write minimal implementation**

新增 Claude MCP server，复用现有 `agent-image-output-tools.ts` 的结果风格，但直接把 preview service 产出的图片放到 `content` image block。将工具注入 `agent-orchestrator.ts` 的 MCP 构建流程，放在基础 Agent 工具区域，并使用 session metadata 构建授权上下文。

在 `agent-prompt-builder.ts` 增加简短工具指南：先对生成/修改后的视觉文件调用 `inspect_preview`，需要多次观察时使用最新调用结果，不以第一次检查盖棺定论；纯代码/JSON/CSV 默认直接读取内容。

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/agent-preview-tools.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/agent-preview-tools.ts apps/electron/src/main/lib/agent-preview-tools.test.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-prompt-builder.ts
git commit -m "feat(agent): expose inspect preview to Claude"
```

---

## Task 6: 暴露 Pi custom tool 并统一图片结果

**Files:**
- Modify: `apps/electron/src/main/lib/adapters/pi-mcp-tools.ts` 或 Pi 内置工具注册入口
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`（若现有内置工具均集中在此）
- Create/Modify: 对应 Pi tool test
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`（若 Pi 注入需要显式注册）

**Step 1: Write the failing tests**

测试 Pi 工具：

- 暴露同名 `inspect_preview`；
- 参数 schema 与 Claude 一致；
- text block 和 image block 转换为 Pi 的 `TextContent`/`ImageContent`；
- 连续调用使用实时 revision；
- 错误结果与 Claude 语义一致；
- 不要求 Pi 再调用 `send_local_image`。

**Step 2: Run test to verify it fails**

Run: `bun test apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`

Expected: FAIL。

**Step 3: Write minimal implementation**

把 preview service 结果转换为 Pi custom tool 返回格式。不要在 Pi 侧重复路径授权、parser 或截图逻辑；Pi 只负责 schema、context 绑定和 content block 适配。确认工具命名在 Pi 下按项目现有 MCP/custom tool 规则可被 Agent 发现，并同步 prompt 中的 Pi 工具名说明（如有前缀规则）。

**Step 4: Run test to verify it passes**

Run: `bun test apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/adapters apps/electron/src/main/lib/agent-orchestrator.ts
 git commit -m "feat(agent): expose inspect preview to Pi"
```

---

## Task 7: 完成集成验证、文档和版本同步

**Files:**
- Modify: `apps/electron/src/main/lib/*test.ts`（仅补集成覆盖）
- Modify: `apps/electron/package.json`（按仓库规则递增 patch）
- Modify: `packages/shared/package.json`（若 shared 类型发生变化，递增 patch）
- Modify: `/Users/mac/profer/profer-main/CLAUDE.md`（仅在确认规则/架构入口需要同步时）
- Modify: `README.md` / `README.en.md`（仓库规则要求功能变化同步，修改前需用户允许）
- Create: `docs/plans/2026-09-03-agent-preview-design.md`（已完成）

**Step 1: Run focused tests**

Run:

```bash
bun test packages/shared/src/types/agent-preview.test.ts \
  apps/electron/src/main/lib/preview-inspection-service.test.ts \
  apps/electron/src/main/lib/agent-preview-renderer.test.ts \
  apps/electron/src/main/lib/agent-preview-tools.test.ts \
  apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts
```

Expected: PASS。

**Step 2: Run typecheck**

Run: `bun run typecheck`

Expected: PASS，或明确区分本功能新增错误与工作树既有错误。

**Step 3: Run renderer/build checks**

Run:

```bash
bun run electron:build
```

Expected: main/preload/renderer 均成功构建，hidden renderer 所需资源被打包。

**Step 4: Perform Electron acceptance**

验证以下场景：

1. Agent 生成 HTML 网页 PPT，调用 `inspect_preview` 的 `visual`/`both`，模型直接收到图片；
2. Agent 生成或修改 PPTX，分别调用 overview、指定页和 all；
3. 修改文件后重复调用，revision 和图片随文件变化；
4. 在用户完全未打开文件预览窗口时仍可完成检查；
5. 纯代码/JSON/CSV 调用不生成视觉图；
6. 越权路径、符号链接越界和非法 HTML 资源被拒绝；
7. viewer 超时或文件写入过程中变化时能重试，且不会污染下一次请求。

**Step 5: Update product documentation**

按仓库 CLAUDE 规则同步功能入口说明；README 的修改属于仓库要求的长期文档副作用，若尚未获得用户允许，应在实施前单独请求允许，不要擅自修改。

**Step 6: Commit**

```bash
git add apps/electron packages/shared docs/plans
 git commit -m "feat(agent): add visual file preview inspection"
```

---

## Implementation Notes

- 当前工作树已有未提交的 macOS 相关改动。实施前后都必须使用 `git -C /Users/mac/profer/profer-main status -sb`，只提交本功能文件，绝不覆盖或整理既有改动。
- 不要引入新的数据库；短期 renderer 缓存可使用内存 Map，并以 revision 与授权上下文隔离。
- 不要把模型可见的结果设计为本机绝对路径；图片必须走 runtime image content block。
- 不要把“上一次 revision”误解为历史内容；每次调用都重新读取当前磁盘版本。
- 第一版不实现视觉 diff；但结果中保留 revision 和 `changedSincePreviousRevision`，为后续扩展保留契约。
- 主进程、preload、renderer 之间新增 IPC 必须同步类型、handler、bridge 和调用方，遵循仓库现有四段式 IPC 约定。
