# Profer 学生 PPTX 首个纵向版本实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Profer Agent 原生对话流中，交付一个面向学生组会与课程作业的、可追溯且语义级可编辑的 `.pptx` 生成纵向版本。

**Architecture:** 由受管的 TypeScript 服务负责 PPT 能力激活门禁、来源扫描、版本谱系、Deck Project、Style Pack 和 PptxGenJS 编译；Claude/Pi 只共享同一组领域服务和工具契约。普通会话默认不注入 PPT 工具和长提示词，只有高置信 PPT 意图或已有 active Deck Project 才在当前会话激活。Agent 负责理解材料、动态追问、生成 Deck Brief/Deck Spec 和修订决策；`inactive → active → inspect → AskUserQuestion → confirm → compile → audit → preview` 是不可跳过的分层门禁。

**Tech Stack:** TypeScript、Bun test、`@profer/shared`、Electron main process、PptxGenJS 4.0.1、AdmZip、现有 `document-parser`、PowerPoint COM PNG 渲染、现有 `profer-file://` 安全文件协议。

---

## 0.1 产品方向纠偏：视觉创作优先，治理与审计兜底（2026-08-24）

### 已验证的问题

雪崩组会样例暴露出首版实现把精力过多放在后验治理：来源版本、hash、确认收据、OOXML、Notes、可编辑性与科研措辞审计都在工作；但第一次生成阶段把 AI 的视觉判断压缩为少量 `visualRole/layoutIntent` 到固定组件的映射。结果是“文件合规、论点可追溯，但排版像通用自动模板”。

**这不是可以靠多加几条 QA 规则解决的小问题。** 后续审计只能阻断错误，不能让一个原本平庸的构图变成有说服力的页面。首版的判断标准必须从“先合规再好看”反转为：**先形成有意图的画面，再以来源、语义编辑和科研规范守住底线。**

### 新的优先级与流水线

```text
真实素材 / 数据 / 受众场景
  → AI 视觉策划（叙事镜头、主视觉、焦点、数据编码、跨页节奏）
  → 基于素材尺寸与密度的构图候选（不是固定模板套壳）
  → 原生可编辑对象编译
  → PowerPoint 渲染为真实页面
  → 视觉复盘与按 slideId 重排
  → 来源 / 科研表达 / 可编辑性 / OOXML 审计兜底
  → 交付
```

优先级固定为：

```text
视觉创作质量
> 信息层级与跨页叙事
> 原生可编辑实现
> 来源、科研口径、确认收据与 OOXML 审计
```

后四者仍是 Profer 的护城河，但不得替代前两者；任何“通过结构审计”的 PPT 都不得自动被表述为“设计通过”。

### 第一次创作必须拥有的设计决策

每页在编译前都必须有 `visualDirection`（由 Agent 生成、受 schema 约束、可写入 Deck Spec），至少描述：

- **dominantEvidence**：本页唯一主证据/主视觉，以及它支撑的 claim；
- **composition**：例如 `evidence-led-two-thirds`、`annotated-detail`、`quantitative-ratio`、`causal-chain`、`full-bleed-divider`，不允许泛化为“左图右卡片”；
- **focus**：图像/地图必须指出应保留的区域、局部放大对象或必须保留的图例；
- **dataEncoding**：数字之间的关系如何原生呈现（比例条、点阵、排序条形图、趋势线、地图标注等）；只有一个不可替代的关键指标才允许 `single-stat`；
- **hierarchy**：一句视觉结论、辅助信息、来源/图注分别处于哪一层；
- **negativeConstraints**：本页明确禁止的退化结构，例如 `no_kpi_grid`、`no_card_wall`、`no_decorative_diagonal`、`no_unreadable_full-paper-figure`；
- **transitionIntent**：本页与前后页的镜头关系，例如“先展示验证位置，再展示识别比例，再解释漏测机制”。

`visualRole` 只描述语义对象类别，不能再单独决定版式；`layoutIntent` 只能是经过视觉策划选定的构图候选，不得降级为万能模板名。

### 对雪崩样例的硬性重构原则

以下两种页面从 `academic-editorial` 默认模板中移除，不能再产出：

1. **地图 + 四格 KPI**：地图必须是主视觉时，统计量只能服务于地图的观察结论。密集论文地图先裁出有效区域、保留必要图例、标出与 claim 对应的线路/样点；必要时采用“主图 + 局部放大 + 一条结论”，而不是把四个同权数字放在右侧。
2. **大数字色块 + 三张解释卡**：`17 / 22 / 5 / 77.3%` 必须使用一个能表达关系的原生量化视觉（点阵、比例条、分组条形图或空间标记）；“漏测原因/适用边界/验证价值”应组织为因果链、边注或紧贴证据的标注，而不是三张彩色卡片。

此外，`17 / 22` 若只表示“实际起动点中被识别的数量”，标题不得写成“总体精度”；应写成“起动点识别率”，并在图注或 Notes 中明确：`识别率 = 被识别起动点数 / 实际起动点总数 = 17 / 22`。未经完整混淆矩阵，不能把该比值表述为 precision 或 accuracy。

### 不再接受的伪审美验收

以下情况即使 OOXML、来源和 Notes 全部通过，也必须 `needsVisualRevision=true`，不得交付：

- 同页四个及以上等权 KPI 数字、没有数据关系图；
- 一个大数字色块旁堆叠二至四张解释卡；
- 论文地图/截图缩小到图例、标注或结论区域不可读；
- 相邻内容页使用同一种“标题 + 卡片”构图，缺少叙事节奏；
- 色块只承担装饰或分类、没有承载数据关系/阅读层级；
- 页面最大元素不是核心 claim 的证据或结论；
- 空白是组件未排满造成的，而非为主视觉聚焦留下的呼吸区。

### 视觉复盘的真实能力边界

“渲染后由 AI 看图并自动改版”只能在当前运行时具备可靠视觉模型和受控图片输入时作为硬门禁。当前渠道模型若不能读图，系统必须：

1. 仍生成 PowerPoint COM renders 和客观几何/可读性信号；
2. 将视觉候选、版式理由、风险及 render 路径呈现给用户；
3. 明确标记 `visualReview: unavailable`，绝不把“文件已渲染”说成“AI 已完成美学评审”；
4. 优先改进首次视觉策划和版式库，而不是用无法执行的视觉 QA 伪装闭环。

后续支持视觉模型后，再将“渲染图 → 视觉批评 JSON → slideId 修订 → 再渲染”的循环升级为交付硬门禁。

---

## 0. 范围、非目标与保护边界

### 首版必须交付

