# 验收门禁与交付

验收不以“源码有 token”或“构建成功”为完成标准。完成标准是：真实 Electron 窗口切换后，外壳、主画布、侧栏、卡片、输入框、设置页与消息区按预期分层呈现，且证据与结论对得上。

## 0. 开工前

- 检查 `git status --short`，不覆盖无关未提交改动。
- 确认操作仓库是 Profer 源码根目录（含 `apps/electron`）。
- 遵守当前项目指令（`AGENTS.md` / `CLAUDE.md`，若存在）；不要把某个工作区的临时说明当成产品契约。
- 用户皮肤不需要改源码；先判断任务是否真的需要碰 `resources/skins/`。

## 1. 静态与构建（改了源码时）

在源码根目录中逐条执行，不要拼成含 `;` 的复合命令：

```bash
cd apps/electron && bunx tsc --noEmit
bun run build:renderer
bun run build:main
bun run build:preload
cd ../.. && git diff --check
```

- renderer 的 chunk-size 警告可接受，但必须检查退出码。
- 改了 `resources/skins/` 时还需 `bun run build:resources`，否则 dev 版读的是旧 dist 拷贝。
- 仅做用户皮肤（`~/.profer/skins/`）时不需要以上构建。

## 2. 产物断言（仅源码内置皮肤）

皮肤 token 在运行时由 `getSkinCss` 注入，**不会**进 renderer bundle。所以“在 bundle 里 grep 皮肤 class”不是有效门禁；不要用它当通过证据。

有效的静态检查是：

```bash
# 固定路径，不要全盘 find
ls apps/electron/resources/skins/<id>/
sed -n '1,200p' apps/electron/resources/skins/<id>/skin.css
```

确认：manifest 字段完整、`skin.css` 里 A/B/C 三组 token 都有赋值、`url()` 只指向 `assets/` 小写图片。

### 2.1 值格式断言（最容易漏）

按 `references/layering.md` §1 的两组规则分别检查；两条 grep 都应无输出：

```bash
# Tailwind 组必须是三元组，不能是 #hex / rgb() / hsl()
grep -nE '^\s*--(background|foreground|card|card-foreground|popover|popover-foreground|dialog|dialog-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|muted|muted-foreground|border|input|ring|destructive|destructive-foreground|content-area|sidebar-surface|tabbar-surface|tab-surface|shell-surface|raised-surface|sunken-surface|surface-border|surface-border-strong|control-surface|control-hover|input-surface|input-hover|selected-surface|focus-ring|overlay|overlay-foreground|message-surface|message-user-surface|code-bg|code-fg|blockquote-surface|table-header-surface|browser-host-surface|tooltip|tooltip-foreground|tooltip-muted|success|success-foreground|warning|warning-foreground|info|info-foreground|chart-[1-8]):\s*(#|rgb|hsl)' skin.css

# skin-base 直连组必须是完整值，不能是裸三元组
# （只匹配 H S% L%；0 2px 4px 这类阴影值不应被误报）
grep -nE '^\s*--(item-selected-bg|item-selected-fg|selection-bg|selection-color|mode-slider-bg|mode-btn-selected-color|workspace-badge-color|code-block-header-bg|minimap-indicator-bg|scroll-thumb-bg|scroll-thumb-hover|scroll-thumb-active|plan-mode-stroke-color|shell-bg-gradient):\s*[0-9.]+(\.[0-9]+)?\s+[0-9.]+%' skin.css

# Tailwind 组不能把 alpha 写进 token
grep -nE '^\s*--(background|foreground|card|card-foreground|popover|popover-foreground|dialog|dialog-foreground|primary|primary-foreground|secondary|secondary-foreground|accent|accent-foreground|muted|muted-foreground|border|input|ring|destructive|destructive-foreground|content-area|sidebar-surface|tabbar-surface|tab-surface|shell-surface|raised-surface|sunken-surface|surface-border|surface-border-strong|control-surface|control-hover|input-surface|input-hover|selected-surface|focus-ring|overlay|overlay-foreground|message-surface|message-user-surface|code-bg|code-fg|blockquote-surface|table-header-surface|browser-host-surface|tooltip|tooltip-foreground|tooltip-muted|success|success-foreground|warning|warning-foreground|info|info-foreground|chart-[1-8]):[^;]*/[^;]*;' skin.css
```

