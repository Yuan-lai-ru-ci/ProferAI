# Profer 学生 PPTX 生成系统设计

> 日期：2026-08-24
> 状态：产品与架构方向已由用户逐段确认
> 首要场景：学生组会汇报、日常课程作业
> 核心目标：在保持语义级可编辑 `.pptx` 的前提下，把美感、叙事和上下文理解做到市面 Agent 前列

## 1. 背景与已验证基线

Profer 已具备真 `.pptx` 生成所需的大部分执行能力：`pptxgenjs`、`python-pptx`、高级图表、渐变素材、本机 PowerPoint COM 渲染、开放许可图片、GPT Image、逐页视觉计划和 `audit_ppt_delivery` 门禁。

当前问题不是“能否生成文件”，而是缺少一个稳定的审美与叙事编译层：

- `plan_ppt_visuals` 只按少量关键词把页面分成图片、图表、图解或数据大字；
- `audit_ppt_delivery` 主要统计 OOXML 里的图片、图表、形状和文本，不能判断层级、节奏、构图与风格漂移；
- Agent 仍可能临场写坐标代码，结果高度依赖模型当次发挥；
- 工作区文件、长期记忆、材料新旧版本和用户真实目的没有被收敛成生成合同；
- 已做过的原生 Swiss 样张和布局引擎仍是历史会话资产，没有产品化为可扩展内核。

OpenAI 2026-03 曾开源、2026-04 又删除的 curated Slides Skill 强在布局 helper、字体检测、越界检测、渲染与 montage，但没有解决上下文融合、跨页叙事、风格辨识和学生场景。Profer 应吸收工程护栏思想，不把其当作设计系统照搬。

## 2. 已确认的产品决策

1. 首发用户是学生，优先覆盖组会与课程作业，美感优先。
2. 从 Agent 原生对话流启动，不先建设独立 PPT 工作台。
3. 先读取用户需求、工作区相关文件和长期记忆，再进行动态多轮追问。
4. 追问完成后展示 Deck Brief，由用户一键确认后才开工。
5. 工作区与记忆优先；材料不足时定向联网补缺，并保留来源。
6. 必须区分资料新旧版本，建立来源谱系；冲突无法自动裁决时追问。
7. 输出采用语义级可编辑标准：文字、图表、表格、流程、云朵几何、装饰和页码为原生对象；照片、论文原图、实验截图和纹理可为图片。
8. 首发两个独立 Style Pack：`academic-editorial` 与 `profer-cloud-dancer`，并建立可扩展框架。
9. 风格由系统智能推荐，并在 Brief 选择中显示固定视觉缩略图。
10. 默认质量优先，允许 2–3 轮自动修订，只重编译问题页。
11. 必须维护可持续编辑的 Deck Project，而非只交付 `.pptx`。
12. 页内使用短引，Speaker Notes 保存完整引用，结尾自动生成参考文献页。
13. Speaker Notes 默认生成讲述要点、自然转场、建议时长和潜在追问，不写机械逐字稿。
14. PPT 能力默认不注入普通 Agent 会话：PPT 专用工具与 PPT 专用提示词只在当前会话通过能力激活门禁后出现。
15. 能力激活采用“高置信意图自动进入、低置信意图先询问、用户明确退出可关闭”的会话级状态；激活不等于允许生成，Brief 确认仍是编译门禁。

## 3. 总体架构

```text
User Request
    ↓
Context Fusion
    ├─ workspace / attachments / project rules
    ├─ long-term memory
    ├─ source lineage and freshness
    └─ targeted web research for explicit gaps
    ↓
Dynamic Clarification State Machine
    ↓
Deck Brief (user confirms)
    ↓
Deck Spec
    ↓
Style Router ── Style Pack Registry
    ↓
Semantic Layout Compiler
    ↓
Editable PPTX Backend
    ↓
Real PowerPoint Render
    ↓
Structural + Content + Visual QA
    ↓
Targeted Revision (2–3 rounds)
    ↓
PPTX + persistent Deck Project
```

