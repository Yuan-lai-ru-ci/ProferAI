# Codex 源码核验：Visualize 与 Skills 机制（2026-10-04 晚）

> 前置：[`2026-10-04-codex-visualize-comparison.md`](./2026-10-04-codex-visualize-comparison.md)（基于官方文档与 issue 的早期判断）、
> [`2026-10-04-codex-open-source-harness-2026-10-04.md`](./2026-10-04-codex-open-source-harness-2026-10-04.md)（下午的 harness 核验）。
> 本文在 Profer 侧已完成 `present_visualization` 工具 + `present-visualization` Skill + LaTeX/MathML 公式链路之后，
> 回到 Codex 源码逐文件核对，只记录能在快照里引用的原文，不再用宣传页或推测补空。
>
> 快照：`openai/codex` commit `b8dceb0d4f29e49e73daa08f57fcf5181186f354`（本会话 `.context/codex-b8dceb0d4f29e49e73daa08f57fcf5181186f354/`），
> 本文所有行号均指该快照。

## 1. 三条并存的「可视化」路径（不是一条）

| 路径 | 证据 | 形态 |
| --- | --- | --- |
| 开源 TUI 的 inline visualization | `codex-rs/tui/src/inline_visualization.rs:32` `MAX_FRAGMENT_BYTES = 2 * 1024 * 1024`；`real time_history/presentation.rs:14` `INLINE_VISUALIZATION_DIRECTIVE = "::codex-inline-vis{"` | assistant 先写 thread 级 `.html` 文件，再在回复里发指令；宿主注入 `visualize.html` 外壳 + `sandbox="allow-scripts"` iframe |
| 托管产品的 visuals 通道 | `realtime_history/presentation.rs:15` `VISUALIZE_DIRECTIVE = "\ue200visualize\ue202{"`（Unicode 私用区定界符） | 模型在**文本里**发特殊标记承载的指令，不是工具调用 |
| 无 viewer 的表面（终端） | `tui/src/terminal_visualization_instructions.rs` | 由 `Feature::TerminalVisualizationInstructions` 开关控制，向提示词追加“用 ASCII 图/树/时间线/表格，只用 ASCII 字符” |

三点结论直接可用：

1. **它也不给模型裸写完整网页**：`visualize.css` 第一行就是 `Agent-facing contract; keep in sync with SKILL.md.`——
   宿主契约与 SKILL.md 是一份东西的两半。我们 1.2.0 之前把契约写在提示词里、用 CSS 事后覆盖，方向是反的；现在 Skill 里规定 fragment + 宿主语义类与它一致。
2. **指令走文本标记，我们走工具调用**。Codex 的 inline 路径只校验「文件在当前 thread 的可视化目录、扩展名 `.html`、≤2 MiB」（`inline_visualization.rs:124-126`），**没有** fragment/head/body 校验——
   即"禁止页面外壳"在它那里也只是作者契约。我们的 `assertSafeVisualizationHtml`（拒绝 `<base>`/`<meta refresh>`/超大 HTML）+ 结构约束严格得多，保留。
3. **表面感知的降级指令**：Codex 在无 viewer 的终端表面明确要求 ASCII 图表（还单独做了 feature flag）。
   我们核对过 Profer 两个表面：桌面端工具存在时才注入 Skill（`requiredTools: ['present_visualization']`），
   `apps/cli` **完全没有** skill/visualization 代码（`grep -rl "visualiz" apps/cli/src` 为空）——所以不存在"规则要求用不可用的工具"的错配，这一项不需要跟。

## 2. 公式：Codex 的开源可视化路径没有公式支持

- `grep -rni "katex\|mathml\|latex" codex-rs/tui/assets/inline_visualization/*` → **零命中**；`visualize.html` 注入的是 Floating UI（走 `unpkg.com` CDN）与 tooltip runtime，没有任何数学渲染。
- 唯一处理 LaTeX 的地方是 TUI 的**终端**渲染：`tui/src/streaming/math_tests.rs` 出现 `unicode_math_*` 系列用例，
  把 `\frac{a+b}{c}` 转成 Unicode 对齐排版，并在 raw 模式下保留源码。

即：**富文本表面上把 LaTeX 转成可显示形式，而不是塞一个渲染器进沙箱**——这个方向与我们对片段做的 KaTeX→MathML 一致，
而且我们在会话内可视化里已经做到了它开源路径还没做的事（MathML、零字体、零网络、跟随主题）。这一项是我们领先，不是差距。