- 用户要求、已选文件和工作区授权目录的受限来源扫描；
- `current / superseded / historical / conflicted / unknown` 五态来源谱系；
- 会话级 `deck-project/` 持久化；
- 动态追问由现有 `AskUserQuestion` 承载，Brief 未确认时编译工具拒绝执行；
- `academic-editorial` 与 `profer-cloud-dancer` 两个 Style Pack；
- 封面、章节、证据主导页、原生图表、机制图、对比、结论/参考文献等核心语义页；
- 每页的首次视觉策划：主证据、构图、素材焦点、数据编码、信息层级、跨页转场和负面约束；
- `academic-editorial` 默认拒绝地图 + KPI 宫格、大数字色块 + 解释卡墙等低信息密度模板；
- 原生文本、形状、连接符、表格、图表和 Speaker Notes；照片/论文原图/截图允许是图片；
- Claude 与 Pi 的工具注册契约一致；
- 至少一份学生 fixture 真实生成、Agent 对话内 Office/Silurus PPTX 预览、结构审计、PowerPoint COM 渲染（环境可用时）和一次修订后再审计。

### 首版明确不做

- 脱离 Agent 对话的独立 PPT 编辑工作台；Agent 对话内的 PPTX 预览是首版必做链路；
- 完整的视觉模型自动评审平台；当前模型不支持看图时，不假装完成视觉判断，但首版仍必须产出视觉策划、COM renders、客观版式风险和可供用户审阅的路径；
- 竞品自动抓取和完整盲评平台；只保留 fixture/rubric 资产；
- OOXML 手工分组或 Cloud Dancer 的 PowerPoint grouping；
- 整页图片伪装成可编辑 PPT；
- 自动判断所有自然语言事实冲突；证据不足必须输出 `unknown/conflicted`，由 Agent 追问；
- 协作子 Agent 并发修复；本计划全程父会话/单工作线程执行。

### 绝对不能碰

仓库当前存在与本功能无关的未提交改动，不得修改、还原、stash 或提交：

- `apps/electron/src/renderer/components/agent/RuntimeProcessPanel.tsx`
- `apps/electron/src/renderer/components/settings/SettingsPanel.tsx`
- `apps/electron/src/renderer/components/tabs/MainArea.tsx`

不要使用 `git add .`。每次提交必须显式列出文件。

---

## Task 0：创建隔离 worktree 并固化设计基线

**Files:**
- Read: `D:\profer\Profer-main\CLAUDE.md`
- Read: `D:\profer\Profer-main\docs\plans\2026-08-24-student-pptx-design.md`
- Copy into worktree: `docs/plans/2026-08-24-student-pptx-design.md`
- Create: `D:\profer\worktrees\student-pptx-v1`（仓库外独立 worktree）

**Step 1: 检查主工作树，不触碰用户改动**

Run:

```bash
git -C D:/profer/Profer-main status --short --branch
git -C D:/profer/Profer-main diff -- apps/electron/src/renderer/components/agent/RuntimeProcessPanel.tsx apps/electron/src/renderer/components/settings/SettingsPanel.tsx apps/electron/src/renderer/components/tabs/MainArea.tsx
```

Expected: 只记录现状；三个 UI 文件的 diff 保持不变。

**Step 2: 创建功能分支和 worktree**

Run:

```bash
mkdir -p D:/profer/worktrees
git -C D:/profer/Profer-main worktree add -b feat/student-pptx-v1 D:/profer/worktrees/student-pptx-v1 HEAD
cp D:/profer/Profer-main/docs/plans/2026-08-24-student-pptx-design.md D:/profer/worktrees/student-pptx-v1/docs/plans/2026-08-24-student-pptx-design.md
```

Expected: worktree 建立成功；主工作树的未跟踪设计稿不被删除或移动。

**Step 3: 在 worktree 记录基线**

Run:

```bash
cd /d/profer/worktrees/student-pptx-v1
git status --short --branch
bun test --isolate apps/electron/src/main/lib/ppt-delivery-audit-service.test.ts
```

Expected: 基线审计测试通过；若环境无法运行，记录实际错误，不把失败标成通过。

**Step 4: Commit**

```bash
cd /d/profer/worktrees/student-pptx-v1
git add docs/plans/2026-08-24-student-pptx-design.md
git commit -m "docs: record student pptx design baseline"
```

提交只包含设计基线，不包含主工作树的 UI 改动。

---

## Task 0.5：实现 PPT 能力激活门禁，默认不注入 PPT 工具和提示词

**Files:**
- Create: `apps/electron/src/main/lib/ppt-capability-gate.ts`
- Test: `apps/electron/src/main/lib/ppt-capability-gate.test.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/electron/src/main/lib/agent-session-manager.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/ppt-material-agent-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/src/main/lib/pi-task-prompt.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`
- Modify: `apps/electron/src/main/lib/pi-task-prompt.test.ts`

**Step 1: 写失败测试**

`ppt-capability-gate.test.ts` 覆盖：

- 新会话、普通“检查 TypeScript 类型错误”消息 → `inactive`；
- “请生成一个 .pptx 组会汇报”“做一份课程演示文稿并导出” → 高置信 `activate`；
- “修改第 3 页”“继续这个 deck”“打开刚才的 PPT 预览”，且 session 已有 active Deck Project → 保持 `active`；
- “PPT”出现在代码变量、论文题目或普通文件名而没有创建/修改动作 → 不激活；
- “退出 PPT 模式/不要继续做 PPT” → `deactivate`，且当前轮不注入 PPT 工具；
- 激活状态只在当前 Agent session metadata 持久化，新会话默认 `false`；
- 关闭激活状态不删除已有 Deck Project。

Prompt/工具测试覆盖：

- `buildSystemPrompt({ pptCapabilityActive: false })` 不含 PPT 专用长门禁；
- `buildSystemPrompt({ pptCapabilityActive: true })` 含 PPT 工作流规则；
- Claude 的 `mcpServers` 在 inactive 时没有 `ppt-materials`；
- Pi 的 `customTools` 在 inactive 时没有 `plan_ppt_visuals`、`audit_ppt_delivery` 或 Deck 工具；
- Pi 普通任务不恢复 PPT SOP，PPT 任务在 capability active 且工具实际注册时才恢复；
- 图片、浏览器、通用文件预览工具不受 PPT 门禁误伤。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-capability-gate.test.ts src/main/lib/agent-prompt-builder.test.ts src/main/lib/pi-task-prompt.test.ts src/main/lib/adapters/pi-builtin-tools.test.ts
```

Expected: FAIL，因为当前 PPT 工具和 PPT prompt 是默认注入的，且 session metadata 没有 capability 状态。

**Step 3: 实现确定性能力门禁**

新增纯函数 `evaluatePptCapability()`，输入当前用户消息、session 的 `pptCapabilityActive`、是否存在 active Deck Project，输出 `activate | stay_active | deactivate | inactive` 和可记录的 reason。触发词必须同时结合“演示文件/页面”与“创建/修改/预览/导出”动作，避免只看到 `PPT` 就误激活。明确退出优先级最高。

在 `AgentSessionMeta` 增加可选 `pptCapabilityActive?: boolean`，并把它加入 `updateAgentSessionMeta` 的允许更新字段。发送消息时，在构建 MCP server 和 prompt **之前**：

1. 读取 session meta；
2. 运行 `evaluatePptCapability()`；
3. 状态变化时只更新该字段；
4. 只有 active 时调用 `injectPptMaterialMcpServer()` 和 Pi 的 `buildPiPptMaterialTools()`；
5. 只有 active 时把 PPT 专用段传给 `buildSystemPrompt()`；
6. 普通工具、图片生成、浏览器和通用文件预览照常注册。

不为明确 PPT 请求额外弹一次“是否进入 PPT 模式”对话，避免重复确认；低置信的“可能做成演示”由 Agent 用现有 `AskUserQuestion` 询问，用户确认后下一轮通过意图门禁进入。能力激活只表示工具可用，不表示允许写 PPT。

`pi-task-prompt.ts` 继续保留按任务降级低频 SOP，但新增条件：必须同时满足 `pptCapabilityActive`、实际 PPT 工具存在和 PPT 任务命中。不要在 `buildSystemPrompt` 和 `pi-task-prompt` 各复制一套门禁文案。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-capability-gate.test.ts src/main/lib/agent-prompt-builder.test.ts src/main/lib/pi-task-prompt.test.ts src/main/lib/adapters/pi-builtin-tools.test.ts
bun run typecheck
```

