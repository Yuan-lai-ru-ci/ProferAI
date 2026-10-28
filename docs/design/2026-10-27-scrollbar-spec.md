# 跨平台滚动条规范（Profer 落地版）

2026-10-27 · 适用于 Electron 渲染进程（Chromium 自绘滚动条）

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
5. **颜色吃主题 token，透明度吃平台。**
   thumb 用 `--muted-foreground` 加 alpha，皮肤换色自动跟随；轨道默认透明，不做大面积底色块。
6. **对比度底线。**
   WCAG 2.2 1.4.11 要求非文本 UI 组件与其相邻色 ≥ 3:1。常态 thumb 为了不抢内容可以淡（macOS 系统本身也只有约 1.5:1），但 **hover / active 必须能明确分辨**，否则等于没有反馈。
7. **命中区不等于视觉宽度。**
   视觉 4px 的条可以给 12px 命中区：`border: 3px solid transparent` + `background-clip: content-box`，hover 时把 border 收窄就是"变粗"。这是 VS Code / Edge 的做法。
8. **别给所有容器加按需显隐。**
   用 JS 打 `data-scrolling` 的容器必须能区分"用户滚动"和"程序性滚动"（流式输出会不断触发 scroll 事件），否则滚动条会一直闪。

## 2. macOS（`data-platform="darwin"`）

| 项 | 规范 | Profer 取值 |
| --- | --- | --- |
| 宽度 | 6–8px，不占布局（overlay 观感） | 6px |
| 形态 | 满圆角（999px）、轨道透明 | 圆角 999px，轨道透明 |
| 显隐 | 默认不显示，滚动时出现；鼠标移到右侧滚动条热区（到右边缘 12px）也显示，停手约 1.25s 消失 | 对话区/侧栏按需；其它容器常态 0.3 淡显 |
| 颜色 | 半透明前景色，浅色主题偏深灰 | `--muted-foreground` 0.3 → hover 0.5 |
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
| `styles/globals.css` §全局滚动条 | 平台 token + 全局伪元素规则 |
| `styles/globals.css` §对话区 | mac 滚动时才出现 / win 常驻；有 minimap 进度条时隐藏原生条 |
| `styles/globals.css` §侧栏 | 紧凑宽度，`margin-right: -8px` 把条伸进侧栏 10px 留白 |
| `styles/globals.css` §滚动进度条 | mac 7px 按需；win 12px 常驻（此时它是唯一位置指示） |
| `components/ai-elements/conversation.tsx` | gutter：mac `both-edges` / win `stable` |
| `components/diff/diff-scroll.css`、`DiffView.tsx`、`pierre-styles.ts` | diff/代码区统一吃 `--scrollbar-size-compact` |
| `src/main/lib/browser-controller.ts` | 受管网页注入的滚动条：主进程按 `process.platform` 分 6px / 12px（网页里没有 token，用固定灰） |

新增滚动容器时：**只加 `overflow`，不要写 `::-webkit-scrollbar` 宽度**。确有特殊尺寸需求（如输入框 3px 微条）再单独覆盖，并在注释里写明原因。

## 5. 验收清单

macOS：

- [ ] 对话区不滚动时看不到条，滚轮一动就出现
- [ ] 鼠标移到右边缘 12px 热区（不滚动）时滚动条出现，移开即收回；鼠标在对话区中间不会点亮条
- [ ] 有 minimap 时，鼠标到最右侧（15px 热区）进度条出现，可直接拖；移开后约 1.25s 淡出
- [ ] 侧栏平时无条，鼠标进入列表后出现，行右边缘不位移
- [ ] 侧栏和对话区滚动条不压住文字/按钮
- [ ] 明暗主题、每个皮肤下 thumb 颜色都跟 `--muted-foreground` 走

Windows：

- [ ] 所有可滚容器**不滚动也能看到**滚动条
- [ ] 条可点面积 ≥ 12px（主内容），视觉 4px 左右
- [ ] 悬停条本体时变粗、变深
- [ ] 列表从"不满"变"可滚"时内容不左右跳
- [ ] 高 DPI（150% / 200%）下条不糊、不压字

## 6. 已知局限

1. macOS「始终显示滚动条」系统设置读不到，自绘条仍按需显隐。
2. `::-webkit-scrollbar` 无法做 hover 淡入动画（无 transition），只能力切颜色。
3. Linux 暂用 macOS 参数（6px）；GTK 惯例是 12–14px，需要时再加 `linux` 分支。
4. `viewer.html`（文件预览）保持系统滚动条，由 `color-scheme` 控制明暗，符合"预览页跟随宿主系统"的定位。
