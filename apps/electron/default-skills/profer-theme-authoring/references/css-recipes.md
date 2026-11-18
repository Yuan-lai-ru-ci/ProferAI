# skin.css 写法与配方（Surface Contract v2）

> **契约真源**：`apps/electron/resources/skin-template/skin.css` 与同目录 `manifest.json`。
> 设置页「皮肤管理器 → 制作指南」直接 `import` 这两个文件（`SkinManager.tsx` 注释写明“官方磁盘模板是唯一真源”）。
> 本文件只是它的阅读地图，不是第二份契约；两者冲突时以模板和源码为准，并回头修本文。
> **层级、值格式、级联与失效模式**见 `references/layering.md`；本文只给写法与配方。

## 1. 先分清四层，不要混着改

| 层 | 是什么 | 位置 |
|---|---|---|
| 契约 token | 皮肤唯一允许赋值的语义表面 | `resources/skin-template/skin.css` 的 `:root` |
| 公共组件规则 | 消费契约 token 的选中态、滚动条等；**不要整体重写**，只在必要时用更高特异性放行单个状态 | `renderer/styles/skin-base.css` |
| 写法校验 | 安装与读取时会被拒绝的语法 | `main/lib/skin-service.ts` 的 `auditSkinCss` |
| 级联层 | `globals.css` → `skin-base.css` → 运行时 `<style id="skin-css">`；还有 `:root.ui-classic`、`.ui-classic ... !important` 等高特异性规则 | 见 `layering.md` §3 |
| 渲染边界 | iframe 片段、图表、OFV 预览、导出页不继承主文档皮肤规则 | 见 `layering.md` §5.8 |

皮肤的工作只有一件：在 `:root` 里给语义 token 赋值，必要时加少量特例规则。不要靠覆盖内部类名去“修”层级。

## 2. 契约 token 覆盖清单（v2）

`create_skin` 会强制写入 `contractVersion: 2`。**声明 v2 却只写 v1 的十几个 token，是皮肤“只有一半生效”的最常见原因**：未赋值的 v2 表面会继承 `globals.css` 里 `.dark` / `:root` 的默认灰，于是卡片、输入区、选中态仍是默认色。

按组覆盖。**注意各组值的格式不同**：A/B/C/D/E/F 是 Tailwind 映射，只写 HSL 三元组（D 组里的 `--diff-*-bg` / `--diff-*-fg` 例外：消费方自己包一层 `hsl()`，可以带 alpha，见 `layering.md` §1.2.1）；G 是完整渐变值；H 组是完整 CSS 值。直连组的完整值清单见 `layering.md` §1.2。

```css
:root {
  /* A. shadcn 兼容底 */
  --background: ...; --foreground: ...; --muted: ...; --muted-foreground: ...;
  --border: ...; --input: ...; /* --input 当前无消费点：border-input 实际读 --input-surface */ --ring: ...; --primary: ...; --primary-foreground: ...;
  --secondary: ...; --secondary-foreground: ...; --accent: ...; --accent-foreground: ...;
  --destructive: ...; --destructive-foreground: ...;
  --card: ...; --card-foreground: ...; --popover: ...; --popover-foreground: ...;
  --dialog: ...; --dialog-foreground: ...; --tooltip: ...; --tooltip-foreground: ...; --tooltip-muted: ...;

  /* B. 区域表面（旧文档只有这 5 个，远不够） */
  --content-area: ...; --sidebar-surface: ...; --tabbar-surface: ...; /* 仅 .window-controls 按钮组 */
  --tab-surface: ...; /* TabGroupItem 背景 + 顶栏选中文字色 */ --input-surface: ...;

  /* C. Surface Contract v2：外壳 / 抬升 / 下沉 / 边框 / 控件 / 选中 */
  --shell-surface: ...; --raised-surface: ...; --sunken-surface: ...;
  --surface-border: ...; --surface-border-strong: ...;
  --input-hover: ...; --control-surface: ...; --control-hover: ...;
  --selected-surface: ...; --selected-foreground: ...; --focus-ring: ...;

  /* D. 浮层与内容表面 */
  --overlay: ...; --overlay-foreground: ...;
  --message-surface: ...; --message-user-surface: ...;
  --code-bg: ...; --code-fg: ...;
  --blockquote-surface: ...; --table-header-surface: ...;
  --diff-addition-bg: ...; --diff-addition-fg: ...;
  --diff-deletion-bg: ...; --diff-deletion-fg: ...;
  --browser-host-surface: ...;

  /* E. 语义状态 */
  --success: ...; --success-foreground: ...;
  --warning: ...; --warning-foreground: ...;
  --info: ...; --info-foreground: ...;

  /* F. 图表（图表渲染器与导出共用，缺省回落 DEFAULT_CHART_PALETTE） */
  --chart-1: ...; --chart-2: ...; --chart-3: ...; --chart-4: ...;
  --chart-5: ...; --chart-6: ...; --chart-7: ...; --chart-8: ...;

  /* G. 外壳渐变（值必须是完整 linear-gradient，不是颜色） */
  --shell-bg-gradient: linear-gradient(145deg, hsl(...), hsl(...));

  /* H. skin-base 直连组（完整 CSS 值，不是三元组；不写会让对应组件变透明） */
  --item-selected-bg: hsl(...);      /* 会话/工作区/Tab 选中底 */
  --item-selected-fg: hsl(...);      /* 选中行文字（会强制所有子元素继承） */
  --selection-bg: hsl(... / 0.75);
  --selection-color: hsl(...);
  --mode-slider-bg: hsl(...);
  --mode-slider-shadow: 0 2px 4px rgb(0 0 0 / 0.3);
  --mode-btn-selected-color: #ffffff;
  --workspace-badge-color: hsl(...);
  --dialog-glow-shadow: 0 0 40px 8px rgb(255 255 255 / 0.06);
  --code-block-header-bg: rgb(...);
  --minimap-indicator-bg: hsl(...);
  --scroll-thumb-bg: hsl(... / 0.2);
  --scroll-thumb-hover: hsl(... / 0.32);
  --scroll-thumb-active: hsl(... / 0.42);
  --plan-mode-stroke-color: hsl(... / 0.7);
  --tabbar-shadow-color: hsl(... / 0.6);
}
```