Expected: PASS；普通会话的 system prompt 和工具集合不再携带 PPT 专用能力，显式 PPT 请求仍能在同一轮激活。

**Step 5: Commit**

```bash
git add packages/shared/src/types/agent.ts apps/electron/src/main/lib/ppt-capability-gate.ts apps/electron/src/main/lib/ppt-capability-gate.test.ts apps/electron/src/main/lib/agent-session-manager.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/ppt-material-agent-tools.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.ts apps/electron/src/main/lib/agent-prompt-builder.ts apps/electron/src/main/lib/pi-task-prompt.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts apps/electron/src/main/lib/pi-task-prompt.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts
git commit -m "feat(agent): gate ppt capability per session"
```

---

## Task 1：建立共享 Deck Project 领域类型和 JSON 合同

**Files:**
- Create: `packages/shared/src/types/ppt-deck.ts`
- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/electron/src/main/lib/ppt-deck-schema.ts`
- Test: `apps/electron/src/main/lib/ppt-deck-schema.test.ts`

**Step 1: 先写失败测试**

覆盖以下行为：

```ts
import { describe, expect, test } from 'bun:test'
import { parseDeckBrief, parseDeckSpec, parseSourceLineage } from './ppt-deck-schema'

test('拒绝没有目标、受众或核心论点的 Brief', () => {
  expect(() => parseDeckBrief({ audience: '同学' })).toThrow('目标')
})

test('拒绝没有 slideId、claim 或 evidenceRefs 的页面', () => {
  expect(() => parseDeckSpec({ slides: [{ title: '结果' }] })).toThrow('slideId')
})

test('接受带来源版本、定位符和 sha256 的谱系记录', () => {
  const result = parseSourceLineage({
    sources: [{ id: 'src-1', path: 'paper-final.pdf', status: 'current', contentHash: 'a'.repeat(64), locator: 'p.6.fig.2' }],
  })
  expect(result.sources[0]?.status).toBe('current')
})
```

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-schema.test.ts
```

Expected: FAIL，因为解析函数和类型尚不存在。

**Step 3: 实现最小合同**

`ppt-deck.ts` 至少导出：

- `DeckSourceStatus = 'current' | 'superseded' | 'historical' | 'conflicted' | 'unknown'`；
- `DeckSourceRecord`：`id`、`absolutePath`、`relativePath`、`kind`、`size`、`mtimeMs`、`contentHash`、`status`、`locator`、`title`、`excerpt`、`versionSignals`；
- `DeckBrief`：`goal`、`audience`、`occasion`、`durationMinutes`、`slideCount`、`coreClaims`、`includedSourceIds`、`excludedSourceIds`、`styleId`、`citationPolicy`、`speakerNotesPolicy`、`assumptions`、`confirmedAt?`、`confirmationHash?`；
- `DeckSlideSpec`：`slideId`、`claim`、`evidenceRefs`、`visualRole`、`layoutIntent`、`densityBudget`、`editableObjects`、`assetRefs?`、`visualDirection`、`content`、`speakerNotes`、`citations`；
- `DeckVisualDirection`：`dominantEvidence`、`composition`、`focus?`、`dataEncoding?`、`hierarchy`、`negativeConstraints`、`transitionIntent?`；
- `DeckSpec`：schema version、deck id、style id、slide array、source hashes；
- `DeckProjectState`：`draft | awaiting_confirmation | confirmed | compiled | needs_revision`。

`ppt-deck-schema.ts` 用 Zod 或等价的显式运行时校验，不使用 `as any`。验证要求：数组非空、SHA-256 为 64 位 hex、来源引用必须存在、`confirmedAt` 只有确认工具能写入。`visualDirection` 不得为空泛口号：`dominantEvidence` 必须引用本页 evidence/data，`quantitative-ratio`/`chart` composition 必须声明 `dataEncoding`，`image_with_annotation` 必须声明 `focus`，且 `negativeConstraints` 至少包含一个本页要避免的退化布局。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-schema.test.ts
cd ../..
bun run --filter='@profer/shared' typecheck
```

Expected: 目标测试和 shared typecheck PASS。

**Step 5: Commit**

```bash
git add packages/shared/src/types/ppt-deck.ts packages/shared/src/types/index.ts apps/electron/src/main/lib/ppt-deck-schema.ts apps/electron/src/main/lib/ppt-deck-schema.test.ts
git commit -m "feat(pptx): add deck project schemas"
```

---

## Task 2：实现受限来源扫描与版本谱系

**Files:**
- Create: `apps/electron/src/main/lib/ppt-deck-context-service.ts`
- Test: `apps/electron/src/main/lib/ppt-deck-context-service.test.ts`
- Modify only if needed: `apps/electron/src/main/lib/document-parser.ts`（复用现有解析，不复制解析器）

**Step 1: 写失败测试 fixture**

测试在临时目录创建：

- `paper-v1.md`，正文含 `版本 1`；
- `paper-2026-08-23-final.md`，正文含同一主题的新结论；
- `experiment-2026-08-24.csv` 与同日期但不同数据的 `experiment-revised.csv`；
- 一个指向临时目录外的 symlink；
- 将旧文件的 `mtime` 改成比新文件更晚，验证 mtime 不能覆盖显式日期/版本信号。

断言：

- 显式版本/日期优先，旧稿为 `superseded` 或 `historical`；
- 同等级且内容冲突的候选为 `conflicted`/`unknown`，不能擅自选 current；
- symlink 越界被拒绝；
- 每条记录都有稳定 SHA-256、大小、mtime（mtime 仅证据字段）和文件定位；
- 文本文件产生有限 excerpt，图片只登记元数据，不把图片 OCR 假设为事实。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-context-service.test.ts
```

Expected: FAIL，因为扫描服务尚不存在。

**Step 3: 实现扫描服务**

导出：

```ts
inspectDeckSources(input: {
  paths: string[]
  agentCwd: string
  allowedRoots: string[]
  maxFiles?: number
  maxBytesPerFile?: number
}): Promise<{ sources: DeckSourceRecord[]; conflicts: string[]; gaps: string[] }>
```

实现约束：

