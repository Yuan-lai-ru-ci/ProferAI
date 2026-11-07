# rail 全屏页顶部规范

> 2026-11-07 起生效。适用于侧边栏 rail 上的全部页面：Todo、日程、定时任务、Goal 概览、
> Agent 技能、Agent 记忆、我的画像，以及从这些页面进入的二级页（全局记忆）。

## 为什么要有这条规范

这些页面整块取代 TabBar，每个页面都得自己处理「拖拽带 / 窗口按钮 / 标题区 / 工具条 / 内容宽度」。
2026-11 之前各页各写一遍，结果是同一个应用里存在五套顶部：

| 页面 | 改前标题字号 | 改前返回入口 | 改前窗口按钮 | 改前内容宽度 |
| --- | --- | --- | --- | --- |
| 规划中心 | 24px | 无 | 绝对定位 | 不限宽 |
| Agent 技能 | 24px + 图标 + 二级说明卡 | 文字返回（占一整行） | 绝对定位 | `max-w-6xl` |
| Agent 记忆 | 17px | 文字返回 | 绝对定位 | `max-w-6xl` |
| 我的画像 | 12px 面包屑 | 图标按钮 | 挤在流内 | `max-w-[1440px]` |
| 全局记忆 | 17px | ghost 按钮 | 挤在流内 | `max-w-6xl` |

现在统一由 `apps/electron/src/renderer/components/app-shell/FullScreenView.tsx` 提供骨架，
页面只描述「标题是什么、右侧有什么动作、内容是什么」。

## 结构

```text
┌──────────────────────────────────────────────────────────┐
│ 56px 拖拽带（drag region，到窗口按钮前结束）   ▢ ▢ ▢ ←窗口按钮 │
├──────────────────────────────────────────────────────────┤
│ 返回  标题(24px)  [统计chip]  一句说明 ······ [动作][主操作] │  ← ViewHeader
│ [分段切换] [搜索框] [次级动作]                             │  ← ViewToolbar（可选）
├──────────────────────────────────────────────────────────┤
│ 页面内容                                                   │  ← ViewBody
└──────────────────────────────────────────────────────────┘
```

## 尺寸与样式（唯一标准）

| 元素 | 规格 |
| --- | --- |
| 拖拽带 | 56px 高，`inset-x-0 top-0`，右侧为窗口按钮让位（`resolveWindowControlsRightInset`） |
| 窗口按钮宿主 | `WindowControlsHost`，`priority={20}`，`absolute right-2 top-[3px] z-20` |
| 水平内边距 | `px-4 sm:px-6 lg:px-8`，标题区 / 工具条 / 内容区三处必须同值 |
| 标题 | `text-2xl font-semibold tracking-tight`，不允许页面改字号 |
| 副标题 | `text-[13px] text-muted-foreground`，跟在标题右侧，过长自行截断 |
| 统计 chip | `rounded-full bg-muted/65 px-2 py-1 text-xs tabular-nums` |
| 返回 | 图标 14px + 「返回」13px 次要色；一级页返回对话列表，二级页返回上一级 |
| 头部控件高度 | 统一 `h-8`（主按钮、次级按钮、搜索框、工作区切换） |
| 主操作 | 每个页面**一个**，位于页头最右侧，四个规划入口共用同一位置；外观用 `Button` 原语 |
| 内容宽度 | 两档，页头与内容必须同档（见下） |
| 间距 | 页头 `pb-4`；内容底部 `pb-5`（可滚动列表 `pb-10`） |

## 内容宽度两档

| 档位 | 宽度 | 用于 |
| --- | --- | --- |
| `standard` | `max-w-[1440px]` | 所有内容页：Agent 技能、Agent 记忆、全局记忆、我的画像 |
| `full` | 不限 | 数据密集型工作台：规划中心（看板 / 日历） |

只保留两档是刻意的：内容页宽度多一档，用户就会看到「Agent 技能比我的画像窄一点」，
而这种差异没有语义。页头 `ViewHeader`、工具条 `ViewToolbar`、内容 `ViewBody`
传同一个 `width`；默认就是 `standard`，只有规划中心显式传 `full`。

## 用法

```tsx
<FullScreenView region="agent-memory" controlsId="agent-memory">
  <ViewHeader
    title="Agent 记忆"
    subtitle="当前工作区的长期资料：规则、偏好与已验证经验"
    back={{ label: '返回当前 Agent 会话', onClick: () => setActiveView('conversations') }}
    actions={
      <>
        <ViewSearchField value={search} onChange={setSearch} placeholder="搜索记忆正文" searchId="agent-memory" />
        <AgentWorkspaceSwitcher … />
      </>
    }
  />
  <ViewBody>…</ViewBody>
</FullScreenView>
```

可用导出：

- `FullScreenView` — 外壳：区域标识、内容区底色、拖拽带、窗口按钮宿主
- `ViewHeader` — 页头：返回、标题、统计、说明、右侧动作
- `ViewToolbar` — 页头下方的工具条行（与页头同宽同内边距）
- `ViewBody` — 内容区（`scroll` 打开整页滚动）
- `ViewSearchField` — 唯一搜索框外观（`searchId` 渲染成 `data-view-search`）

页头按钮不另定外观，一律用 `@profer/ui/primitives/button`：
主操作用默认变体，次级操作用 `variant="outline"`，统一 `size="sm"` + `className="h-8 gap-1.5 px-3 text-[13px] font-medium"`。

## 禁止事项

1. 页面里不要再写 `titlebar-drag-region`、`mt-14`、`WindowControlsHost`——骨架已经声明，
   重复声明会给同一页注册两个宿主（同优先级按注册顺序决出，按钮会跳位）。
2. 不要单独定义标题字号、搜索框样式或页头内边距；需要新外观先改 `FullScreenView.tsx`。
3. 不要把主操作放回内容卡片的工具条里；内容卡片只承载内容自己的工具栏（例如日历的时间导航）。
4. 不要在页头用第二套按钮高度（`h-9` / `py-2`）；页头控件一律 `h-8`。

## 验收

- `apps/electron/src/renderer/lib/window-controls-host-coverage.test.ts` 会检查：
  骨架声明了宿主与拖拽带；上述每个页面都渲染 `<FullScreenView>`。
- Windows 真机需另行确认按钮位置与单击命中（高 DPI 125% / 150% / 175%）。
