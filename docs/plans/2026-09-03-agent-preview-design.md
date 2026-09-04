# Agent 文件视觉预览设计

> 日期：2026-09-03（GMT+8）
> 状态：已由用户确认，待实施

## 背景

Profer 已经提供面向人类用户的文件预览能力，但 Agent 目前不能直接观察预览结果。制作 PPT、网页 PPT 或富文档时，Agent 往往只能自行打开页面并截图，再读取截图，造成额外步骤，并且人类预览和 Agent 观察结果可能不一致。

目标是提供一个所有 Agent 会话默认可用的内置工具 `inspect_preview`，让 Agent 通过与人类预览相同的渲染链路读取文件内容并观察视觉结果。该能力不是只服务 PPT，而是统一覆盖可预览文件；纯文本优先返回内容，不强制截图。

## 目标与非目标

### 目标

- Claude 和 Pi 使用同一工具契约、同一授权边界和同一预览服务。
- HTML、Markdown、PDF、DOCX、XLSX、PPTX、图片等可视文件可以返回模型可见的 PNG image content。
- 纯文本、代码、JSON、YAML、CSV、TSV 默认只返回结构化文本；Markdown、HTML、Office 和图片默认支持内容与视觉结果。
- Agent 可以显式选择 `content`、`visual` 或 `both`，以及 `overview`、`page` 或 `all`。
- 每次调用实时检查磁盘文件，返回 revision；支持通过 `previousRevision` 判断文件是否在两次观察间发生变化。
- 多次调用可以观察同一个文件的变化，第一次观察不构成最终结论。
- AI 预览与人类预览共享 Office/Markdown/HTML 的 renderer 实现，但不依赖用户当前是否打开预览窗口。

### 非目标

- 第一版不生成前后视觉差异图；仅返回最新结果和 revision。
- 第一版不允许 Agent 访问任意 `file://`、网络页面或未授权本地路径。
- 第一版不把所有纯文本渲染成截图。
- 第一版不新建独立的 PPT 编辑工作台。

## 工具契约

工具名称：`inspect_preview`

```ts
interface InspectPreviewInput {
  filePath: string
  mode?: 'content' | 'visual' | 'both'
  scope?: 'overview' | 'page' | 'all'
  page?: number
  previousRevision?: string
}
```

字段规则：

- `filePath` 必须是当前 Agent 会话工作目录或用户明确授权附加目录中的路径；相对路径相对于 Agent cwd 解析。
- `mode` 省略时按文件类型采用默认策略：代码/文本/JSON/YAML/CSV/TSV 为 `content`；Markdown、HTML、SVG、PDF、DOCX、XLSX、PPTX、图片为 `both`。
- `scope` 由 Agent 显式控制。单页文件忽略多页 scope；多页文件可用 `overview` 获取总览、`page` 获取指定页、`all` 获取全部页面。工具不因省略 scope 擅自返回全部高清页面。
- `page` 使用从 1 开始的页码，仅在 `scope: 'page'` 时有效；越界必须返回结构化错误。
- `previousRevision` 仅做变化检测，不复用旧内容替代当前读取结果。

结果建议结构：

```ts
interface InspectPreviewResult {
  file: {
    name: string
    kind: 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'unknown'
    size: number
    modifiedAt: string
    revision: string
  }
  changedSincePreviousRevision?: boolean
  content?: {
    text: string
    truncated: boolean
    pageCount?: number
  }
  visual?: {
    scope: 'overview' | 'page' | 'all'
    page?: number
    images: Array<{ data: string; mimeType: 'image/png' }>
  }
  warnings?: string[]
}
```

实际 MCP/Pi 返回应将图片放在 runtime 支持的 image content block 中，而不是只在 JSON 中放 base64 或临时路径；文本和元数据放在 text block/details 中。不得要求模型再次调用 `send_local_image` 才能看到结果。

## 默认文件策略

| 文件类型 | 默认 mode | 视觉策略 |
| --- | --- | --- |
| TXT、代码、JSON、YAML、CSV、TSV、日志 | `content` | 原文/结构化文本，不截图 |
| Markdown | `both` | 原文摘要 + 渲染后的完整视觉图 |
| HTML/CSS/SVG | `both` | 受控渲染结果；HTML 禁止任意网络和越权资源 |
| 图片 | `both` | 原图作为 image content，必要时附元数据 |
| PDF | `both` | 文本解析 + overview/page/all 页面图片 |
| DOCX | `both` | 文本解析 + 页面视觉图 |
| XLSX | `both` | 表格文本 + 工作表视觉图；遵守 sheet/行/列限制 |
| PPTX | `both` | 幻灯片文本 + overview/page/all 页面图片 |
| 其他 | `content` 或结构化不支持提示 | 不猜测渲染方式 |