1. 所有路径先 `realpath`，仅允许 `agentCwd` 或 `allowedRoots` 内的普通文件/目录；拒绝目录穿越和越界 symlink。
2. 目录递归默认最多 100 个文件、单文件最多 50 MiB；超限输出 gap，不静默扩大范围。
3. 复用 `isSupportedDocumentExtension` 和 `extractTextFromFile`；图片使用文件头/扩展名登记 `image`。
4. 版本信号按顺序收集：文件名/正文版本号、ISO 日期、`final/latest/最新版/revised/draft/旧稿` 状态词、同组内容覆盖关系；`mtimeMs` 只写入证据，不直接决定状态。
5. 同一组来源按标准化 basename 分组；无法确定新旧时明确返回 `unknown` 或 `conflicted`。
6. 每个来源记录 `contentHash`，供后续页面影响分析；不得把路径字符串当内容哈希。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-context-service.test.ts src/main/lib/ppt-deck-schema.test.ts
```

Expected: 全部 PASS，并且越界文件没有被读取。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/ppt-deck-context-service.ts apps/electron/src/main/lib/ppt-deck-context-service.test.ts
git commit -m "feat(pptx): track source lineage and version status"
```

---

## Task 3：实现两个 Style Pack 注册表与受控预览

**Files:**
- Create: `apps/electron/resources/ppt-style-packs/academic-editorial/pack.json`
- Create: `apps/electron/resources/ppt-style-packs/academic-editorial/preview.webp`
- Create: `apps/electron/resources/ppt-style-packs/profer-cloud-dancer/pack.json`
- Create: `apps/electron/resources/ppt-style-packs/profer-cloud-dancer/preview.webp`
- Create: `apps/electron/src/main/lib/ppt-style-pack-service.ts`
- Test: `apps/electron/src/main/lib/ppt-style-pack-service.test.ts`

**Step 1: 写失败测试**

断言：

- 只能列出两个首发 pack，未知 id 被拒绝；
- pack 具备 `tokens/layoutGrammar/motifs/chartLanguage/imageDirection/narrativeRhythm/qaProfile/preview`；
- `academic-editorial` 使用纸白/墨黑/单强调色、非对称网格、证据标注；
- `profer-cloud-dancer` 使用 `#F0EFEC/#E3E1DC/#312F2A/#846557/#F6F5F2`，云朵/拱形/月牙母题；
- 预览 URL 只能是主进程注册后产生的 `profer-file://<opaque-token>`，不能把绝对路径放进 Markdown。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-style-pack-service.test.ts
```

Expected: FAIL。

**Step 3: 实现最小注册表**

`pack.json` 使用版本化 JSON，不让 Agent 直接传颜色覆盖 Style Pack。首版明确参数：

- 画布 13.333 × 7.5；
- 标题/正文/图注/页码字阶；
- 字体回退链；
- 12-column 网格和安全边距；
- 图表系列色和对比度门槛；
- 每种 `visualRole × densityBudget` 可用的构图候选，以及这些候选应满足的主证据比例、图注/图例可读性和数据编码条件；
- `academic-editorial` 的显式反模式清单：禁止 `kpi_grid`、`card_wall`、`big_number_plus_explanation_cards`、`unreadable_full_paper_figure`；
- 图像密度与焦点规则：密集地图/论文图不得自动等比缩小到不可读，必须采用裁剪、局部放大或换成图表/图解；
- 跨页叙事节奏：相邻内容页不得无条件复用同一构图；
- Cloud Dancer 的原生形状母题频率限制，禁止内容页铺满舞者。

预览读取复用 `registerProferFilePath`：只把随应用打包的固定 `preview.webp` 注册成 opaque `profer-file://` URL。preview 字段继续使用现有 `AskUserQuestionOption.preview` Markdown 字符串，不扩展 Claude/Pi schema，不接受任意本地路径。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-style-pack-service.test.ts
```

Expected: PASS；测试中不能出现真实用户目录路径泄漏。

**Step 5: Commit**

```bash
git add apps/electron/resources/ppt-style-packs apps/electron/src/main/lib/ppt-style-pack-service.ts apps/electron/src/main/lib/ppt-style-pack-service.test.ts
git commit -m "feat(pptx): add academic and cloud dancer style packs"
```

---

## Task 4：实现 Deck Project 持久化、状态机和确认凭据

**Files:**
- Create: `apps/electron/src/main/lib/ppt-deck-project-service.ts`
- Test: `apps/electron/src/main/lib/ppt-deck-project-service.test.ts`
- Modify if needed: `apps/electron/src/main/lib/config-paths.ts`（只增加会话级 deck-project 路径 helper）

**Step 1: 写失败测试**

覆盖：

- `createDeckProject(agentCwd, brief)` 创建 `.context/deck-projects/<deckId>/` 及 `brief.json`、`context-manifest.json`、`source-lineage.json`、`deck-spec.json`、`style-pack.json`、`sources.json`、`assets/`、`src/`、`renders/`、`qa/`、`output/`；
- 项目 ID 只允许小写字母、数字和短横线；路径始终位于当前 session `agentCwd`；
- 初始状态为 `awaiting_confirmation`；未确认的项目调用 `assertDeckCompilable` 必须失败；
- Brief 被确认后写入 `confirmedAt`、`confirmationHash` 和 `confirmedByRequestId`；修改 Brief 后旧 hash 立即失效；
- 读取损坏 JSON、越界 project path 或缺文件时返回结构化错误而非静默创建新项目。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-project-service.test.ts
```

Expected: FAIL。

**Step 3: 实现最小状态机**

导出：

```ts
createDeckProject(input): Promise<DeckProjectManifest>
readDeckProject(projectDir): Promise<DeckProjectSnapshot>
writeDeckSpec(projectDir, spec): Promise<void>
getDeckBriefConfirmationToken(projectDir): Promise<string>
recordDeckBriefConfirmation(input: { projectDir: string; confirmationToken: string; requestId: string }): Promise<void>
assertDeckCompilable(projectDir): Promise<DeckProjectSnapshot>
```

确认 token 使用随机高熵值并只保存 hash；返回给 Agent 的 token 不能被当作文件路径。`recordDeckBriefConfirmation` 必须重新读取 Brief、计算 hash、比较 token hash 和 requestId，防止 Agent 自己把 `confirmed` 写入 JSON 绕过用户确认。写文件采用临时文件 + rename，避免半写 JSON。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-project-service.test.ts src/main/lib/ppt-deck-schema.test.ts
```

Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/ppt-deck-project-service.ts apps/electron/src/main/lib/ppt-deck-project-service.test.ts apps/electron/src/main/lib/config-paths.ts
git commit -m "feat(pptx): persist deck projects with confirmation state"
```

---

