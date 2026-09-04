# 平板版设置页面设计（2026-08-07）

状态：✅ 已实施（2026-08-07，构建 + typecheck 通过）
范围：`tablet-app` 设置页（UI 实现在桌面 renderer 的 `tablet` 入口，见 `apps/electron/src/renderer/tablet/main.tsx`）

## 1. 背景与现状

平板版复用桌面 `SettingsDialog`（`components/settings/SettingsDialog.tsx`），通过 `tabsOverride` 白名单只暴露「外观设置」一个 tab。数据层为 WS 直连电脑端 remote-service。

现状问题：

- 设置入口只有外观，平板核心本地配置（连接/解绑）散落在连接页与顶栏 Link 图标
- 外观页两个控件在平板上失效或冗余：
  - 「界面大小」有 6 档（100%～200%），175%/200% 在平板上过度放大、挤压可视内容
  - 「Agent 预览展开方式」是纯摆设：平板端无 MainArea/TabBar 渲染 PreviewPanel，且 WS 协议无 `read_file` 指令，点「预览」按钮无任何效果

## 2. 定位决策（已与用户确认）

**仅本地设备设置**：平板设置只放设备自身可管内容（连接/解绑、外观、通知）。远程能力（模型配置、提示词、快捷键、语音输入、订阅、团队等）一律引导去电脑端，不暴露空壳 tab。

## 3. Tab 结构

最终清单（标签栏顺序）：**连接 → 外观 → 通知**

### 3.1 连接（新增）

| 区块 | 内容 | 说明 |
|---|---|---|
| 连接状态 | 徽标：已连接 / 重连中 / 未绑定 | 由 `connection` state 派生 |
| 服务器地址 | 只读展示当前地址（含自动推导场景） | 不改地址编辑，改地址=重绑定语义，走解绑→连接页 |
| 访问令牌 | 掩码展示（后 4 位可见）+ 复制按钮 | 校验失败提示去连接页重新输入 |
| 解绑此设备 | 危险操作红色按钮 | 复用现有 `unbindConfirmOpen` 确认弹窗（清 token/服务器地址/last-view，回连接页） |

与现有入口职责划分：连接页保留首次绑定输入；顶栏 Link 图标保留快捷解绑；「连接」tab 为状态管理中枢。三处不重叠。

### 3.2 外观（调整）

- **界面大小**：平板只保留 4 档（标准 100% / 大 110% / 特大 125% / 超大 150%），去掉 175% 巨大 / 200% 最大
- **Agent 预览展开方式**：平板端整行隐藏（功能不可用，见 §5）
- 主题模式、特殊风格、Markdown 字号：原样保留

### 3.3 通知（新增）

| 区块 | 内容 |
|---|---|
| Agent 完成提醒音 | 单个开关（默认关）。Agent 回合完成（`run_completed` / `run_idle`）时播放短促提示音 |
| 说明文案 | 诚实告知：仅在 App 前台/正在查看时提醒；App 在后台时 Android WebView 冻结、WS 断开，无法推送系统通知 |

技术实现：Web Audio API（AudioContext + oscillator 合成提示音），零插件依赖，浏览器与 Capacitor WebView 通用。开关存 localStorage（如 `profer-remote-notify-complete`）。播放时机：开关开启 且 完成事件所属会话**不是当前正在查看的会话**（避免自己盯着屏幕时被提醒）。

## 4. 预览按钮处理（已确认：本轮隐藏）

平板端点「预览」按钮 = 点了没反应。根因：

1. UI 层：`file-path-chip.tsx` / `message.tsx` 的 `openPreview` 无 tabletMode 判断；`PreviewPanel`/Tab 系统只在桌面 MainArea 渲染，平板 `main.tsx` 直接渲染 `AgentView`，打开状态写进 atom 无处显示
2. 数据层：WS 协议无 `read_file` 指令（桌面预览靠 Electron IPC 读文件）

本轮方案：`tabletMode` 下隐藏消息内的预览按钮（`tabletMode` prop 需从 `AgentMessages` 向下传递到 `message` / `file-path-chip`）。

后续迭代（独立一轮）：remote-service 增加 `read_file` 指令（校验路径防越权）→ 平板只读预览 Dialog/抽屉（文本/图片）。

## 5. 实现路径

| 文件 | 改动 |
|---|---|
| `apps/electron/src/renderer/types/settings.ts` | `SettingsTab` 类型增加 `connection` / `notifications` |
| `components/settings/TabletConnectionSettings.tsx` | 新增，连接状态/地址/Token/解绑 |
| `components/settings/TabletNotificationSettings.tsx` | 新增，完成提醒音开关 |
| `components/settings/SettingsPanel.tsx` | `renderTabContent` 增加两个 case（桌面不暴露，无影响） |
| `components/settings/AppearanceSettings.tsx` | 加 `tabletMode?: boolean` prop：界面大小选项裁剪到 4 档、隐藏预览展开方式行 |
| `tablet/main.tsx` | `TABLET_SETTINGS_TABS` 改为 连接/外观/通知；`handleAgentEvent` 完成事件播放提醒音；连接 tab 的解绑复用现有弹窗 |
| `components/agent/AgentMessages.tsx` 及 `ai-elements/message.tsx`、`file-path-chip.tsx` | `tabletMode` 向下传递，隐藏预览按钮 |

## 6. 明确不做

- 后台系统通知（需完整推送通道，另一量级工程）
- 远程设置暴露（模型/提示词/快捷键/语音/订阅/团队）
- 服务器地址原地编辑（重绑定语义，走解绑）
- `read_file` 完整预览（记入后续迭代）

## 7. 手机竖屏适配（2026-08-07 补充）

现状：竖屏适配已有一批（弹窗 94vw×92vh、输入框加高 60px、消息区拓宽、模型名只留图标、安全区、隐藏滚动条等，见 globals.css `body.tablet-mode` 竖屏区间）。

本次新增 tab 后暴露的缺口与修复：
- **tab 切换入口丢失**：旧版竖屏直接把 `.settings-nav` `display:none`（当时只有 1 个 tab 无需切换）；现在 3 个 tab，隐藏导航 = 用户切不到外观/通知。修复：`.settings-body`（SettingsPanel 主体容器新增类名）竖屏改 `flex-direction: column`，`.settings-nav` 变顶部横向 tab 条（flex row + 横向滚动 + 下边框），保留切换能力。
- **特殊风格 8 宫格溢出**：固定 99px 卡片 × 4 列在 <430px 窄屏溢出。修复：`AppearanceSettings` 的 grid 加 `tablet-special-grid` 类，竖屏改 2 列居中。
- **滚动约束**：`ScrollArea` 加 `min-h-0`（竖屏 flex-col 链需要）。
- 修改文件：`SettingsPanel.tsx`（settings-body / min-h-0）、`AppearanceSettings.tsx`（tablet-special-grid）、`globals.css`（竖屏区间重写）。
