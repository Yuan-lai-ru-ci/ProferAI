---
name: present-visualization
description: 会话内可视化（present_visualization）手册：何时该画、选哪种形式（原生图表 / 受约束片段 / 带状态的交互）、片段与状态的写法（含 LaTeX 公式）、如何更新。用户要图表、图示、流程图、关系图、对比视图、可调参的解释，或要讲解/演示一个过程时用。用户常这么说：柱状图、分组柱状图、条形图、折线图、饼图、散点图、趋势图、分布图、占比图、对比图、示意图、结构图、画个图、做成图、可视化一下、动画演示、过程演示、模拟一遍、一步步讲、分步看、看懂原理、参数可调；英文常见说法：chart、bar chart、line chart、pie chart、scatter plot、diagram、flowchart、visualization、visualize、visualisation、visualise、explain how、walk me through、step by step、step-by-step、tutorial、teach me、simulate、simulation、animate、animation、interactive explanation、visual explanation、latex。也常说：曲线图、画一张图、交互视图、交互式视图、讲清楚、讲一下、推导、教学、入门、看明白、拆解、可调参数、数学公式。数值对比用 chart，不要用 markdown 表格或 ASCII 图；但普通信息列表（配置项、参数说明）继续用 markdown 表格。
group: profer
---

# 会话内可视化

你负责把「解释问题」变成会话里可以直接看、可以点、可以调的可视对象。Profer 已经提供内置工具 `present_visualization`；所有会话内可视化都必须通过它发布，不要用 mermaid、ASCII 图、截图或自建 HTML 预览来替代。**但注意：只有数值对比、趋势、流程图、交互讲解才用可视化工具；普通信息列表（配置说明、API 参数、步骤清单等）继续用 markdown 表格。**

这份 Skill 负责**判断该不该用、用哪种形式、怎么写片段**；工具参数与限值以工具描述为准，两者冲突时以工具描述和工具的报错为准。

## 第一步：先选最小合适形式

| 用户要什么 | 用什么 | 说明 |
| --- | --- | --- |
| 命名数值的多少、对比、趋势、占比、分布 | `chart`（原生图表） | 只提交数据映射，坐标轴/图例/tooltip/主题/响应式由 Profer 负责 |
| 关系、流程、层级、结构、示意图 | HTML 片段（`format: 'fragment'`） | 自己画布局，用宿主 token 与语义类，不重建设计系统 |
| 需要调参、切换、分步观察才看得懂 | HTML 片段 + 状态 | 用 `proferVisualization.setState` 保存选择，折叠后能恢复 |
| 需求只是"把话说清楚" | 不要用这个工具 | 普通回复更合适；工具不是每轮都要用 |

三条硬性判断：

- **数值对比、趋势、占比、分布用 chart**，不要贴 markdown 表格或手绘柱形字符图。**但普通信息列表（配置项、参数说明、步骤清单等非数值对比）仍然用 markdown 表格，不要强行可视化。**
- **只说"给我一张图"但没数据、没结构**，先问清要比较什么，不要凭空造数据。**任何数值都必须来自用户提供或已核验的来源**，不得编造。
- 需要持久 URL、权限、独立站点或文件交付时不用本工具——那是 standalone 页面/文档/Site 的场景。

## 第二步 A：原生图表（chart）

```json
{"chartType":"bar","xKey":"month","xAxisLabel":"月份",
 "series":[{"dataKey":"revenue","label":"收入","valueSuffix":"万元"},
           {"dataKey":"cost","label":"成本","valueSuffix":"万元"}],
 "data":[{"month":"一月","revenue":32,"cost":18}]}
```