## 架构与数据流

```text
Agent inspect_preview
  -> Claude in-process MCP / Pi custom tool
  -> preview-inspection-service
  -> 路径授权、文件类型识别、revision
  -> file-preview-service 结构化解析
  -> hidden preview renderer（复用人类预览组件）
  -> PNG image content + text/details
```

### 主进程服务

新增 `preview-inspection-service`（具体文件名可在实施阶段按现有服务组织调整），负责：

- 使用当前 session 的 `agentCwd` 与 `allowedRoots` 做 realpath 授权校验；
- 读取文件元数据并计算稳定 revision（至少包含文件内容 hash，必要时结合 size/mtime）；
- 复用 `file-preview-service` 的文本/Office 解析能力；
- 调用隐藏 renderer 生成视觉结果；
- 校验 scope/page、文件大小、页数、图片数量、截图像素和总字节预算；
- 在渲染前后核对 revision；如果文件在一次检查期间变化，丢弃混合结果并返回需重试的结构化错误；
- 将主进程错误映射成 Agent 可行动的提示。

### 隐藏 renderer

新增受控的隐藏 Electron `BrowserWindow` 服务，生命周期独立于用户当前打开的 `FilePreviewDialog`：

- 复用现有 `OfficePreview` 使用的 Silurus/Ooxml viewer；
- 复用 Markdown/HTML 的渲染和 `profer-file://` 资源协议；
- 按任务加载一个文件，清理前一任务状态，支持 Abort/超时；
- 等待 WASM、字体、图片和 viewer ready 后再使用 `webContents.capturePage()`；
- 支持按页截图以及 overview/all 的图片数量控制；
- 不把隐藏窗口暴露给用户或模型，也不读取当前人类预览窗口的状态。

优先抽取 renderer 侧的可复用渲染逻辑，而不是在主进程复制一套 Office 转图片实现。隐藏 renderer 与用户预览的差异应限于容器尺寸、截图范围和后台生命周期。

## 安全与资源预算

- 路径必须经过主进程 realpath 校验，拒绝符号链接越界、`file://` 和未授权路径。
- HTML 只允许受控的本地资源目录；默认阻止任意网络请求，限制资源加载超时。
- 文件、HTML、Office 页数、图片像素、单次返回图片数和总 payload 都必须有上限；超限返回 warning 或可行动错误。
- 返回内容不得泄露本机绝对路径；文件名可以返回，内部路径只留在主进程和受控 renderer。
- Renderer 任务失败、超时或取消时必须销毁/重置 viewer，避免下一次检查复用脏状态。
- 不缓存跨授权边界的内容。相同 revision 可以使用短期内部渲染缓存，但每次调用仍需重新校验路径和当前 revision。

## 变化观察语义

每次调用都读取当前磁盘版本并生成新的 revision：

1. 读取开始时计算 `startRevision`；
2. 解析和截图；
3. 完成后再次计算 revision；
4. 若前后不同，放弃本次混合结果，返回 `file_changed_during_inspection`，提示 Agent 重新调用；
5. 若传入 `previousRevision`，返回 `changedSincePreviousRevision`；
6. Agent 可重复调用 overview、page、all，逐次观察修改效果。

第一版不保留面向 Agent 的历史截图，也不自动生成 diff；revision 只用于识别观察时点和指导下一次调用。

## 错误处理

统一返回结构化错误，不吞掉关键信息：

- 文件不存在或无法访问；
- 文件不在当前会话授权边界；
- 文件类型不支持；
- 页码越界；
- viewer/WASM 加载失败；
- HTML 资源非法或超时；
- 文件或渲染预算超限；
- 文件在检查期间发生变化。

错误结果应包含稳定 error code、面向 Agent 的中文说明和必要的 retryable 标记；不得返回半旧半新的视觉结果。

## 验证标准

1. 服务单测覆盖路径授权、类型路由、默认 mode、scope/page 校验、revision、变化检测、限制和错误码。
2. Claude MCP 与 Pi custom tool 测试覆盖同一 schema、文本 block、image block 和失败结果格式。
3. renderer 集成测试覆盖 HTML/Markdown、PPTX overview、指定页、all 限制、viewer 超时清理。
4. 人工验收至少包括：生成网页 PPT 后连续观察同一页、修改 PPT 后 revision 变化、用户未打开预览窗口时 Agent 仍可检查、越权路径被拒绝、纯代码文件不生成图片。
5. 验证需分别记录单测、typecheck、构建和真实 Electron 预览；不能用截图 API 成功调用替代隐藏 renderer 的真实验收。