## Task 5：把 Deck Brief 确认接入 AskUserQuestion，且保留 Claude/Pi 一致性

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/electron/src/main/lib/agent-ask-user-service.ts`
- Modify: `apps/electron/src/main/lib/agent-ask-user-service.test.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts` only if TypeScript context requires wiring

**Step 1: 写失败测试**

新增测试：

- 普通 AskUserQuestion 行为完全不变；
- 带受控 `proferConfirmation` 元数据的请求，在用户选择“确认 Deck Brief”后，项目服务记录 requestId 和确认 hash；
- 用户选择修改方向、关闭请求或 Abort 时，项目仍为 `awaiting_confirmation`；
- Brief 确认后，Agent 可以调用受管的预览动作打开生成的 `.pptx`；预览必须复用现有 `FilePreviewDialog` / `PptxScrollViewer`，不能新建独立 PPT 工作台；
- 伪造 token、错误 projectDir、重复 requestId 或过期 Brief 不能确认；
- Claude 与 Pi 的 AskUser schema 都接受同一受控字段，但渲染器仍只看到普通问题/选项，不显示内部 token。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/agent-ask-user-service.test.ts src/main/lib/adapters/pi-agent-adapter.test.ts
```

Expected: FAIL。

**Step 3: 实现受控确认**

在 shared 类型和两个 runtime 的 AskUser schema 中增加可选内部字段：

```ts
proferConfirmation?: {
  kind: 'deck-brief'
  projectDir: string
  confirmationToken: string
}
```

`AgentAskUserService.respondToAskUser` 在正常构建 `updatedInput` 前，若存在该字段且用户答案中包含精确的 `确认 Deck Brief`，调用 `recordDeckBriefConfirmation`；失败则返回 deny，不得把普通答案伪装成已确认。`parseQuestions` 不把内部字段放进 renderer 的 `AskUserQuestion`，避免路径或 token 泄漏。

说明：这不是让 Agent 自己判断用户是否确认，而是让主进程在 AskUser 响应边界记录不可伪造的确认收据；编译工具随后只看项目状态和收据。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/agent-ask-user-service.test.ts src/main/lib/adapters/pi-agent-adapter.test.ts
cd ../..
bun run --filter='@profer/shared' typecheck
```

Expected: PASS。

**Step 5: Commit**

```bash
git add packages/shared/src/types/agent.ts apps/electron/src/main/lib/agent-ask-user-service.ts apps/electron/src/main/lib/agent-ask-user-service.test.ts apps/electron/src/main/lib/adapters/pi-agent-adapter.ts apps/electron/src/main/lib/agent-orchestrator.ts
git commit -m "feat(agent): gate deck compilation on brief confirmation"
```

---

## Task 6：实现受管 Deck 工具的领域服务入口

**Files:**
- Create: `apps/electron/src/main/lib/ppt-deck-agent-tools.ts`
- Test: `apps/electron/src/main/lib/ppt-deck-agent-tools.test.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`

**Step 1: 写失败测试**

用 Claude SDK stub 和 Pi SDK stub 各验证：

- 两边都注册相同的六个短名：`inspect_deck_sources`、`create_deck_project`、`import_deck_assets`、`write_deck_spec`、`confirm_deck_brief`、`compile_deck_project`；
- `inspect_deck_sources` 只能读取当前 session 的 `agentCwd + allowedRoots`；
- `create_deck_project` 把来源清单和 Brief 写入项目，但不把状态改成 confirmed；
- `confirm_deck_brief` 只能消费 AskUser 已写入的 receipt；
- `compile_deck_project` 在未确认、来源为 conflicted/unknown 或 schema 无效时拒绝；
- 返回值全部是 JSON 文本，包含 projectDir、state、source statuses 和下一步，不返回隐藏绝对路径之外的未授权路径。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-agent-tools.test.ts
```

Expected: FAIL。

**Step 3: 实现 Claude/Pi 双端薄适配**

底层服务只接收显式 context：`sessionId`、`agentCwd`、`allowedRoots`、`workspaceSlug`。Claude 通过 `injectPptDeckMcpServer` 注册；Pi 通过 `buildPiPptDeckTools` 注册。不要在工具层重新扫描整个 workspace，也不要让 Pi 直接调用 Claude MCP。

工具职责：

- `inspect_deck_sources`：调用 Task 2 服务并返回可供 Agent 追问的证据与缺口；
- `create_deck_project`：调用 Task 4 创建项目，返回 brief confirmation token；
- `confirm_deck_brief`：只做 receipt/state 检查，不能接受 `confirmed: true` 这种布尔绕过；
- `compile_deck_project`：调用 compiler，成功后立即调用结构与 visual-composition 审计并把结果写入 `qa/`；任一审计需要 revision 时不得向 Agent 表述为可交付成品。

兼容保留现有 `plan_ppt_visuals`、`search_open_materials`、`download_open_material`、`audit_ppt_delivery`，不改变旧工具输入输出。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-agent-tools.test.ts src/main/lib/ppt-material-agent-tools.test.ts src/main/lib/adapters/pi-builtin-tools.test.ts
```

Expected: PASS，并证明两运行时短名/参数语义一致。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/ppt-deck-agent-tools.ts apps/electron/src/main/lib/ppt-deck-agent-tools.test.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.ts
git commit -m "feat(agent): expose governed deck project tools"
```

---

## Task 7：加入随应用打包的 PptxGenJS 并建立编译器最小闭环

**Files:**
- Modify: `apps/electron/package.json`
- Modify: `bun.lock`
- Create: `apps/electron/src/main/lib/ppt-deck-compiler.ts`
- Create: `apps/electron/src/main/lib/ppt-layout-engine.ts`
- Create: `apps/electron/src/main/lib/ppt-slide-components.ts`
- Test: `apps/electron/src/main/lib/ppt-deck-compiler.test.ts`

**Step 1: 先写失败测试**

测试用内联 Deck Spec 生成临时 `.pptx`，断言：