- `chartType`：`bar` / `line` / `pie` / `scatter`；横向柱状图用 `layout: "vertical"`（含义是"横着放"）。
- `xKey`：分类轴字段；散点图必须是数值字段。
- 饼图：用 `nameKey` + `valueKey`，一个系列且 `dataKey` 等于 `valueKey`；分类名不能重复（先聚合），数值非负且总和大于零。
- `data`：最多 200 行，每行字段结构一致，数值必须是有限数字；不要塞 NaN、Infinity、字符串数字。
- **不要传** ECharts option、formatter、颜色、代码、函数或自定义样式——这些一律由宿主决定，传了会被拒绝。
- 每个数据行会自动生成一个可引用对象（`row-0`、`row-1`…），用户点柱子/点表格行就能把该行引用回对话。

## 第三步 B：受约束 HTML 片段（fragment）

### 结构

- 只写**内容片段**：不要 `<!doctype>`、`<html>`、`<head>`、`<body>`、`<main>`。**例外：当片段包含中文或其他非 ASCII 字符时，为了确保在各种预览场景下都能正确显示，必须包含完整的 HTML 结构和字符编码声明**：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>标题</title>
</head>
<body>
  <div id="widget">
    <!-- 你的内容 -->
  </div>
</body>
</html>
```

  纯英文 fragment 可以省略外壳，但包含中文/日文/韩文/emoji 等 UTF-8 字符时，缺少 `<meta charset="UTF-8">` 会在某些预览环境中导致乱码。

- 根容器用 `#widget`；页面标题只放在工具的 `title` 里，不要在片段里再写一个重复标题。
- 自然文档流 + 自然高度；不要固定页面高度、不要视口单位撑满屏、不要嵌套纵向滚动、不要做成全屏 dashboard。
- 需要刻意可滚动的区域（比如长表格）才用 `data-profer-scroll` 标注，其余滚动交给会话本身。
- 高度按内容自然长；**不要用会改布局尺寸的动画**（`height`/`padding`/`font-size` 上的 `@keyframes`、逐帧改元素高度）。宿主只在布局安静后按最终高度收口，持续改尺寸的片段会被裁在一开始的盒子里。要动就动 `transform`/`opacity`。
- 需要多列/面板时优先用宿主语义属性，而不是自己写一套卡片样式。

### 样式

- 只用 Profer 的 token 与语义类，宿主会在片段外统一注入设计基线。**下面这些就是全部可用语义类**，宿主没有的类不要写（写了不会报错，但拿不到样式，等同裸 HTML）：

| 用途 | 可用 | 说明 |
| --- | --- | --- |
| 根容器 | `#widget` | 唯一的直接根；页面标题只放工具 `title` |
| 布局 | `.viz-grid`、`[data-profer-columns]` | 响应式网格 / 响应式列，自适应到约 320px |
| 表面 | `[data-profer-panel]`、`[data-profer-caption]` | 中性面板 / 次要说明文字 |
| 按钮 | `.btn`、`.btn-primary`、`.btn-ghost`、`.btn-block` | 选中态用 `aria-pressed="true"`；`.btn-block` 满宽 |
| 控件行 | `.viz-controls`、`.form-label` | 横向排列的控件组 + 控件标签 |
| 输入 | `.form-control`、`.form-select`、`.form-range` | 文本/下拉/滑块（滑块是调参场景的首选） |
| 选择 | `.form-check`、`.form-check-input`、`.form-check-label`、`.form-switch` | 复选框/单选框；`.form-switch` 是开关（用 `<input type="checkbox">`） |
| 表格 | `.table`、`.table-sm`、`.table-responsive` | 精确映射与对比；数值列加 `.text-end`，紧凑用 `.table-sm` |
| 代码 | `pre`、`code` | 算法/伪代码/数据结构快照：`pre` 自动用代码块底色，行内 `code` 自动用 muted 底色；不要自己写暗色主题 |
| 文字 | `.text-muted`、`.text-destructive`、`.text-end`、`.text-center`、`.text-nowrap` | 次要 / 错误提示 / 对齐 / 不换行 |
| 其他 | `.viz-badge`、`.sr-only` | 就地标签；只给屏幕阅读器的文本 |

