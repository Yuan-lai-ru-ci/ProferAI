# 跨平台滚动条规范（Profer 落地版）

2026-10-27 · 适用于 Electron 渲染进程（Chromium 自绘滚动条）

> 2026-10-30 修订：显隐与配色收口成一套。侧栏不再用 CSS `:hover` 露出，改为和对话区共用
> `ScrollRegion` + `attachScrollbarReveal`；颜色统一到 `--scrollbar-thumb-idle / -hover / -active`，
> 对话区进度条 `.scroll-progress-thumb` 也改成同一组 token（原来是 `--foreground` 0.14）。

## 0. 一句话结论

滚动条是**系统级 affordance**，不是一个可以随便品牌化的装饰件：形态跟平台走，颜色跟主题走，尺寸跟命中区走。Profer 之前用一套 macOS 味（6px、按需显隐）的规则同时喂给 Windows，在 Windows 上既太细难点，又因为 `scrollbar-width: thin` 落回 Fluent overlay 而让 `::-webkit-scrollbar` 完全失效。现在拆成 `darwin` / `win32` 两套 token。

## 1. 平台无关的硬规则

1. **不要同时用 `scrollbar-width: thin` 和 `::-webkit-scrollbar`。**
   Chromium 见到 `thin` 会走原生 Fluent overlay（Windows）或系统 overlay（macOS）：宽度无视伪元素、显隐由系统决定、JS 控不动。要自绘就统一 `scrollbar-width: auto; scrollbar-color: auto`。
2. **`::-webkit-scrollbar-*` 伪元素只认绘制属性。**
   `background`、`border`、`border-radius`、`background-clip` 有效；`opacity`、`transition`、`transform`、`box-shadow` 无效。想控制显隐/深浅就换 `background-color`（含 alpha），不要指望 `opacity`。
3. **尺寸用 token，不在容器里写死像素。**
   `--scrollbar-size`（主内容）/ `--scrollbar-size-compact`（侧栏、代码块、diff 这类密集区域）。
4. **布局稳定优先。**
   可能从「不满一屏」变成「可滚」的容器给 `scrollbar-gutter: stable`，否则内容左右跳。`stable both-edges` 只在需要正文居中的主阅读区用（macOS 习惯）；Windows 用单侧，双边缘会让内容白缩两条宽度。
5. **颜色只认 `--scrollbar-thumb-idle / -hover / -active` 三个 token。**
   它们由 `--muted-foreground` 派生、按平台定值，皮肤换色自动跟随；轨道默认透明，不做大面积底色块。
   原生伪元素、侧栏列表、对话区进度条必须共用这一组，**不允许某个区域自带一套灰**。
6. **对比度底线。**
   WCAG 2.2 1.4.11 要求非文本 UI 组件与其相邻色 ≥ 3:1。常态 thumb 为了不抢内容可以淡（macOS 系统本身也只有约 1.5:1），但 **hover / active 必须能明确分辨**，否则等于没有反馈。
7. **命中区不等于视觉宽度。**
   视觉 4px 的条可以给 12px 命中区：`border: 3px solid transparent` + `background-clip: content-box`，hover 时把 border 收窄就是"变粗"。这是 VS Code / Edge 的做法。
8. **别给所有容器加按需显隐。**
   用 JS 打 `data-scrolling` 的容器必须能区分"用户滚动"和"程序性滚动"（流式输出会不断触发 scroll 事件），否则滚动条会一直闪。
9. **同一类滚动条只有一套实现。**
   需要按需显隐的容器一律用 `components/ai-elements/scroll-region.tsx` 的 `<ScrollRegion>`（它负责挂 `profer-scroll-region` 与 reveal），
   **不要再写 `:hover` 显隐、不要再在容器里重复声明颜色**。`<ScrollRegion>` 只加布局类（槽位、留白、紧凑宽度）。
   对话区因为还要跟随/暂停/锚点，由 `ConversationScrollProvider` 自己调 `attachScrollbarReveal`，两者共用同一个 reveal 实现。
10. **界面里永远不绘制横向滚动条——横向滚动本身必须保留。**
    全局 `*::-webkit-scrollbar:horizontal` 只把条高度压成 0；触控板横滑、Shift+滚轮、拖拽、程序性 `scrollLeft` 都照常工作。
    不要为了“看不见横条”去加 `overflow-x: hidden` 裁掉内容、禁用横向滚动，或用强制换行把代码/表格折得没法读。
    新增容器可以正常用 `overflow-x: auto`，但不要写横向条的宽度/颜色，也不要用横向条当位置指示。

## 2. macOS（`data-platform="darwin"`）

| 项 | 规范 | Profer 取值 |
| --- | --- | --- |
| 宽度 | 6–8px，不占布局（overlay 观感） | 6px |
| 形态 | 满圆角（999px）、轨道透明 | 圆角 999px，轨道透明 |
| 显隐 | 默认不显示，滚动时出现；鼠标移到右侧滚动条热区（到右边缘 12px）也显示，停手约 1.25s 消失 | 对话区、侧栏列表均走 reveal；其它容器常态 0.3 淡显 |
| 颜色 | 半透明前景色，浅色主题偏深灰 | `--scrollbar-thumb-idle` → hover `-hover` → 拖拽 `-active` |
| gutter | 主阅读区 `stable both-edges` | 对话区 both-edges |