- 生成文件是可解压的 OOXML；
- 页面尺寸为 16:9；
- 标题、正文、图表、连接符、表格为原生对象；
- 核心对象携带稳定 `objectName`/`altText`，含 `deckId/slideId/objectId`；
- `slide.addNotes()` 生成完整讲述要点、转场、时长、问题和引用；
- Cloud Dancer 页使用原生几何，不把 `preview.webp` 当满页背景；
- `current` 来源能写入页内短引和 Notes 完整引用；
- `superseded/historical/conflicted/unknown` 来源不能被编译为当前结论证据。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-compiler.test.ts
```

Expected: FAIL。

**Step 3: 安装并锁定依赖**

在 `apps/electron/package.json` 的 `dependencies` 加入 `pptxgenjs: "4.0.1"`，通过仓库根执行：

```bash
cd /d/profer/Profer-main
bun add --cwd apps/electron pptxgenjs@4.0.1
```

若 Bun 版本不接受该参数，手动修改 package.json 后执行 `bun install --frozen-lockfile=false`，并检查 `bun.lock` 只产生 PptxGenJS 及其必要闭包的变化。不要依赖全局 npm 安装。

**Step 4: 实现最小编译器**

`ppt-layout-engine.ts` 不再把 `visualRole` 直接映射为固定模板。它先读取页面 `visualDirection`、真实图片尺寸/密度、数据关系和相邻页面节奏，生成至少两个受约束的构图候选，再由明确规则选择最能支撑 claim 的方案。确定性约束包括：安全边距、字号下限、文本估算高度、图片比例、图例可读性、密度预算、主次比例、跨页布局角色和负面约束。

评分顺序固定改为：**主证据与 claim 的视觉耦合 > 信息层级和数据关系 > 可读性 > 跨页叙事节奏 > 证据完整 > 不越界 > 装饰**。不允许以“安全的 KPI 宫格/卡片墙”换取实现便利。

首版 `ppt-slide-components.ts` 实现这些语义组件：

- `title`；
- `section`；
- `assertion_evidence`；
- `chart`；
- `mechanism_diagram`；
- `comparison`；
- `image_with_annotation`；
- `limitations`；
- `conclusion`；
- `references`；
- `quantitative_ratio`：用点阵、比例条、分组条形图等原生对象表达“分子/分母/漏测”等关系，禁止默认退化为同权 KPI；
- `annotated_evidence`：主图、必要图例、局部放大和原生标注围绕一个观察结论组织；
- `causal_chain`：原因、机制、适用边界沿一条阅读链组织，禁止拆成同权彩色卡片墙。

`ppt-deck-compiler.ts` 创建 PptxGenJS 实例、设置 layout、应用 Style Pack、生成原生对象、写 Notes、输出到 project `output/`。每个对象都由语义 ID 命名；不使用 shape group，不把整页 SVG/PNG 当内容层。编译器必须把最终选择的构图、素材裁剪/contain 决策、主证据对象和版式风险写入 `qa/visual-composition.json`，供用户与后续视觉模型复盘。

支持“局部重编译”的第一版实现为：重新读取完整 Deck Spec，仅重用未变化页面的 `compiledSlideCache` 元数据和素材哈希；若 PptxGenJS 无法安全拼接 slide，则生成完整新包但只重新计算受影响页，并在 QA 中记录 `recompiledSlideIds`。不要为了伪造局部修改直接手改 OOXML。

**Step 5: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-deck-compiler.test.ts
bun run typecheck
```

Expected: PASS；typecheck 不能依赖全局 `pptxgenjs` 类型。

**Step 6: Commit**

```bash
git add apps/electron/package.json bun.lock apps/electron/src/main/lib/ppt-deck-compiler.ts apps/electron/src/main/lib/ppt-layout-engine.ts apps/electron/src/main/lib/ppt-slide-components.ts apps/electron/src/main/lib/ppt-deck-compiler.test.ts
git commit -m "feat(pptx): compile semantic deck specs to native pptx"
```

---

## Task 8：升级结构审计为来源、可编辑性和布局门禁

**Files:**
- Modify: `apps/electron/src/main/lib/ppt-delivery-audit-service.ts`
- Modify: `apps/electron/src/main/lib/ppt-delivery-audit-service.test.ts`
- Create: `apps/electron/src/main/lib/ppt-oo-xml-audit.ts`
- Test: `apps/electron/src/main/lib/ppt-oo-xml-audit.test.ts`

**Step 1: 写失败测试**

新增内联/真实生成 OOXML fixture，覆盖：

- 页数和视觉计划不一致；
- 文本框超出 13.333 × 7.5；
- 文字对象没有 semantic object name；
- 需要原生 chart 的页只有一张 chart 图片；
- 页内引用 hash 与 `source-lineage.json` 不匹配；
- Notes 缺少完整引用或讲述要点；
- E0/E1 整页图片占比过高时报告 `editabilityCoverage` 和 P1 issue；
- Cloud Dancer 内容页使用满页 preview 图片时阻断；
- 合法的图片素材不会被误报为非可编辑对象，因为图片是允许的例外。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-oo-xml-audit.test.ts src/main/lib/ppt-delivery-audit-service.test.ts
```

Expected: FAIL。

**Step 3: 实现确定性审计**

`ppt-oo-xml-audit.ts` 使用 AdmZip 读取：

- slide XML 的 `p:sp/p:pic/p:graphicFrame/p:cxnSp`；
- chart XML、media、notesSlides；
- objectName/altText；
- EMU 坐标、尺寸和文本节点；
- project 的 source hashes 与 deck metadata。

输出统一 `PptIssue`：`code`、`severity(P0|P1|P2)`、`slideId`、`objectId`、`message`、`suggestedFix`。最低结构门禁：P0/P1 未清零时 `needsRevision=true`；统计 `editableObjectCount`、`allowedImageCount`、`editableCoverage`，但不把“有形状”当成审美通过。

同时新增确定性 `visualCompositionAudit`，输出独立字段 `needsVisualRevision` 和 `visualIssues`。它不是伪装成视觉模型，而是明确阻断已验证的低质量退化模式：KPI 宫格、卡片墙、大数字替代数据关系、主视觉不可读、无效留白、主证据层级不足、相邻页构图重复、颜色没有承担信息关系。其结果必须与结构审计并列呈现；结构 PASS 不得覆盖视觉 FAIL。

保留 `planPptVisuals` 和现有审计字段，新增字段采用可选形式，确保历史工具调用结果可读。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-oo-xml-audit.test.ts src/main/lib/ppt-delivery-audit-service.test.ts
```

Expected: PASS；旧的 shapes-only / real-image / chart fixture 仍保持原有行为。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/ppt-delivery-audit-service.ts apps/electron/src/main/lib/ppt-delivery-audit-service.test.ts apps/electron/src/main/lib/ppt-oo-xml-audit.ts apps/electron/src/main/lib/ppt-oo-xml-audit.test.ts
git commit -m "feat(pptx): add structural editability and lineage gates"
```

---

## Task 9：注册编译/审计工具、升级双运行时 Skill 指令和资源打包

**Files:**
- Modify: `apps/electron/src/main/lib/ppt-material-agent-tools.ts`
- Modify: `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts`
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`
- Modify: `apps/electron/src/main/lib/agent-prompt-builder.ts`
- Modify: `apps/electron/default-skills/pptx/SKILL.md`
- Modify: `apps/electron/default-skills/pptx/.source.json` if present and required by repo convention
- Modify: `apps/electron/electron-builder.yml`
- Modify: `apps/electron/scripts/copy-resources.ts` only if resource copy is not covered by existing resource path
- Modify: `apps/electron/src/main/lib/ppt-style-pack-service.ts` if packaged path needs a test override
- Test: `apps/electron/src/main/lib/ppt-material-agent-tools.test.ts` (create if absent)
- Test: `apps/electron/src/main/lib/agent-prompt-builder.test.ts`
- Test: `apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts`

**Step 1: 写失败测试**

验证：