- 颜色 token（颜色一律写 `hsl(var(--X))`；宿主搬运的是 HSL 三元组，且会随皮肤实时更新）：
  - 表面与文字：`--background`、`--foreground`、`--muted`、`--muted-foreground`、`--card`、`--card-foreground`；面板背景/描边用 `--panel-surface`、`--panel-border`。
  - 边框与控件状态：`--border`、`--input`、`--ring`、`--primary`、`--primary-foreground`、`--secondary`、`--secondary-foreground`、`--accent`、`--accent-foreground`。
  - 状态色与代码块：`--destructive`、`--destructive-foreground`、`--success`、`--warning`、`--info`、`--code-bg`、`--code-fg`。
- 几何 token：`--radius`（长度值，直接 `border-radius:var(--radius)`，或 `max(0px,calc(var(--radius) - 2px))` 做小一档的控件圆角）；胶囊/圆形元素（标签、开关、头像）用 `--radius-pill`；两者都不要写死像素——**旧屏微光这类「全局直角」皮肤会给 0/0px，写死就方不下去**。
- **就是这些，没有别的**：图表系列色由宿主渲染，不给你用；上面没列的 token（侧栏、弹窗、tooltip 等）等于未定义，写了等于裸样式。宿主已经搬运的 token 会在明暗切换与换肤后自动重发，你不需要（也无法）自己监听主题。
- **表格 vs 图表**：精确映射、逐项对账、多列属性用 `.table`；趋势、占比、分布用 `chart`。不要把可画的数值硬挤成表格，也不要把需要逐项核对的清单画成图。
- 不要硬编码页面背景或自定义字体栈；不要重新定义 `.btn` / `[data-profer-panel]` 这些宿主类；不要用 `!important` 抢宿主基线。
- 正文 14px 级别、间距克制，跟随会话字体与主题（明暗主题切换时片段要跟着变，所以只能用 token）。
- 图片只用 `data:` URI（内联 SVG / base64）；**禁止 CDN、外链、`@import`、`<link>`、`<iframe>`、表单提交**——HTML 里写出来的外链会在发布时被校验拒掉。
- **JS 里也不要发请求**：`fetch`/`XMLHttpRequest`/`WebSocket`、JS 动态创建的 `<img src="https://…">`、`new Worker` 都会被执行环境的 CSP（`connect-src 'none'`、`img-src data:`）挡掉。被挡**不会**拆掉视图（宿主只记一条日志），但你拿不到数据，页面只会缺一块。需要数据就写进片段里。

### 行为

- 交互用 `addEventListener`，**不要写内联事件处理器**（`onclick` 等）。
- 所有状态走宿主 API，不要只存在 DOM 里：

```js
const state = window.proferVisualization.getState();
window.proferVisualization.setState({ metric: 'cost' });   // 会持久化，折叠/回收后能恢复
window.addEventListener('stateUpdated', (event) => apply(event.detail));
```

  - 状态必须是普通 JSON 对象，最大 16 KiB；不要存 DOM 节点、函数、`Date`、`Map`。
  - 恢复时会触发 `stateUpdated`；在恢复回调里再 `setState` 会被忽略（这是防循环，不要依赖它做级联更新）。
- 可点击/可选择的元素，如果对应 `objects` 里声明的对象，加上 `data-profer-object-id="<id>"`；也可以程序化调用 `window.proferVisualization.selectObject(id)`。用户在宿主里选中后会把该对象引用回对话。
- 键盘可达、有可读文本、窄屏（约 320px）不溢出；图表和关键结论要有等价文字说明。

## 公式与数学符号（LaTeX → MathML）

片段里的公式**必须**写成 LaTeX，宿主会转成 MathML（Chromium 原生渲染，跟随系统数学字体，不需要 KaTeX/MathJax 的字体或任何外链）：