可只写其中一部分，但 A/B/C 三组是层级可辨的底线；D/E/F 决定浮层、消息、状态和图表是否还停留在默认色；H 组决定选中态、滚动条、选区是否直接消失。

## 3. 真实层级：谁在承载哪一层

这张表按组件代码里的实际 class 统计，不是设计意图推测：

| 层级 | token | 真实承载 |
|---|---|---|
| 应用外壳 / 缝隙 | `--shell-surface`、`--shell-bg-gradient` | `AppShell.tsx` 根节点 `shell-bg … bg-surface-shell`；`skin-base.css` 用 `--shell-bg-gradient` 画外壳 |
| 左侧栏 | `--sidebar-surface` | `LeftSidebar.tsx` 的 `bg-sidebar` |
| 顶部条 | `--tabbar-surface` 仅用于窗口控制按钮组 | `.tabbar-bg` 是 `transparent`，整条顶栏跟随 Panel 的 `--content-area`；`--tabbar-surface` 只给 `.window-controls`（Windows 右上角按钮组）上底；经典界面顶栏才用 `--muted`/0.5 |
| 主画布 | `--content-area` | 主工作区、技能页等 36 处 `bg-content-area` |
| 通用底 | `--background` | 94 处 `bg-background`，大量组件的回退底 |
| 卡片 / 抬升面板 | `--card`、`--raised-surface` | 卡片 19 处 `bg-card`、面板 25 处 `bg-surface-raised`（两者不是同一个东西） |
| 下沉面 | `--sunken-surface` | 缩略图底、代码块底、内嵌预览 |
| 控件 | `--control-surface`、`--control-hover`、`--input-surface`、`--selected-surface` | secondary/outline 按钮、输入框、设置/规划页选中项；secondary 按钮文字吃 `--secondary-foreground`，不是 `--control-foreground` |
| 浮层 | `--popover`、`--dialog`、`--tooltip`、`--overlay` | 菜单、设置弹窗（`bg-dialog`）、提示、遮罩 |
| 消息 | `--message-surface`、`--message-user-surface` | 仅提供颜色，**不会**自动把消息变成卡片 |
| 图表 | `--chart-1..8` | 图表渲染器与导出静态页 |

判据：如果换肤后某块区域“还是默认黑/白”，先查它属于上表哪一层，再去补对应 token；不要连续调 `--background` 碰运气。

> **别把 class 名写成变量名**：「token」列是 CSS 变量（如 `--raised-surface`），「真实承载」列里的 `bg-surface-raised` 才是 Tailwind 类。两者词序相反：`--` 后面写成 `surface-raised` 不会报错，但没有任何规则消费它，层级会保持默认灰。

> **同名不同物**：`--input` 当前没有消费点（`bg-input` / `border-input` 实际读 `--input-surface`）；`--tab-surface` 在 TabGroupItem 里当背景、在顶栏选中态里当文字色；`--selected-foreground` 没有 Tailwind 映射。完整对照表见 `layering.md` §4。

## 4. 可选契约 token（不写 = 属性变 unset，通常是透明）

