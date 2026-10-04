# Codex 开源 Inline Visualization Harness 调研（2026-10-04）

> 更新：继续追查 `openai/plugins` 后确认了两种路径。以下 TUI viewer 是自定义 HTML 片段路径；标准数据图另有 `charts_widget_v2` JSON 规范（见文末），不能把其中任何一条路径说成“所有 Codex Visualize”。

## 调研范围与版本

直接读取 `openai/codex` 开源仓库 commit `b8dceb0d4f29e49e73daa08f57fcf5181186f354`（2026-10-04T04:33:42Z）。本次关注真实源码，不把官方宣传页当实现规格：

- `codex-rs/tui/src/inline_visualization.rs`
- `codex-rs/tui/src/inline_visualization/viewer.rs`
- `codex-rs/tui/assets/inline_visualization/visualize.html`
- `codex-rs/tui/assets/inline_visualization/visualize.css`
- `codex-rs/tui/src/inline_visualization_tests.rs`
- `codex-rs/tui/src/streaming/render.rs` 与相关 streaming tests

该路径是 Codex 开源 TUI 的 terminal fallback / browser viewer；不能直接当成 ChatGPT/Codex 桌面端完整实现。但它是目前能核验的官方开源 harness。

## 直接结论

Codex 不是只能从固定图表模块里选择。开源 harness 明确接收 assistant-authored HTML fragment：

1. Agent 先在 thread-scoped visualization 目录写 `.html` 文件。
2. assistant 输出 `::codex-inline-vis{file="chart.html"}` 指令。
3. `inline_visualization.rs` 解析指令，校验文件只能是当前 visualization thread 下的单个 `.html` 文件，大小不超过 `MAX_FRAGMENT_BYTES = 2 MiB`。
4. `viewer.rs` 读取 fragment，并用 `VIEWER_RUNTIME.replacen(FRAGMENT_PLACEHOLDER, fragment, 1)` 注入 `visualize.html`。
5. `visualize.html` 中保留了原始 fragment 的 HTML、CSS、JS 运行逻辑；测试 fragment 直接包含 `<canvas id="chart"></canvas>` 和 `<script>globalThis.chartRendered = true;</script>`。
6. viewer 生成外壳，再创建 `sandbox="allow-scripts"` 的 iframe，未授予 `allow-same-origin`。

所以准确描述是：**自由生成的 HTML/JS fragment + 严格宿主 contract + 统一 viewer runtime**，不是“固定模块库”，也不是任意完整 webpage。

## 它的公式化部分是什么

公式化的是共享布局、控件和设计系统。`visualize.css` 顶部直接注明 `Agent-facing contract; keep in sync with SKILL.md`，viewer.rs 注释要求与 bundled visualize skill 的 browser renderer 同步。当前 codex 源码快照中没有这份 bundled Visualize SKILL.md，所以以下不能全部解释为生成时的硬校验：

- 模板接受 fragment，不要求模型提供完整页面。TUI viewer 本身没有验证/拒绝 html/head/body 标签；“禁止整页文档”是可从其他开源插件参考核验的作者契约，不能当成此viewer已经实施的验证。
- 宿主提供完整 `visualize.css`，统一 token、字体、控件、`.card`、`.viz-grid`、`.viz-controls`、`.btn`、`.form-control`、`.form-range` 等。
- CSS为 `#widget` 内容根提供布局；`#widget > :not(.card)` 清掉直接子元素的背景、边框、padding、margin、圆角和阴影。这里是样式约束，不是要求所有片段必须通过root结构校验。
- 共享 tooltip runtime 和 Lucide runtime 由宿主注入，模型通过 `data-tooltip`、`data-tooltip-placement` 等约定使用。
- fragment 仍然可以写自定义绘图、公式、canvas、动态交互和任意局部结构；测试专门验证了 canvas 与自定义 script 能进入 viewer。

因此用户看到的“像公式化模块”，来自“自由内容放在固定容器和 design contract 里”，不是来自一个只有固定模块的 renderer。

## 它和当前 Profer 的关键差异

当前 Profer 是：

```text
完整 HTML 文档 + 宿主事后 CSS 覆盖 + iframe
```

Codex harness 是：

```text
自由 HTML fragment + 宿主预置 runtime/CSS + iframe viewer 外壳
```

两者都可能使用 iframe；iframe 不是关键差异。真正差异是：