- 行内 `\(O(n\log n)\)`；独占一行 `\[T(n) = 2T(n/2) + O(n)\]`。
- **不要用 `$...$`**：片段里不渲染——HTML 里的 `$` 几乎总是金额，启发式识别一定会误伤。
- **不要用 ASCII 拼公式**（`x^2`、`n/2`、`sqrt(x)`），更不要用图片或手绘 SVG 摆一个公式。
- 公式要写在**元素内容**里，不要放进属性（`title=`、`aria-label=`）：属性不参与渲染，会原样露出反斜杠。
- `\(` 只在不被反射杠转义时生效；`<script>`、`<style>`、`<pre>`、`<code>`、`<textarea>` 里的 `\(` 一律当代码（写正则或字符串字面量时不用担心）。
- LaTeX 语法错时原文会原样显示（比如 `\(\frac{\)`）——看到这种情况说明自己写错了，改成简单形式再发布。

其他位置的公式写法不同，别混：

| 位置 | 写法 | 为什么 |
| --- | --- | --- |
| 片段内容 | `\(...\)` / `\[...\]` | 宿主转 MathML，见上 |
| 回复正文 | `$...$` / `$$...$$` | 聊天渲染器支持 KaTeX |
| `title` / `summary` / `objects.text` / 图表标签 | 纯文本或 Unicode（`O(n log n)`、`∑`、`√`、`n²`） | 这些位置按纯文本显示，写 LaTeX 会原样露出反斜杠 |

教学场景：推导过程每步一个 `\[...\]`，配合「下一步」逐步显示；同一符号在正文、旁白、公式里必须同名（不要一处写 `n` 一处写 `N`）。

## 教学/讲解场景：学生要「看懂一个过程」

判断依据是「要看懂的东西里有没有**顺序、中间状态或可变的量**」，而不是「用户用了『讲解』这个词」。

| 学生要什么 | 用什么 |
| --- | --- |
| 一个过程怎么一步步发生（算法、协议、编译、审批、推导） | 带状态的**分步片段**：上一步/下一步 + 图示 + 一句旁白 |
| 某个量变了会怎样（增长率、阈值、规模、收敛） | 带状态的**可调参片段**：滑块/下拉 → 即时重画 |
| 多个概念或结构的静态关系 | 结构片段（可让点击概念高亮相关部分） |
| 定义、报错原因、名词解释、纯事实问答 | **不要用**这个工具，普通回复更清楚 |

教学片段的设计规则：

1. **用一个具体例子走完全流程**（具体输入 → 每步中间状态 → 结果）；讲快速排序就用 `[8,3,7,1]` 走一遍，不要罗列抽象描述。
2. **每步只变一个东西**：当前步高亮，已完成的步骤留痕（浅色/勾选），不要一次全画出来让学生自己找差异。
3. **状态进 `setState`**：`{ step: 3 }`、`{ threshold: 0.6 }`——折叠或回收后学生回来还停在原来那一步。
4. **一步一屏**：不要把整个教程做成长滚动页面。内容确实要分层时，用 `visualizationId` + `baseRevision` 更新成第二节，而不是无限加长。
5. **用 `objects` 标注关键概念与中间结果**，`data-profer-object-id` 对齐，学生点一下就能把「第 3 步的 pivot 是 7」这类事实引用回对话继续追问。
6. `summary` 写「看什么 + 动手试什么」（例：「点『下一步』看 pivot 如何切分数组；拖滑块改变数据规模」），而不是「这是一个关于快速排序的可视化」。
7. 公式用 LaTeX（`\(...\)` / `\[...\]`），见《公式与数学符号》；符号、变量名要和同一段回复里的正文一致。
8. 旁白写「发生了什么」（「7 比 8 小，换到左边」），不要写「这里用了双指针法」这种需要额外背景的话。

分步片段骨架（改它，别照抄样式）：

```html
<div id="widget">
  <div data-profer-panel id="stage"></div>
  <p data-profer-caption id="caption"></p>
  <div class="viz-controls">
    <button class="btn" id="prev" type="button">上一步</button>
    <button class="btn" id="next" type="button">下一步</button>
  </div>
</div>
<script>
  const steps = [/* { highlight: [...], caption: '…' } */];
  let step = window.proferVisualization.getState()?.step ?? 0;
  const render = () => {
    // 只画 steps[step]：高亮 + 旁白 + 按钮禁用态。这里不要 setState，恢复时也会走到这里。
  };
  for (const [id, delta] of [['prev', -1], ['next', 1]]) {
    document.getElementById(id).addEventListener('click', () => {
      step = Math.min(steps.length - 1, Math.max(0, step + delta));
      window.proferVisualization.setState({ step });
      render();
    });
  }
  window.addEventListener('stateUpdated', (event) => { step = event.detail?.step ?? step; render(); });
  render();
</script>
```