三条都应无输出。注意 `--diff-addition-bg` / `--diff-deletion-bg` / `--tiptap-pre-bg` 不在这三组里：它们由 `hsl(var(--x))` 消费，写 `H S% L% / alpha` 是合法的（见 `layering.md` §1.2.1）。

再确认 `--shell-bg-gradient` 存在：不写它时 `skin-base.css` 的 `background: var(--shell-bg-gradient)` 会让外壳变透明（不是回落 `--shell-surface`）。

## 3. 运行时断言

时序陷阱：`class` 切换是同步的，皮肤 CSS 是异步 IPC 落地的。class 变化那一刻读到的 computed 值仍是上一个皮肤的。读取前要等 CSS 落地（渲染代码用 `whenSkinCssApplied(skinId)`），不要只靠 MutationObserver。

### 3.1 有 DevTools / CDP 通道时

切换到目标皮肤，等 CSS 注入完成后执行：

```js
({
  classes: document.documentElement.className,
  background: getComputedStyle(document.documentElement).getPropertyValue('--background'),
  contentArea: getComputedStyle(document.documentElement).getPropertyValue('--content-area'),
  shellSurface: getComputedStyle(document.documentElement).getPropertyValue('--shell-surface'),
  raised: getComputedStyle(document.documentElement).getPropertyValue('--raised-surface'),
  sunken: getComputedStyle(document.documentElement).getPropertyValue('--sunken-surface'),
  selected: getComputedStyle(document.documentElement).getPropertyValue('--selected-surface'),
  dialog: getComputedStyle(document.documentElement).getPropertyValue('--dialog'),
  itemSelectedBg: getComputedStyle(document.documentElement).getPropertyValue('--item-selected-bg'),
  skinCssLoaded: !!document.getElementById('skin-css')?.textContent?.length,
  bodyBg: getComputedStyle(document.body).backgroundColor,
  shellBg: (() => { const el = document.querySelector('.shell-bg'); return el ? getComputedStyle(el).backgroundColor : null })(),
  shellImage: (() => { const el = document.querySelector('.shell-bg'); return el ? getComputedStyle(el).backgroundImage : null })(),
  selectedRowBg: (() => { const el = document.querySelector('.session-item-selected'); return el ? getComputedStyle(el).backgroundColor : null })(),
  selectedRowStatusIcon: (() => { const el = document.querySelector('.session-item-selected .text-info, .session-item-selected .text-warning, .session-item-selected .text-success'); return el ? getComputedStyle(el).color : null })(),
  primaryButtonBg: (() => { const el = document.querySelector('button.bg-primary'); return el ? getComputedStyle(el).backgroundColor : null })(),
  outlineButtonBorder: (() => { const el = document.querySelector('button.border-surface-border\\/60'); return el ? getComputedStyle(el).borderColor : null })(),
})
```

必须确认：