`skin-base.css` 直接 `var(--x)` 且**不写 fallback**，`globals.css` 也没有给这些 token 默认值。所以它们只有皮肤自己定义才存在。关键：**未定义不是“规则不生效、组件回落基础样式”**，而是该声明在计算值阶段失效、属性变 `unset`；再叠加规则里的 `!important`，组件自己的细微底色也会被顶掉。已在 Chromium 最小页面验证：`.row { background: red }` + `html[class*="skin-"] .row { background: var(--x) !important }`，未定义 `--x` 时 computed 背景是 `rgba(0,0,0,0)`。

| token | 作用 | 值格式 |
|---|---|---|
| `--selection-bg` / `--selection-color` | 文字选区 | 需带完整 alpha，如 `hsl(... / 0.75)` |
| `--mode-slider-bg` / `--mode-slider-shadow` / `--mode-btn-selected-color` | 模式切换器选中态 | 颜色 / 阴影 / 颜色 |
| `--item-selected-bg` / `--item-selected-fg` | 会话、工作区、Tab、自动化入口选中态 | **完整颜色**，如 `hsl(150 12% 22%)`；写三元组会让整行变透明 |
| `--workspace-badge-color` | 工作区 Badge 文字 | 完整颜色 |
| `--dialog-glow-shadow` | 设置弹窗光晕 | 完整 box-shadow |
| `--code-block-header-bg` | 代码块标题栏 | 完整颜色 |
| `--minimap-indicator-bg` | 迷你地图当前位置 | 完整颜色（缺省回落前景色） |
| `--scroll-thumb-bg` / `--scroll-thumb-hover` / `--scroll-thumb-active` | 滚动进度条三态 | 完整颜色，带 alpha |
| `--plan-mode-stroke-color` | 计划模式虚线 | 完整颜色（缺省回落 primary/45%） |
| `--tabbar-shadow-color` | 经典界面 TabBar 下缘 | 完整颜色 |
| `--tiptap-pre-bg` | 输入区代码块底 | **三元组**（消费写法是 `hsl(var(--tiptap-pre-bg, var(--code-bg)))`） |

需要“精致感”时优先补这一组：它们不改变层级，但决定选中态、滚动条、代码块是否还像默认皮肤。**这一组不写不是“没效果”，而是对应元素直接消失**（选中底、滑块、滚动条、选区）。

## 5. 特例规则（皮肤文件内直接写；建议统一加 `html[class*="skin-"]` 前缀提高特异性）

- **外壳壁纸**：挂在 `.shell-bg`，不要挂 `body`。**壁纸皮肤按 `references/wallpaper-visibility.md` 走**：先量素材亮度（< 18% 必须提亮 1.45× 左右），再按 §2 表取 alpha（`content-area` 0.38–0.44、`sidebar` 0.44–0.50、`raised`/`card` 0.55–0.62、`dialog` 0.86–0.90、遮罩 0.04–0.10），最后截图验收。只写 `.shell-bg` 而不写面板 alpha，壁纸只会在缝隙露出；遮罩 ≥ 0.3 或面板 ≥ 0.7 时则几乎完全不可见。
  ```css
  html[class*="skin-"] .shell-bg {
    background-color: transparent !important;   /* 否则 bg-surface-shell 的底色会盖在壁纸下 */
    background-image: linear-gradient(hsl(222 30% 9% / 0.42), hsl(222 30% 9% / 0.42)),
                      url("assets/background.webp");
    background-size: cover;
    background-position: center;
  }
  ```
  `skin-base.css` 的默认规则是 `:where(html[class*="skin-"]) .shell-bg { background: var(--shell-bg-gradient) }`，`:where()` 部分特异性为 0，整条是 (0,1,0)，与裸 `.shell-bg` 相同；皮肤 CSS 后注入，所以能覆盖。真正的坑是 `.shell-bg` 上还有 `bg-surface-shell` 的 `background-color`：`background` 简写与 `background-image` 长写都不会清除它（颜色在下层不会被图片挡住，但会让半透明区域发实），想让壁纸透出就把 `background-color` 显式设为 `transparent`。
- **输入区**：`globals.css` 的 `.ui-classic .agent-input-surface` 用 `background-color: hsl(var(--background) / 0.7) !important` 覆盖了输入表面。皮肤要用**同特异性**规则 + `!important`，靠“皮肤 CSS 后注入”胜出：
  ```css
  html[class*="skin-"].ui-classic .agent-input-surface { background-color: hsl(var(--input-surface)) !important; }
  ```
  只写 `.agent-input-surface`（(0,1,0)）压不过 `.ui-classic .agent-input-surface`（(0,2,0)）。