## 3. Skills 机制：与我们的实现差异最大的一块

### 3.1 元数据模型（`codex-rs/skills/src/model.rs:8-95`）

```rust
pub struct SkillMetadata {
    pub name: String,
    pub description: String,
    pub short_description: Option<String>,
    pub interface: Option<SkillInterface>,     // display_name/short_description/icon_small/icon_large/brand_color/default_prompt
    pub dependencies: Option<SkillDependencies>, // tools: [{type,value,description,transport,command,url,oauth_callback_port}]
    pub policy: Option<SkillPolicy>,           // allow_implicit_invocation, products
    ...
}
```

对照我们：内置 Skill 只有 `name / description / group / version`。差距按可用性排序：

1. `policy.allow_implicit_invocation`（默认 true，可关）——**逐 Skill 关闭隐式触发**。我们目前只能靠删关键字达成；
   公开 issue #33164 报的正是 Visualize skill 过度触发，这个字段就是它那一类的解法。
2. `interface.default_prompt` / `short_description`——给 UI 用的短描述与推荐提问；我们的 `description` 必须同时承担
   "给模型看的路由线索"和"给人看的一句话说明"，是复用同一字段的妥协。
3. `dependencies.tools` 带 transport/url/oauth——比我们 `BUILTIN_SKILL_DEPENDENCIES` 里的 `requiredTools/requiredToolGroups` 更细，
   能表达"MCP 服务器/CLI 依赖"。我们只做到"工具不在就不给路由"，够用但表达力弱。

### 3.2 隐式选择：BM25 + 路由卡 + 字符 n-gram，但**只在影子实验里**

- `ext/skills/src/dynamic_skill_selector/fielded_bm25.rs`：三字段 BM25，权重 `FIELD_WEIGHTS = [8.0, 4.0, 1.0]` = `name : short_description : description`，
  `K1 = 1.2 / B = 0.75`，带 27 个英文停用词，查询与文档各截断 4 KiB。
- `character_routing_card.rs`：routing field = `interface.display_name` + `short_description` + `default_prompt`（+依赖工具名/描述），
  用**字符 n-gram** 匹配（`character_ngram.rs`）——这是对中文这类无空格语言的正解，也是我们手写中文关键字列表的"另一种做法"。
- `shadow_selection_experiment/mod.rs` 开头写明：`Shadow-only skill ranking ... This experiment is temporary and should be removed after evaluation.`
  它同时跑 10 个选择器（`routing_card_lexical`/`weighted_lexical`/`fielded_bm25`/`multi_query_lexical`/`character_routing_card`/`character_ngram`/RRF 融合/LRU 系列），
  用信号量限流（`Semaphore::const_new(2)`）、**不阻塞回合准备**，并把 `codex.skills.shadow_selection.*` 指标打点上报。

结论：**连 Codex 都还没把隐式路由投产**——它投产的是显式 `$skill-name` 提及 + `skills` 命名空间工具。所以我们用
确定性关键字（`profer-routing.json` + `skillTaskMatch`）投产，不是落后，是另一种早期形态；它值得我们抄的不是 BM25 公式，
而是"**选择器先影子跑、拿指标再决定**"这件事。

### 3.3 正文怎么给模型：Codex 用工具，我们注入

`ext/skills/src/tools/` 提供 `skills` 命名空间工具（`SKILLS_NAMESPACE = "skills"`，`tools/list.rs`、`tools/read.rs` 带分页游标、
资源哈希、`MAX_SKILL_RESPONSE_BYTES`，`MAX_HANDLE_BYTES` 限制游标长度）。也就是说 Codex 的技能正文是靠**模型主动调用读**的，
不算常驻上下文；我们则是"描述常驻 + 命中后注入正文"。

两种都要付代价：它多一次工具往返、但常驻更小；我们零往返、但要维护路由命中率。我们的
`<available_skills>` 列表由 runtime SDK 注入（Profer 不控制其格式），因此"更小的常驻"这条路我们暂时走不了，
维持现状并把命中率用测试锁住（`present-visualization-skill.test.ts` 8 个用例 + 负例）。

## 4. 宿主契约清单对比（→ 本轮已落地）

把 `visualize.css` 的选择器全部抽出来后，我们缺的**不是样式细节，而是一组语义类**：