首版不新建脱离 Agent 对话的独立 PPT 工作台。Skill 是流程导演，Profer 内置工具承担确定性扫描、项目初始化、编译和审计，Agent 负责理解、追问、Deck Spec 与修订决策；生成的 PPTX 必须在当前 Agent 对话流中调用 Profer 现有 Office/Silurus 内置预览直接打开，用户和 Agent 以预览、结构审计和来源 QA 为依据继续修改。首版闭环为：`Agent 对话 → 能力激活门禁 → inspect/追问 → Brief → 用户确认 → 生成 PPTX → 内置 PPTX 预览 → 审计/问题页 → Agent 定向修订 → 刷新预览`。普通非 PPT 消息不携带 PPT 专用工具和长提示词。

## 4. PPT 能力激活门禁

PPT 能力是会话级按需能力，不是所有 Agent 会话的默认能力。门禁分成“能力是否出现”和“是否允许编译”两层：

### 4.1 能力激活层

默认状态为 `inactive`。普通会话不注入：

- `search_open_materials`、`download_open_material`、`plan_ppt_visuals`、`audit_ppt_delivery` 以及 Deck Project/Compiler 工具；
- PPT 专用系统提示词、视觉门禁和学生 PPT Skill 的长 SOP；
- PPT 专用来源上下文和风格注册表。

以下高置信意图自动激活当前会话：

- 用户明确提到 `.pptx`、PPT、幻灯片、演示文稿、slides、presentation，并伴随创建/修改/生成/导出/预览等动作；
- 用户明确要求组会、课程汇报、课件或演示稿，并要求生成文件；
- 当前会话已有 active Deck Project，用户说“修改第 N 页”“继续这个 deck”“打开预览”等延续指令。

只有“PPT”作为无关文件名、代码变量或普通名词出现时不自动激活。无法达到高置信度时，Agent 先用普通 AskUserQuestion 询问是否进入 PPT 工作流；用户选择否时保持 inactive。

激活状态保存在当前 Agent session metadata 中，后续“修改第 N 页”等短指令继续使用已激活能力。用户明确说“退出 PPT 模式”“不要继续做 PPT”时关闭能力；关闭不会删除已有 Deck Project。新会话默认重新为 inactive，除非用户明确打开已有项目并触发新的激活判断。

### 4.2 生成执行层

能力激活后仍不能直接生成：

```text
inactive
  ↓ 高置信意图 / 用户确认
active（PPT 工具和提示词出现）
  ↓ inspect + 版本治理 + 动态追问
Deck Brief
  ↓ 用户确认收据
Deck Spec
  ↓ compile_deck_project 硬检查
PPTX → audit → 内置预览 → 按页修订
```

`compile_deck_project` 只接受主进程确认收据和 current 来源映射，不能由 Agent 自己写 `confirmed: true` 绕过用户。

### 4.3 双运行时一致性

Claude 和 Pi 使用同一个 `ppt-capability-gate` 纯函数与会话状态：

- Claude：只有 active 时注入 PPT MCP server；
- Pi：只有 active 时注册 PPT custom tools；
- 两者只有 active 时注入 PPT 提示词；Pi 的低频提示词还必须同时检查实际工具存在；
- 图片生成/发送、浏览器、通用文件预览等非 PPT 能力不受此门禁误伤。

## 5. Context Fusion 与材料版本谱系

### 4.1 三级读取漏斗

Context Fusion 不做全盘读取：

1. 目录、元数据与文件类型扫描；
2. 相关文件摘要与结构提取；
3. 对命中页面、段落、工作表、图片或数据片段深读。

输出 `context-manifest.json`，记录用户要求、相关材料、可用视觉、长期记忆、外部来源、冲突和缺口。

### 4.2 新旧版本不是按 mtime 猜测

每份来源标记为：

- `current`：确认采用的当前版本；
- `superseded`：已被新版替代，仅用于理解演进；
- `historical`：可用于复盘或前后对比；
- `conflicted`：数据或结论与其他材料冲突；
- `unknown`：证据不足，必须追问。

判断依据按优先级综合：

1. 文件名、文档正文中的显式日期、版本号、批次或状态；
2. 内容覆盖关系、数据周期和结论变化；
3. Git 历史、导出源和引用关系；
4. 用户确认与长期记忆；
5. 修改时间，仅作为辅助证据。

