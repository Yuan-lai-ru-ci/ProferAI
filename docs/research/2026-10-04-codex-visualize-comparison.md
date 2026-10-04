# Codex Visualize 调研与 Profer 架构对照（2026-10-04）

> **2026-10-04 晚补注**：源码逐文件复核见 [Codex 源码核验：Visualize 与 Skills 机制](2026-10-04-codex-source-verified-visualize-and-skills.md)。该文以 `openai/codex` 快照 `b8dceb0d` 为准，修订了本文与 harness 文中若干推断（如 Codex 隐式技能路由目前仅在影子实验、开源可视化路径无公式支持）。


> 本文是上午基于产品文档和issue的早期判断。下午源码核验已修订关键结论，见 [开源 harness 调研](2026-10-04-codex-open-source-harness-2026-10-04.md)：标准数据图存在 charts_widget_v2 的JSON路径，复杂交互仍是受约束HTML片段；TUI browser viewer明确使用sandbox iframe。不能据此把“React原生组件全面替换iframe”当作Codex实现，也不能把所有HTML降级为仅兼容模式。下文native-first全面切换属于当时设计建议，不作为已验证架构事实。

## 已核验资料

- OpenAI 官方文档：[Codex Visualizations](https://developers.openai.com/codex/visualizations)（页面正文通过 `.md` 版本读取）。
- OpenAI Codex 官方 GitHub issue：[Visualize skill over-triggers on standalone HTML requests and leaks inline layout constraints #33164](https://github.com/openai/codex/issues/33164)。这是用户报告和实现线索，不等同于官方完整内部规格。

## 官方明确表达的产品模型

官方将 Visualizations 定义为聊天里的 interactive visual explanations，用来探索 charts、maps、diagrams、calculators、simulations 和 interactive explanations。入口是聊天内的 Visualize 标签；用户可提供当前聊天内容、粘贴数据、附件或连接源。

官方示例不是通用 dashboard，而是：

- Spirograph：拖动半径、笔距和速度，观察滚动圆与轨迹变化，同时展示公式和图例。
- Wave interference lab：调整波源并移动探针，观察干涉场变化。
- Tokenizer explainer：编辑文本，在 UTF-8 字节、合并步骤和最终 token ID 之间逐步探索。

官方强调在同一聊天中继续描述修改。它还建议按问题选择最小合适形式：关系/流程用 diagram，命名数值和比较用 chart，地理问题用 map，输入/时间/运动/空间关系发生变化时用 interactive visualization；需要持久 URL、权限或持久数据时应使用 Site。

这说明 Visualize 的核心是“围绕解释问题设计的可探索对象”，不是“把任意网页嵌入聊天”。

## 公开 issue 提供的实现线索

issue 报告描述了 bundled Visualize skill 的会话内 HTML contract：fragment-only markup、thread-scoped visualization files、inline response directive、host theme/utility classes，以及约 736px、下探到 320px 的聊天布局约束。该报告同时明确区分了 inline conversation visualization 与 standalone HTML/site/app：后者不应被这些宿主约束污染。

公开资料没有可靠说明 Codex 内部是否使用 iframe、WebView、React 原生组件或其他渲染技术；不能把 iframe 结论冒充 Codex 内部实现。

## 与当前 Profer 实现的差距

当前 Profer 的生成契约要求模型写完整自包含 HTML，再把它放入 sandbox iframe；宿主随后通过 CSS 覆盖字体、按钮、面板、滚动和高度。这个方案的优点是安全隔离和任意 HTML 兼容，缺点是：

- 模型可以继续生成页面标题、页面背景、dashboard 外壳、固定高度和内部滚动，宿主只能事后修补。
- 主题和布局一致性依赖 CSS 覆盖，无法保证复杂生成内容服从 Profer 组件语义。
- 用户看到的是“一个被嵌入消息的网页”，而不是 Profer 自己渲染的解释对象。
- 状态、对象选择和修改是 HTML runtime 协议，缺少声明式的图表/流程/对比/教学步骤数据模型。
- 当前 smoke harness 证明了回收、滚动、隔离和恢复可以工作，但不能证明产品形态接近 Codex。

## 建议的方向

下一阶段应把 inline visualization 改成两层产品契约：

1. **首选 native visualization**：模型提交受限的声明式 payload，例如 `kind`、`title`、`summary`、`narrative`、`objects`、`controls`、`data`、`steps`、`sourceRefs` 和 `stateSchema`。Profer 用自身 React 组件渲染流程/关系、对比、数据图和解释/计算器。宿主拥有字体、宽度、滚动、主题、焦点、键盘和可访问性。
2. **HTML compatibility fallback**：sandbox iframe 只作为无法映射到声明式类型的兼容模式，明确标记为 custom interactive content，继续保留现有 CSP、导航阻断、状态预算和资源回收。它不是默认生成路径。

模型应该先选择最小表达形式，再生成对应 payload：静态关系优先 diagram，数值比较优先 chart，真正需要调参或逐步观察变化时才用 interactive。没有必要把每个回答都转成网页。

## 对当前工作的直接决定

- 不再把当前 iframe CSS 修补继续包装成“已达到 Codex 体验”。
- 保留已经完成的 iframe 安全隔离、状态恢复、回收和滚动修复，作为 fallback 基础。
- 先设计 native payload 与 renderer 边界，再实现首批流程/对比/解释三种组件，最后将生成入口切换到 native-first。
- standalone HTML、Site、导出文件与 inline visualization 必须使用不同的目标契约，不能共享 inline fragment 约束。