（用真实 `<button>` 是为了键盘可达；外观交给 `.btn`，不要自己重定义。）

## 对象清单（objects）

`objects` 用来声明"用户可能想引用的东西"：每个 `{id, label, text}`，最多 200 个，`id` 不能重复。

- 图表路径下对象由宿主自动生成，无需自己写。
- 片段路径下要自己声明，并且和 `data-profer-object-id` / `selectObject` 的 id 对齐（对不上会报错）。
- `text` 写"引用到对话后仍然自解释"的内容（值、单位、口径、条件），不要只写标签。

## 更新已有可视化

用**同一个** `visualizationId` + 当前 `baseRevision` 原地更新，两者必须同时提供：

- 更新会产生新的不可变修订（`recordVersion` 递增），**旧版本仍可读**，所以不要新建一个重复的可视化。
- `baseRevision` 过期（期间已被改过）时更新会被拒绝，失败时旧版本保持可用——重新读取当前修订再更新。
- 修改前先用 `inspect_visualization` 读回当前 HTML 与对象清单，不要在记忆里猜上次写了什么。
- 用户引用了可视化对象时，引用块里带着 `visualization_id` 和 `revision`，直接用它更新对应版本。

## 限制与失败处理

- 片段 HTML ≤ 512 KiB；`data` ≤ 200 行、≤ 8 个系列；状态 ≤ 16 KiB；标题 ≤ 120 字；摘要 ≤ 2000 字。
- 每个会话有结果数与总存储额度上限；额度用尽时旧结果保持可用，不要重试刷量。
- 计划模式不能发布可视化——先完成计划审批，再发布。
- 校验失败会返回明确原因（外部资源、内联事件、页面外壳、字段非法等），按报错改，不要绕过校验（例如把外链塞进字符串或注释）。

## 发布前自检

1. 形式选对了吗：数值对比 → chart；关系/流程 → 片段；需要调参 → 带状态的片段；逐项核对 → `.table`。
2. `title` 说清了这是什么，`summary` 给了可独立阅读的结论（含单位、口径、数据是否为演示数据）。
3. 片段没有页面外壳、没有外链、没有内联事件；样式只用了 token 与语义类。
4. 所有交互状态都通过 `setState` 保存；刷新/折叠后能恢复。
5. 对象 id 与 DOM 上的 `data-profer-object-id` 一致；`text` 能独立读懂。
6. 没有为了好看而新增与解释无关的装饰、标题或全屏外壳。
7. 讲解场景：例子具体、每步只变一个变量、`summary` 写清了「看什么 + 试什么」。
8. 公式用 `\(...\)` / `\[...\]`：没有 `$...$`、没有 ASCII 拼的公式，也没把公式塞进属性。

## 不要做

- 不要用 markdown 表格、mermaid、ASCII 图、代码块里的柱形字符来"模拟"**数值对比图表**；数值对比用 `chart`。但**普通信息列表**（配置说明、API 参数、步骤清单）继续用 markdown 表格。
- 不要把工具调用结果里的 JSON、内部协议标记或本文档原文输出给用户。
- 不要为了通过校验而改写用户数据（例如改分类名去重）；先说明需要聚合。
- 不要声称"已视觉验收"——`inspect_visualization` 只检查内容，不代表渲染或交互验证。
- 不要用 ASCII 动画、字符进度条或代码块里的图案来"模拟"过程；那正是本工具要替代的东西。
- 不要把公式写成 `$...$`、ASCII 文本或图片；片段里只认 `\(...\)` 和 `\[...\]`。