每条论点、图表和图片绑定具体来源版本、定位信息与 SHA-256。后续来源变化时可指出受影响页面，而不是整套无差别重做。

## 6. 动态追问与 Deck Brief

追问不是固定六题表单。系统维护五个置信维度：

- 任务目标；
- 受众与场合；
- 内容边界；
- 证据完整度；
- 视觉偏好。

每轮只问信息增益最高的问题。关键事实冲突、导师/老师评价重点未知、页数与时长不匹配、证据不足或风格与场合有风险时必须继续追问。关键维度达到阈值，或新增回答不再改变 Brief，才停止。通常 3–6 轮，复杂任务可更多。

Deck Brief 是用户确认的任务合同，展示：

- 受众、场合、时长、目标与评价标准；
- 核心论点与预计页数；
- 采用、排除、历史对比和冲突材料；
- 外部研究范围；
- 推荐 Style Pack、理由与视觉缩略图；
- 引用与 Speaker Notes 策略；
- 仍存在的假设。

用户确认后才创建可编译 Deck Spec。

## 7. Deck Project 与 Deck Spec

默认项目位于会话级工作台：

```text
.context/deck-projects/<deck-id>/
├── brief.json
├── context-manifest.json
├── source-lineage.json
├── deck-spec.json
├── style-pack.json
├── sources.json
├── assets/
├── src/
├── renders/
├── qa/
└── output/<name>.pptx
```

用户明确要长期维护时，再提升到工作区共享目录。生成完成后，Agent 必须把 PPTX 注册为当前会话可预览文件，并通过现有 `FilePreviewDialog` / `PptxScrollViewer` 打开；预览不是独立工作台，而是 Agent 对话中的交付与修订界面。

`deck-spec.json` 是编译器合同。每页至少包含稳定 `slideId`、结论、证据引用、视觉角色、布局意图、密度预算、可编辑对象、Speaker Notes、引用与置信度。无结论、无证据映射、无主视觉角色的页面不得编译。

```json
{
  "slideId": "method-02",
  "claim": "该方法通过双阶段检索降低误差",
  "evidenceRefs": ["paper.pdf#p6.fig2", "notes.md#实验复现"],
  "visualRole": "mechanism_diagram",
  "layoutIntent": "editorial_split",
  "densityBudget": "medium",
  "editableObjects": ["text", "diagram", "citation"],
  "speakerNotes": ["先解释检索瓶颈", "再用图示说明两阶段路径"],
  "confidence": 0.91
}
```

## 8. Style Pack 框架

Style Pack 不是换色皮肤，而是可执行设计契约：

- `tokens`：画布、字体回退链、字阶、网格、间距、线宽、圆角；
- `layoutGrammar`：`visualRole × densityBudget` 可用的参数化版式；
- `motifs`：可编辑品牌图形与使用频率；
- `chartLanguage`：系列配色、标签、坐标轴与结论注释；
- `imageDirection`：图片类型、比例、裁切与处理；
- `narrativeRhythm`：跨页明暗、疏密与章节换气；
- `qaProfile`：该风格独有的禁用项和阈值；
- `preview`：Brief 中显示的固定缩略图。

### 7.1 Academic Editorial

建议基底：纸白 `#F7F5F0`、墨黑 `#17191C`，搭配单一深红或学科定向强调色。强调长标题、图注、边注、证据编号、非对称网格和科研图主体。像高水平期刊专题与研究海报，而不是商务粗黑卡片。

### 7.2 Profer Cloud Dancer

沿用真实 Profer 皮肤基因：内容底 `#F0EFEC`、框架灰 `#E3E1DC`、墨色 `#312F2A`、陶粉棕约 `#846557`、卡片白 `#F6F5F2`。将圆、半圆、拱形、月牙、云团和舞者轮廓转译为原生可编辑形状。舞者集中用于封面、章节和结尾；内容页仅保留局部云形、水印与柔和容器，禁止把竖向皮肤预览直接拉伸成背景。

## 9. 语义级布局编译器