| Codex 有、我们原先没有 | 影响 |
| --- | --- |
| `.table` / `.table-sm` / `.table-responsive` / 对齐工具类 | "精确映射与逐项核对"没有宿主样式，模型只能手搓表格 |
| `.form-check*` / `.form-switch` | 教学片段里的筛选、开关只能手搓 |
| `.btn-primary` / `.btn-ghost` / `.btn-block`、`.viz-badge`、`.sr-only`、`.text-destructive` | 主次按钮、就地标签、错误提示、无障碍隐藏文本缺位 |

另外它有一处我们**故意不跟**的：`#widget > :not(.card)` 会清掉所有非 `.card` 直接子元素的外壳——
我们只清 `.page-shell`，因为无条件清壳会改掉已有片段的外观。收紧壳子要靠 Skill 约束，不靠 CSS 猜。
它也提供 `[data-tooltip]` + Floating UI 的 tooltip runtime；我们的 CSP 不允许外链，且尚无离线 tooltip runtime，
本轮不动（要做就是自写 ~30 行，属于产品决策）。

## 5. 本轮据源码落地的改动（Profer 侧）

1. **语义类补齐**：`apps/electron/src/shared/visualization-style.ts` 增加表格族、`.form-check*`/`.form-switch`、`.btn-primary`/`.btn-ghost`/`.btn-block`、`.viz-badge`、`.sr-only`、`.text-destructive`、`.text-end/.text-center/.text-nowrap`；`--destructive` 进入片段 token 白名单。
2. **契约同步变成测试**：新增 `VISUALIZATION_HOST_PRIMITIVES` 清单 + `visualization-host-contract.test.ts`——
   清单里每一项都必须同时出现在宿主 CSS 与内置 Skill 正文里；Skill 也不得承诺宿主没有的近义类名（`.card`/`.badge`/`.modal`/`.alert`/`.tooltip`/`.tile`）。
   这是把 Codex 那句 `keep in sync with SKILL.md` 注释换成会失败的断言。
3. **Skill 更新到 1.3.0**：样式一节改为"可用语义类总表"（含表格 vs 图表的选型规则），自检项同步。
4. **真实渲染验收**：用 Electron 43 加载真实 CSP + 真实宿主 CSS + 真实片段的截图，确认新语义类（表格、开关、复选框、滑块、按钮三态、徽标、错误色）与公式渲染同时正常。
   截图：`workspace-files/.context/visualization-host-contract-check.png`，样例页：`visualization-host-contract-sample.html`。

## 6. 待决 / 未做的建议（按性价比排序）

1. **`allow_implicit_invocation` 等价物**：在 `profer-routing.json` 支持 `"implicit": false`，语义是"只能显式引用，不参与关键字路由"。
   成本：routing 规则解析 + 1 处判断 + 测试。收益：解决"某个 Skill 关键字太宽"的通用问题（现在只能删关键字）。
2. **`short_description`**：需要 runtime 列表支持才会有收益（SDK 自己读 frontmatter），属于跨包改动，先记不动。
3. **隐式路由的影子评估**：把 `routeSkillsForTask` 的选择结果与"事后是否真的用了该 Skill"打点对比，用数据决定关键字增删——
   这是 Codex 唯一真正值得我们抄的流程性做法。
4. **tooltip runtime**：若产品要 hover 解释，自写离线实现（CSP 不允许外链库）。

## 7. 明确不做的事

- 不因为 Codex 用文本标记发可视化指令就放弃工具调用：我们的工具路径有版本/取消/修订/对象引用/可恢复状态，文本标记换不来这些。
- 不放宽片段 CSP 去换 CDN 库（Codex 的 `visualize.html` 依赖 `unpkg.com`）。
- 不把 `MAX_FRAGMENT_BYTES` 从 512 KiB 提到 2 MiB：我们的片段被内联进会话消息并参与状态预算，2 MiB 是浏览器 viewer 的尺度。
- 不做固定模块库（"只能选柱状图/流程图"）：两条路径的证据都指向"受约束的自由 HTML + 宿主契约"。

## 8. 追加：把字符 n-gram 选择器与关键词结合（已落地）

结论先说：**不照抄 BM25/影子实验那一套，只把 Codex 的字符 n-gram 思路接成关键词的召回补集**，
并且用真实 Skill 目录实测标定。实现：`apps/electron/src/main/lib/skill-lexical-match.ts`（纯函数）
+ `skill-routing.ts` 里的两级调用。