- Codex 在生成前就告诉模型“只写 fragment、使用宿主 contract”；Profer 目前允许模型先写完整网页，再由宿主补救。
- Codex CSS 是完整的 agent-facing contract，不只是几条 reset 覆盖；它提供可复用 token、控件、表格、网格、tooltip、badge 和 form 语义。
- Codex 通过 `#widget` 和 selector 约束消除页面级外壳；Profer 目前仍允许模型生成重复标题、背景和网页卡片层。
- Codex 的 inline 指令是消息渲染协议的一部分，流式期间会隐藏未完成 directive，完成后重写为可信 viewer link；Profer 当前通过结构化 tool result 直接投影回复段，这部分更适合保留，但需要增加 fragment contract。

## 不能直接照搬的部分

开源 TUI viewer 的 CSP 允许更多资源：`unsafe-eval`、wasm、blob/data，以及多个 CDN；`visualize.html` 还加载 Floating UI 和 Lucide 的 unpkg 资源。它的 shell iframe 是 `height:calc(100vh - 2rem)`、`max-width:736px`，更接近打开浏览器 viewer，而不是 Profer 要求的会话内自然高度。

Profer 已经选择了更严格的安全边界：无网络、无 same-origin、状态预算、消息身份和离屏回收。这些不应为了模仿 Codex 源码而放宽。

## 对 Profer 的明确调整建议

不需要马上推倒 iframe，也不需要先做固定原生组件库。更准确的下一步是移植 Codex 的**契约层**：

1. `present_visualization` 默认接收并生成 fragment，而不是完整 `html/head/body`。
2. 提供 Profer 自己的 agent-facing contract：根节点、主题 token、控件 class/data 属性、tooltip、网格、表单和对象选择约定。
3. 宿主将 fragment 包进自己的 runtime/CSS；生成内容继续可以写 canvas、SVG、公式和局部 JS。
4. 生成提示明确禁止页面外壳、重复标题、整页背景、固定 viewport 高度和默认纵向滚动；这些是 Codex harness 已经通过 contract 解决的问题。
5. 保留当前 iframe 安全隔离与状态恢复，但将“宿主 CSS事后覆盖”改成“宿主 viewer 预置 contract”。
6. 只在 fragment contract 仍无法承载的特殊内容时提供 full custom fallback。

## 补充：标准图表确实有声明式模块

来源：`openai/plugins` commit `5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f` 的 `plugins/data-analytics/skills/visualize-data/references/native-inline-visualizations.md`。这是公开的作者规范，不是底层renderer实现，适用范围是文档明确限定的 ChatGPT web Work Mode。

- L13、L25、L45：单个 bar/line/pie/scatter 使用 `charts_widget_v2`；模型给JSON。
- L47–56：JSON包括chartType/meta/xKey或nameKey/valueKey/series/data；宿主拥有card/spacing/axes/grid/tooltip/legend/colors/hover/responsive/dark mode。
- L26、L39、L60–70：复杂过滤、多图联动、KPI、气泡/漏斗等使用app_block自定义HTML。该路径允许app-scoped CSS和最终script，禁止doctype/html/head/body/main/框架/iframe/外部资源/存储/权限API/内联事件处理器；顶层禁止装饰性卡片外壳。
- 这两个路径并列，因此“都是固定模块”不成立，“都完全自由HTML”也不成立。
- `build-web-data-visualization` 是另一个网站/可视化开发插件，不能与bundled Visualize视为同一实现。

## 修订建议

标准图表采用声明式规范、由Profer宿主控制样式和交互；复杂解释采用严格HTML fragment、共享设计系统和sandbox运行时。优先补内容路由/完整生成契约，保留当前版本/取消/隔离/回收基础。固定图表无需模型写HTML，复杂交互不必全部降级为有限模板。暂不根据源码长度或宣传效果声称质量对齐。

## 源码固定链接

- [viewer.rs L64](https://github.com/openai/codex/blob/b8dceb0d4f29e49e73daa08f57fcf5181186f354/codex-rs/tui/src/inline_visualization/viewer.rs#L64)
- [visualize.css L297](https://github.com/openai/codex/blob/b8dceb0d4f29e49e73daa08f57fcf5181186f354/codex-rs/tui/assets/inline_visualization/visualize.css#L297)
- [自定义canvas/script测试 L226](https://github.com/openai/codex/blob/b8dceb0d4f29e49e73daa08f57fcf5181186f354/codex-rs/tui/src/inline_visualization_tests.rs#L226)
- [native-inline-visualizations.md L13](https://github.com/openai/plugins/blob/5fd93af4cd0c623e020d0cc7e9ce178b4ac1f70f/plugins/data-analytics/skills/visualize-data/references/native-inline-visualizations.md#L13)

完整源码快照与检索证据在本会话 `.context/codex-b8dceb0d4f29e49e73daa08f57fcf5181186f354/`。本轮没有执行Rust测试或启动Codex桌面端，没有修改Profer产品源码。