- Claude/Pi 都出现 `inspect_deck_sources/create_deck_project/import_deck_assets/write_deck_spec/confirm_deck_brief/compile_deck_project`；
- 提示词只在实际工具可用时要求新工具；
- PPT Skill 明确：先 inspect → 动态追问 → Brief → 用户确认 → 素材导入 → 含 `visualDirection` 的 Deck Spec → compile → visual-composition/结构 audit → PowerPoint render；
- Prompt 明确要求先做视觉策划和数据编码选择，禁止把 `visualRole` 直接翻译为 KPI 宫格或卡片墙；
- 默认 Skill 版本 bump（例如 `1.0.2 → 1.1.0`）；
- Packaged resource path 使用 `process.resourcesPath/ppt-style-packs`，dev path 使用 `__dirname/resources/ppt-style-packs`；
- electron-builder 的 `extraResources` 包含 `ppt-style-packs`；
- Pi schema 和 Claude Zod schema 的字段一致。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-material-agent-tools.test.ts src/main/lib/agent-prompt-builder.test.ts src/main/lib/adapters/pi-builtin-tools.test.ts
```

Expected: FAIL。

**Step 3: 实现双端注册与 prompt**

可以将新工具和旧 PPT 素材工具放在同一 `ppt-materials` MCP server，但必须保证 Pi `defineTool` 逐个注册并复用同一 service；不要只改 Claude。

`agent-prompt-builder.ts` 增加简短、运行时中立的指令：

1. 多页学生 PPT 先 `inspect_deck_sources`；
2. 先处理 current/superseded/historical/conflicted/unknown，不得混用旧稿和最新版；
3. 创建 Brief 项目后必须 AskUserQuestion，确认收据存在才允许 compile；
4. 每页必须有 claim/evidence/visualRole；
5. compile 后必须 audit，P0/P1 修复后再交付；
6. 编译成功后把 PPTX 注册/交给当前 Agent 对话的文件预览链路，使用现有 `FilePreviewDialog` / `office-preview/silurus-bridge.ts` 的 `PptxScrollViewer` 打开；用户或 Agent 可回到同一对话指定“修改第 N 页”。
7. 在 Windows 有 PowerPoint COM 时把 PNG 和 QA JSON 写入 project `renders/qa/`；COM 不可用时仍必须保留 Agent 内置 PPTX 预览作为首选预览路径。

更新 bundled PPT Skill 的版本和内容，但不要修改工作区用户已自定义的 Skill 副本。默认 Skill 同步规则会保护用户改动。

`electron-builder.yml` 增加：

```yaml
  - from: resources/ppt-style-packs
    to: ppt-style-packs
    filter:
      - "**/*"
```

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-material-agent-tools.test.ts src/main/lib/agent-prompt-builder.test.ts src/main/lib/adapters/pi-builtin-tools.test.ts
bun run typecheck
bun run build:main
bun run build:resources
```

Expected: PASS；`dist/resources/ppt-style-packs/` 和 `dist/main.cjs` 存在。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/ppt-material-agent-tools.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-prompt-builder.ts apps/electron/default-skills/pptx apps/electron/electron-builder.yml apps/electron/scripts/copy-resources.ts apps/electron/src/main/lib/ppt-material-agent-tools.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts
git commit -m "feat(agent): wire governed student pptx workflow"
```

---

## Task 10：建立学生 fixture、渲染 QA 和一次修订闭环

**Files:**
- Create: `apps/electron/src/main/lib/ppt-fixtures/student-lab-meeting/brief.json`
- Create: `apps/electron/src/main/lib/ppt-fixtures/student-lab-meeting/context-manifest.json`
- Create: `apps/electron/src/main/lib/ppt-fixtures/student-lab-meeting/source-lineage.json`
- Create: `apps/electron/src/main/lib/ppt-fixtures/student-lab-meeting/deck-spec.json`
- Create: `apps/electron/src/main/lib/ppt-fixtures/student-lab-meeting/expected.json`
- Create: `apps/electron/scripts/verify-student-pptx-fixture.ts`
- Test: `apps/electron/src/main/lib/ppt-fixtures/student-lab-meeting/fixture.test.ts`

**Step 1: 先写 fixture 失败测试**

fixture 必须包含：

- 一份论文/实验说明 current 资料；
- 一份显式标记 superseded 的旧结果；
- 一页 mechanism diagram；
- 一页带真实数据的原生 chart；
- 一页实验截图图片例外；
- 一页结论和引用 Notes；
- 一条不会被误用的旧数据；
- 一张细节密集的论文地图/实验图，用于验证“主图 + 局部放大/标注”而不是缩小原图 + KPI 宫格；
- 一组 `17 / 22 / 5` 类的分子分母结果，用于验证原生比例/点阵/条形编码而不是大数字卡与解释卡墙；
- 至少三张连续结果页，用于验证“位置证据 → 量化结果 → 漏测机制/边界”的跨页镜头节奏。

断言：

- 旧数据不出现在 current claim 的 evidenceRefs；
- 页数、主视觉角色和 Notes 数量符合 expected；
- 语义级对象覆盖率目标 ≥90%（图片例外单独计数）；
- P0/P1 初始 fixture 可以人为构造至少一个问题，修订 spec 后只影响对应 slideId。

**Step 2: 运行失败测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-fixtures/student-lab-meeting/fixture.test.ts
```

Expected: FAIL。

**Step 3: 实现验证脚本**

`verify-student-pptx-fixture.ts`：

1. 创建临时 project 或读取 fixture；
2. 运行 compiler；
3. 运行 structural audit；
4. 写 `qa/structural.json`；
5. 调用 Windows PowerPoint COM 脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/electron/default-skills/pptx/scripts/office/pptx2png.ps1 -InputPath <project>/output/student-lab-meeting.pptx -OutDir <project>/renders
```

6. 用 PNG 尺寸、数量、空白页、主色占比、最大证据对象占比、最小图例/图注字号、卡片数量、同权数字数量、相邻页构图相似度等确定性信号，确认渲染未崩溃且没有命中已知低质量模板；输出 `qa/visual-composition.json`；
7. 当前渠道不能看图时，只输出需要用户人工审阅的 montage/render 路径和明确的 `visualReview: unavailable`，不声称完成视觉模型评审；
8. 人为修复一个页级视觉或结构 issue，再只重编译该 slideId，重新审计，记录 `qa/fix-round-1.json`。

必须检查 PowerPoint 打开无修复提示；若 COM/Office 在环境不可用，报告 `renderUnavailable`，不能伪造通过。

**Step 4: 运行通过测试**

```bash
cd /d/profer/worktrees/student-pptx-v1/apps/electron
bun test --isolate src/main/lib/ppt-fixtures/student-lab-meeting/fixture.test.ts
bun run scripts/verify-student-pptx-fixture.ts
```

Expected: 结构审计 PASS；Windows 有 Office 时生成 `renders/slide-*.png`，至少有一次 fix-and-verify；Coverage ≥90%。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/ppt-fixtures apps/electron/scripts/verify-student-pptx-fixture.ts
 git commit -m "test(pptx): add student fixture and render verification"
```

---

## Task 11：版本、工作区 Skill 同步和最终回归

**Files:**
- Modify: `packages/shared/package.json`（按仓库版本策略 bump patch）
- Modify: `apps/electron/package.json`（按仓库版本策略 bump patch）
- Modify: `apps/electron/default-skills/pptx/SKILL.md`（若 Task 9 未完成）
- Create: `docs/plans/2026-08-24-student-pptx-v1-acceptance.md`

**Step 1: 写失败验收检查**

验收脚本/命令必须能发现：