编译器采用 TypeScript/PptxGenJS 主引擎，复用现有 Python 高级图表能力。PptxGenJS 作为应用依赖随 Profer 打包，不依赖学生电脑全局安装。Speaker Notes 使用已验证的 `slide.addNotes()`。

页面先进入语义组件族，例如研究问题、机制图、证据图表、论文图解读、方法比较、局限讨论等。每个组件族有多个参数化候选。布局求解器结合字数、图片比例、系列数、Style Pack 语法和前后页节奏打分。

约束优先级：

```text
不越界 > 可读性 > 证据完整 > 视觉层级 > 风格装饰
```

禁止用无限缩小字号掩盖内容过载。超出密度预算时优先改写、拆页或换视觉结构。

PptxGenJS 当前不原生支持 Shape Group；首版以稳定对象名和 `altText` 绑定语义 ID。Cloud Dancer 需要真正的 PowerPoint 分组时，可在写出后通过受测试的 OOXML 后处理器或 python-pptx 1.0.2 `add_group_shape()` 补齐，但该能力不能阻塞首个纵向版本。

## 10. QA 与自动修订

### 9.1 四层 QA

1. 文件与可编辑性：可无修复提示打开、字体可用、无越界和意外重叠，核心对象保持原生，Speaker Notes 完整。
2. 内容与来源：论点、数字、图表和科研图绑定当前版本材料；旧数据混入或事实不一致时阻断交付。
3. 渲染式视觉：优先通过 Profer 现有 PPTX Office/Silurus 内置预览查看真实页面；在 Windows 有 PowerPoint COM 时额外导出 PNG，检查字号、边距、对比度、密度、裁切、视觉重心、重复版式与风格漂移。
4. 定向修订：输出结构化 issue code，回到 Deck Spec 或 Style Adapter 修订，仅重编译问题页。

首版程序化门禁必须确定性生效；视觉模型评审仅在当前渠道确实支持图片输入时启用，不得假装看过图片。无视觉模型时仍要生成 montage，并明确由程序化指标和用户人工预览兜底。

### 9.2 交付门槛

- 至少完成一次“发现问题 → 修复 → 再验证”循环；
- 最多自动修订三轮；
- P0/P1 问题未清零不得交付；
- 审计报告必须落到 Deck Project 的 `qa/`。

## 11. 竞品盲评

建立四组固定 fixture：论文组会、实验进展、课程案例、跨版本资料混合。每组包含新旧材料、冲突数据、rubric、历史偏好和视觉素材。

同题生成主要竞品结果并匿名化，做两两盲评。指标：第一眼美感、信息清晰度、叙事、学术可信度、来源忠实度、可编辑性、真实可讲性。

首阶段目标：

- 主要竞品美感盲评胜率不低于 65%；
- 严重排版与事实错误为 0；
- 语义级可编辑对象覆盖率不低于 90%。

## 12. 分期

### Phase 0：基准与事实底座

建立 fixture、rubric、当前 Profer 基线和竞品匿名样本。

### Phase 1：Context Fusion 与 Deck Project

实现相关材料扫描、新旧版本谱系、动态追问、Brief 确认和 Deck Project schema。

### Phase 2：首个纵向黄金链路

实现 TypeScript/PptxGenJS 编译器、两个 Style Pack 和学生场景十类核心页面，输出真可编辑 PPTX。

### Phase 3：QA 与自动修订

升级项目级审计、真实 PowerPoint 渲染、结构化 issue 与局部重编译。

### Phase 4：盲评驱动扩展

达到质量门槛后再扩学科风格与版式，不以风格数量代替质量。

首个可运行纵向版本合并 Phase 0–2，并保留最小 QA 门禁；完整 2–3 轮视觉修订在 Phase 3 补强。

## 13. 非目标

- 不做整页图片生成后伪装成可编辑 PPT；
- 不先做脱离 Agent 对话的独立 PPT 编辑工作台；Agent 对话内的 PPTX 预览属于首版必做交付链路；
- 不无差别读取整个工作区；
- 不把 mtime 当唯一版本依据；
- 不把“有图片、有图表”误判为审美优秀；
- 不在首版追求大量 Style Pack；
- 不直接修改用户已有未提交的 UI 工作。