### 8.1 为什么是字符 n-gram 而不是 BM25

中文没有空格，词级 BM25 在中文 Skill 描述上等于没分词；Codex 自己就为此另做了一套字符选择器
（`character_ngram.rs`：2–5 字符 n-gram、`Σ IDF × 字段权重`、命中 gram 数下限）。
我们取其 n-gram 部分，字段权重按现有元数据收敛为 `[name, description] = [8, 1]`
（Codex 是 `[name, short_description, description] = [8, 4, 1]`，我们没有中间字段）。

### 8.2 与 Codex 的本质差别决定了闸门必须更严

Codex 的选择器**只产出候选排序**（`candidate_ids`），本身不做决定，而且当前只在影子里跑；
我们一命中就直接把 Skill 正文注入提示词，误报要花上下文、还会误导方向。
所以：只在**确定性关键词与显式引用都没有结果**时介入，只取**唯一赢家**，并且必须过
“命中 ≥ 6 个查询 gram + 领先第二名 ≥ 1.5 倍”两道闸。

### 8.3 阈值是量出来的，不是拍的

用真实目录（dev 工作区，17 个可路由 Skill）跑了两批消息：

| 类别 | 结果 |
| --- | --- |
| 噪音 20 条（“这 5 个测试为什么失败”“把日志级别临时改成 debug”“为什么这里会死循环”…） | **误命中 0** |
| 真实意图 4 条（“帮我把这份会议纪要写进飞书的多维表格里”“把这份季度报告同步到飞书文档”…） | **4/4 召回**，理由 `lexical-fallback` |

中间试过两个错误方向，都因为实测数据放弃：

1. **放宽到 3 gram**：噪音（profer-coach 6.94 分/3 gram，来自它描述里引用的抱怨例句）与
   “意图没被文档覆盖”的漏召回（4–5 分/2 gram）落在同一分数带，放阈值只会等量引进噪音。
2. **剔除引号里的示例短语**：假设“引号里的例句是噪音源”。实测反而更差——噪音 2→3，
   而 lark-delivery 的真实词表一半在引号里（“同步到飞书”“安排日程”），召回直接掉下来，回退。
3. **绝对分数下限**：分数 = Σ IDF × 权重，IDF 随目录规模变化（同一段文本在 2 Skill 目录里
   只有 17 Skill 目录的三分之一），写死阈值不可移植，改为只用“命中 gram 数 + 领先倍数”。

### 8.4 同时落地：逐 Skill 关闭隐式触发

`profer-routing.json` 新增 `implicit: false`，等价 Codex 的 `policy.allow_implicit_invocation = false`：
该 Skill 既不参与关键词也不参与 n-gram 召回，只接受 `/skill:<slug>` 显式引用。
语义上也更保守——用户已显式点名（即使名字写错）时**不做任何猜测**，只报失败诊断，
避免用猜测掩盖拼写错误。

### 8.5 验证

- 新增 `skill-lexical-routing.test.ts` 9 个用例（纯函数打分 / 太短不猜 / 打平不猜 / 关键词优先且不叠加 /
  兜底带理由 / 无关保持沉默 / 显式引用后不补兜底 / `implicit:false` / 预设拒绝不可越权召回）。
- 全量 `bun test --isolate`：2984 pass / 4 skip / 5 fail（仍是既有 goal-bridge）；typecheck 与
  check-boundaries 通过。
- 成本：200 次路由 276 ms（约 1.4 ms/次，每回合一次）。

### 8.6 仍未做（有数据支撑的下一步）

- **给缺 `profer-routing.json` 的 Skill 补词表**：本轮召回全部落在 lark-delivery——它是少数
  描述里带完整触发词表的 Skill。其余 Skill 的漏召回不是算法问题，是词表覆盖问题（例如
  “把这些数据整理成能对比每个季度利润的图”只有 1 个 gram 命中 present-visualization 的描述）。
- **Codex 的 routing card 字段**（`interface.short_description` / `default_prompt`）：等出现
  “描述写得不像检索文本”的普遍问题再引入；本轮实测证明没有独立字段也没有可测收益。
- **影子评估打点**：把“路由选了什么”与“模型最终是否真的用了该 Skill”对上，用数据决定词表增删。