1. `classes` 同时包含 `skin-<id>`；深色皮肤还包含 `dark`。
2. 每个 computed token 等于皮肤设计值，而不是 `.dark` 默认值；**并确认格式**：Tailwind 组是 `H S% L%`，`--item-selected-bg` 是完整 `hsl(...)`。
3. `skinCssLoaded` 为 true。若 class 存在但 CSS 未注入，检查 applySkinCss 幂等短路是否误判。
4. 皮肤用到的 assets 以 `profer-skin://` 加载成功（200）。
5. 肉眼检查外壳、主画布、侧栏、卡片、输入框、设置 Dialog、聊天正文。
6. **选中态**：`selectedRowBg` 不能是 `rgba(0, 0, 0, 0)`；若选中行里有运行/等待/完成图标，`selectedRowStatusIcon` 应是状态色而不是统一文字色。
7. **按钮**：至少看 default / outline / secondary 各一个；`primaryButtonBg` 不是透明，`outlineButtonBorder` 不是透明。
8. **透明底**：`bodyBg` / `shellBg` / 主面板背景符合预期；若声称“看到桌面”，必须另行确认窗口层，不能只凭 renderer 的 computed 值。
9. **壁纸可见性**：用户提供壁纸时，按 `wallpaper-visibility.md` §4 执行：确认 CSS 里确有面板 alpha 规则（`grep -n 'bg-content-area' skin.css`）、截图，并用画布区 p95−p5 ≥ 25（有纹理）、文字 p95−p50 ≥ 40（可读）判断。只写了 `.shell-bg` 而没有面板半透明，就按“缝隙可见”交付，不要暗示壁纸已经铺满窗口。
10. **经典界面**：切到 `ui-classic` 再看输入区、模式切换器、顶栏与圆角；`--radius` 可能被 `:root.ui-classic` 压回。
11. 多窗口同步：开一个 Quick Task 窗口，在设置页删除当前皮肤，确认两个窗口都回退默认主题（`skins:changed` 广播生效）。
12. 若皮肤改了圆角语义，检查 `.rounded-lg` 与 `.rounded-full` 在真实窗口中的计算圆角；iframe 可视化中不能只依赖 `--radius` 字面值。

若 class 存在、stylesheet 也已加载，但 computed token 仍是默认 `.dark`：优先检查 skin.css 是否真的被 `getSkinCss` 读到（磁盘缓存签名与格式版本），不要继续盲调色。

### 3.2 没有 DevTools / CDP 通道时（Agent 会话常见）

不要假装跑过上面的断言。可做的替代验证：

- `create_skin` 返回 `ok: true`（载荷带 `installedPath`、`applied`、`validated`，没有 `status` 字段），说明 manifest 与 `auditSkinCss` 通过。
- 用固定路径读取安装后的 `installedPath`，确认 `manifest.json` / `skin.css` / `preview.*` 落盘内容与预期一致。
- 按 `references/layering.md` §1 的两组 grep 做值格式断言；按 §4 的 token 对照表逐项核对覆盖，列出“已覆盖 / 未覆盖”。
- 对选中态、按钮、透明底这类无法只靠静态判断的项，明确列为“未验证”，并告诉用户切肤后该看哪几个位置（选中会话行、主按钮、侧栏与主画布缝隙）。
- 请用户切换皮肤后看真实窗口，并明确反馈哪一层仍像默认色；把用户反馈当作证据，不要替用户下结论。

交付时明确写“运行时 computed-style 未验证（本会话无 DevTools 通道）”，而不是含糊地说“应该没问题”。

## 4. 平台差异

- **Windows**：`manifest.titlebar` 通过 `setTitleBarOverlay` 实时更新，可在切换后直接检查标题栏。
- **macOS**：`updateWindowFrameAppearance` 在非 win32 早退；`titlebar.color` 只在窗口创建时作为 `backgroundColor` 生效。切换皮肤后标题栏/窗口底色可能不变，需重启窗口。不要把 macOS 的这个行为判定为皮肤配置错误。
- 验收结论要写明平台；Windows 的标题栏结论不能直接套到 macOS。

## 5. 交付措辞

- 只有静态或产物层面验证时，只能称“静态 / 产物层面已验证”。
- 没有真实窗口或 computed-style 证据时，不能称“皮肤已实现”。
- “透明底”必须写清是哪一种：桌面穿透（主窗口能力，皮肤做不到）/ 层间半透明（皮肤可做，需 computed 或截图证据）/ 局部无背板。
- 不把“源码已改”“构建成功”“安装成功”表述为完成。

最终回复应列明：
- 新增或修改皮肤的名称与 id；
- 涉及的文件（皮肤包目录与源码改动）；
- 分层色板或关键 token（外壳 / 主画布 / 卡片 / 输入 / 浮层 / 消息）；
- 临时探针或调试器是否已删除；
- 已执行的构建、产物与运行时验证（注明平台与证据类型）；
- 未验证项（尤其运行时 computed-style、是否需要重启主进程、标题栏是否已看过、多窗口同步）。