macOS 用户可以在系统设置里选「始终显示滚动条」。自绘滚动条读不到这个设置，这是已知偏差（见 §6）。

## 3. Windows（`data-platform="win32"`）

| 项 | 规范 | Profer 取值 |
| --- | --- | --- |
| 命中区 | ≥ 12px（Fluent 建议的可点面积） | 主内容 12px，紧凑区 10px |
| 视觉宽度 | rest 约 2–4px，hover 展开 | rest 4px（12−2×3 border），hover 8px |
| 显隐 | **常驻可见**，位置指示不能靠猜 | 全部常驻 |
| 形态 | 圆角（4–999 均可）、轨道透明 | 999px，轨道透明 |
| 颜色 | 中灰，hover 加深 | 0.42 → hover 0.62 → active 0.72 |
| gutter | 单侧 `stable` | 对话区 `stable` |

Windows 的"常驻"是刚性要求：Windows 用户习惯用滚动条长度判断剩余内容量，纯按需显隐会被误读成"没有更多内容"。`2.5.8 Target Size` 对滚动条这类 essential 控件按惯例豁免，但 12px 是接近 Fluent 原生的下限，不要再往下压。

## 4. Profer 落地位置

| 位置 | 作用 |
| --- | --- |
| `index.html` | 首帧前写入 `<html data-platform="darwin|win32|linux">`，避免先闪一帧默认样式 |
| `styles/globals.css` §全局滚动条 | 平台 token（含 `--scrollbar-thumb-*`）+ 全局伪元素规则；`::-webkit-scrollbar:horizontal` 强制 `height: 0` |
| `styles/globals.css` §对话区 | 显隐只认 `data-scrolling` / `data-scrollbar-hover`；有 minimap 进度条时隐藏原生条 |
| `styles/globals.css` §侧栏 | **只留槽位与留白**（紧凑宽度、`margin-right: -8px` 伸进侧栏 10px 留白），不写颜色、不写 `:hover` |
| `styles/globals.css` §滚动进度条 | mac 7px 按需；win 12px 常驻（此时它是唯一位置指示）；颜色与原生条同一组 token |
| `components/ai-elements/scroll-region.tsx` | `<ScrollRegion>`：普通滚动容器的唯一入口，负责 `profer-scroll-region` 类 + `attachScrollbarReveal` |
| `components/ai-elements/scrollbar-reveal.ts` | reveal 本体：wheel / 触摸 / 翻页键 / 右边缘 12px 热区，停手 1.25s 淡出 |
| `components/ai-elements/conversation.tsx` | gutter：mac `both-edges` / win `stable` |
| `components/diff/diff-scroll.css`、`DiffView.tsx`、`pierre-styles.ts` | diff/代码区统一吃 `--scrollbar-size-compact` |
| `src/main/lib/browser-controller.ts` | 受管网页注入的滚动条：主进程按 `process.platform` 分 6px / 12px（网页里没有 token，用固定灰） |

新增滚动容器时：**只加 `overflow`，不要写 `::-webkit-scrollbar` 宽度，也不要自己写显隐/颜色**。
需要按需显隐就用 `<ScrollRegion>`；确有特殊尺寸需求（如输入框 3px 微条）再单独覆盖宽度，并在注释里写明原因。

## 5. 验收清单

macOS：

- [ ] 对话区不滚动时看不到条，滚轮一动就出现
- [ ] 鼠标移到右边缘 12px 热区（不滚动）时滚动条出现，移开即收回；鼠标在对话区中间不会点亮条
- [ ] 有 minimap 时，鼠标到最右侧（15px 热区）进度条出现，可直接拖；移开后约 1.25s 淡出
- [ ] 侧栏平时无条；滚动时出现，停手约 1.25s 淡出，鼠标停在列表里不会常亮
- [ ] 侧栏与对话区、对话区进度条是同一个灰色；不存在「一处深一处浅」
- [ ] 侧栏和对话区滚动条不压住文字/按钮
- [ ] 任何界面都不出现横向滚动条（宽表格、代码块、日历、设置页、Office 预览均检查），同时这些区域仍能横向滚动
- [ ] 明暗主题、每个皮肤下 thumb 颜色都跟 `--scrollbar-thumb-*` 走

Windows：

- [ ] 所有可滚容器**不滚动也能看到**滚动条
- [ ] 条可点面积 ≥ 12px（主内容），视觉 4px 左右
- [ ] 悬停条本体时变粗、变深
- [ ] 侧栏、主内容、对话区进度条是同一个灰；不存在一处深一处浅
- [ ] 任何界面都不出现横向滚动条；高 DPI / 窄窗口下也不出现
- [ ] 列表从"不满"变"可滚"时内容不左右跳
- [ ] 高 DPI（150% / 200%）下条不糊、不压字

## 6. 已知局限

1. macOS「始终显示滚动条」系统设置读不到，自绘条仍按需显隐。
2. `::-webkit-scrollbar` 无法做 hover 淡入动画（无 transition），只能力切颜色。
3. Linux 暂用 macOS 参数（6px）；GTK 惯例是 12–14px，需要时再加 `linux` 分支。
4. `viewer.html`（文件预览）保持系统滚动条，由 `color-scheme` 控制明暗，符合"预览页跟随宿主系统"的定位。