- 缺少 PptxGenJS 应用依赖；
- 打包后缺少 `ppt-style-packs`；
- Claude/Pi 工具数量或 schema 不一致；
- default Skill version 没有 bump；
- 未确认 Brief 仍能编译；
- current 证据引用缺 hash；
- PPTX 没有 Notes/原生图表/semantic object names。

**Step 2: 运行完整回归**

在 worktree 根执行：

```bash
bun run --filter='@profer/shared' typecheck
bun run --filter='@profer/electron' typecheck
bun test --isolate apps/electron/src/main/lib/ppt-deck-schema.test.ts apps/electron/src/main/lib/ppt-deck-context-service.test.ts apps/electron/src/main/lib/ppt-style-pack-service.test.ts apps/electron/src/main/lib/ppt-deck-project-service.test.ts apps/electron/src/main/lib/agent-ask-user-service.test.ts apps/electron/src/main/lib/ppt-deck-agent-tools.test.ts apps/electron/src/main/lib/ppt-deck-compiler.test.ts apps/electron/src/main/lib/ppt-oo-xml-audit.test.ts apps/electron/src/main/lib/ppt-delivery-audit-service.test.ts apps/electron/src/main/lib/adapters/pi-builtin-tools.test.ts apps/electron/src/main/lib/agent-prompt-builder.test.ts
bun run --filter='@profer/electron' build:main
bun run --filter='@profer/electron' build:preload
bun run --filter='@profer/electron' build:renderer
bun run --filter='@profer/electron' build:cli
bun run --filter='@profer/electron' build:resources
```

Expected: 全部 PASS；不得只跑新增测试而跳过 typecheck/build。

**Step 3: 运行打包探针**

如果安装包环境可用：

```bash
bun run --filter='@profer/electron' sync:runtime-deps
bun run --filter='@profer/electron' pack
bun run --filter='@profer/electron' verify:packaged-pi-runtime
```

另检查 `dist/resources/ppt-style-packs` 或 unpacked app 的同等资源目录和 `node_modules/pptxgenjs`。

**Step 4: 写验收记录**

`docs/plans/2026-08-24-student-pptx-v1-acceptance.md` 必须记录：

- 运行环境、commit、依赖版本；
- 每条测试命令及真实结果；
- 生成 PPTX 路径；
- COM 渲染是否可用；
- 结构审计 JSON；
- 一次修订前后受影响 slideId；
- 视觉策划与 visual-composition 审计结果；
- 哪些页面由用户人工审阅，哪些（若能力可用）经过视觉模型复盘；
- 未完成项和风险：视觉模型未启用、Cloud Dancer 未分组、竞品盲评未自动化等。

**Step 5: Commit**

```bash
git add packages/shared/package.json apps/electron/package.json docs/plans/2026-08-24-student-pptx-v1-acceptance.md
git commit -m "docs(pptx): record v1 acceptance evidence"
```

---

## Task 12：合并前检查与交付边界

**Files:**
- No product source changes expected in this task.
- Read: `D:\profer\Profer-main` main worktree status.

**Step 1: 检查功能 worktree 只包含本功能提交**

```bash
cd /d/profer/worktrees/student-pptx-v1
git log --oneline --decorate -20
git diff main...HEAD --stat
git status --short
```

Expected: 只包含设计文档、PPTX 功能、测试和验收记录；没有三个用户 UI 文件。

**Step 2: 检查主工作树未被污染**

```bash
git -C D:/profer/Profer-main status --short --branch
git -C D:/profer/Profer-main diff -- apps/electron/src/renderer/components/agent/RuntimeProcessPanel.tsx apps/electron/src/renderer/components/settings/SettingsPanel.tsx apps/electron/src/renderer/components/tabs/MainArea.tsx
```

Expected: 主工作树原有改动仍在，未被功能分支操作改写。

**Step 3: 交付说明必须诚实区分**

最终交付时分别报告：

- 已通过的结构/类型/构建/COM 证据；
- 未执行或不可执行的视觉模型评审；
- 允许为图片的对象与真正原生对象的比例；
- 当前版本不支持的分组、脱离 Agent 对话的独立工作台和盲评自动化；
- Agent 对话内的 PPTX 预览已作为首版必做能力，并复用现有 Office/Silurus 预览；
- 如何从 `deck-project/` 修改某页并重新编译。

**Step 4: 交付用户选择**

计划完成后提供两种执行方式：

1. 当前会话按任务逐步执行，每个任务先测后改、每个阶段 review；
2. 新会话读取本计划，使用 executing-plans 按任务执行并在阶段点回报。

不要在没有用户选择时偷偷启动大规模实现。

---

## Agent 对话内预览与修订闭环

首版不做脱离 Agent 对话的独立 PPT 工作台，但必须利用现有内置预览能力完成以下闭环：

1. `compile_deck_project` 生成并持久化 `output/<name>.pptx`；
2. 工具结果返回当前会话可访问的 PPTX 路径/附件信息和 `projectDir`，不返回未授权路径；
3. Agent 在同一对话中调用现有文件预览入口打开 `.pptx`，渲染器根据扩展名进入 `office` 状态；
4. `OfficePreview` 通过 `PptxScrollViewer` 加载 PPTX，失败时由主进程 `convertOfficeToHtml()` 提供文本结构化兜底；
5. Agent 根据 `audit_ppt_delivery` 的结构 issue、来源 QA 和用户预览反馈，只修改对应 `slideId`；
6. 编译后刷新同一预览文件，不能另起独立工作台或把页面截图当最终交付；
7. 测试至少覆盖 `.pptx` 被路由到 office preview、预览失败时 HTML fallback、修改一页后 project/output/qa 更新。

**验证文件：**

- `apps/electron/src/renderer/components/file-browser/FilePreviewDialog.tsx`
- `apps/electron/src/renderer/components/file-browser/office-preview/silurus-bridge.ts`
- `apps/electron/src/main/lib/file-preview-service.ts`
- `apps/electron/src/main/lib/file-preview-service.test.ts`
- `apps/electron/src/preload/index.ts`

---

## 质量门槛与完成定义

首个纵向版本只有在以下条件同时满足时才算完成：

1. `inspect → brief → user confirmation → compile → audit` 主链路存在硬门禁；
2. current/superseded/historical/conflicted/unknown 的来源状态可持久化且可追溯；
3. Claude/Pi 工具契约一致；
4. PptxGenJS 随应用依赖存在，不依赖全局 npm；
5. 每页在编译前均有主证据、构图、数据编码、焦点和负面约束；`visualRole` 不得单独退化为固定模板；
6. 生成 PPTX 能在 PowerPoint 打开，Notes 存在，核心文本/图表/形状为原生对象；
7. Cloud Dancer 以可编辑几何转译，不用主题图整页铺底；
8. 结构 QA P0/P1 清零，且 visual-composition 审计不包含 KPI 宫格、卡片墙、不可读主图或无数据关系的大数字等 P1 视觉问题；
9. 语义级可编辑覆盖率目标 ≥90%；
10. 至少完成一次按 `slideId` 的视觉或结构修订后再审计；
11. 所有失败、不可用工具和视觉判断边界写入验收记录；
12. 主工作树无关未提交改动完整保留。