- **选中行状态色**：`skin-base.css` 的 `.session-item-selected * { color: inherit !important }` 会把行内 `text-info` / `text-warning` / `text-success` 一起吞掉。要保留状态色：
  ```css
  html[class*="skin-"] .session-item-selected .text-info { color: hsl(var(--info)) !important; }
  html[class*="skin-"] .session-item-selected .text-warning { color: hsl(var(--warning)) !important; }
  html[class*="skin-"] .session-item-selected .text-success { color: hsl(var(--success)) !important; }
  ```
- **按钮**：不要写 `button { background: ... }`；按钮颜色全部由 token 驱动。default 吃 `--primary`/`--primary-foreground`，outline 吃 `--control-surface`/`--surface-border`/`--surface-border-strong`，secondary 吃 `--control-surface`/`--secondary-foreground`，ghost hover 吃 `--accent`。缺 `--control-hover` 时 hover 会回落到默认灰。
- **透明底**：只改 `--background` 不够。`body`、`.shell-bg`、`bg-content-area`、`bg-sidebar`、`bg-card`、`bg-dialog` 各有一层不透明底，主窗口本身也是不透明 `backgroundColor`。配方与平台边界见 `layering.md` §6；不要把 alpha 塞进三元组 token（`hsl(... / a / 1)` 会整条失效）。
- **设置页**：`SettingsDialog` 用 `bg-dialog text-dialog-foreground`，所以 `--dialog` / `--dialog-foreground` 必须单独设计，不能只改 `--background`。
- **聊天正文**：实际 Markdown 在 `.message-item .prose`。要柔化正文，用皮肤专属 token + 限定选择器：
  ```css
  :root { --my-skin-message-foreground: 215 20% 78%; }
  .message-item .prose { --tw-prose-body: hsl(var(--my-skin-message-foreground)); }
  ```
  不要覆盖 `pre` / `code` 的颜色，保护 Shiki 高亮。
- **消息卡片**：默认 Agent 消息透明、用户消息只有 `bg-primary/10` 小气泡。要整条卡片化，显式写 `.message-item.is-assistant { background: hsl(var(--message-surface)) }`；只改颜色 token 不会改变布局。
- **动画 / 毛玻璃**：用 `@keyframes` + `transform` / `opacity`；大范围 `backdrop-filter` 注意性能；补 `prefers-reduced-motion` 降级。

## 6. 资源与安全（`auditSkinCss` 的实际规则）

- 扫描所有 `url(...)` **和 `src(...)`** 函数；参数只允许 `assets/` 下的小写 `png|webp|svg|jpg|jpeg`。
- 禁止 `@import`、`@font-face`（含 `\75 rl(`、`@\69 mport` 这类转义绕过）。
- `url()` 参数内不允许 CSS 转义；字符串不允许跨行或未闭合。
- 单张图片 ≤ 4 MB，整包 ≤ 5 MB，`skin.css` ≤ 512 KB，缩略图 ≤ 2 MB。
- 缩略图放包根目录 `preview.webp|png|svg|jpg|jpeg`（不是 `assets/`），查找顺序 `webp → png → svg → jpg → jpeg`。

## 7. 几何与圆角

- 常规圆角只改 `--radius`（基准 0.625rem，按钮等由它派生）。
- **经典界面会压过皮肤 `:root`**：`:root.ui-classic { --radius: 0.625rem }` 特异性 (0,2,0)，皮肤 `:root` 是 (0,1,0)。要改经典界面圆角，用 `html[class*="skin-"].ui-classic { --radius: 0px; }`。
- 用文档级 catch-all（如 `[class*="rounded"]{border-radius:0!important}`）表达直角时，规则进不了 iframe 片段与图表渲染器；不要指望只搬 `--radius` 就能一致。可视化宿主侧的正确做法是 `applyEffectiveRadii` + `measureAppRadius`（读真实元素计算值），这属于渲染侧实现，不是皮肤 CSS 的职责。

## 8. 调色与对比度

- 先让用户看真实窗口，再决定更浅、更灰、更暖或更冷；不要只凭 HSL 直觉断言视觉正确。
- 正文与背景、次级文字与背景、按钮文字与 `--primary` 都算 WCAG 对比度；正文目标 ≥ 4.5:1，低对比艺术风格要明确说明取舍。
- 层级优先于“整体变灰”：外壳、主画布、卡片、输入、Dialog 应有可辨差异；暗色皮肤最容易犯的错是五层全部落在 7%–10% 亮度。
- 若新皮肤看起来像默认深色，先用临时高对比探针确认 renderer 收到了皮肤 token，确认后立即换回目标色并删除探针。
