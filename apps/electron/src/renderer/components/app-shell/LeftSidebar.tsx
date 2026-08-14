/**
 * LeftSidebar - 左侧导航栏
 *
 * 组件已按职责拆分到 left-sidebar/ 目录：
 * - use-left-sidebar.ts  状态 + handler + 派生数据（hook）
 * - rail.tsx             折叠态图标视图
 * - expanded-sidebar.tsx 展开态完整视图
 * - sidebar-dialogs.tsx  删除/迁移/加入工作区弹窗
 * - session-items.tsx    列表项子组件
 * - navigation-items.tsx 导航条目小件
 * - sidebar-utils.ts / session-tree.ts 纯函数工具
 *
 * 本文件仅负责 props 透传与折叠/展开外壳装配。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { SearchDialog } from './SearchDialog'
import { useLeftSidebar } from './left-sidebar/use-left-sidebar'
import { SidebarRail } from './left-sidebar/rail'
import { ExpandedSidebar } from './left-sidebar/expanded-sidebar'
import { SidebarDialogs } from './left-sidebar/sidebar-dialogs'

export type { LeftSidebarProps } from './left-sidebar/types'
import type { LeftSidebarProps } from './left-sidebar/types'

export function LeftSidebar({ width, noTransition, tabletMode, renderSearchDialog = true }: LeftSidebarProps): React.ReactElement {
  const s = useLeftSidebar(tabletMode)
  const isClassic = s.isClassic
  const sidebarCollapsed = s.sidebarCollapsed

  return (
    <div
      className={cn(
        'relative h-full overflow-hidden sidebar-collapse-ease',
        !noTransition && 'transition-[width] duration-300 will-change-[width] contain-layout',
        isClassic
          ? 'bg-background rounded-2xl shadow-xl dark:shadow-md'
          : 'bg-[hsl(var(--sidebar-surface))] rounded-2xl shadow-xl dark:shadow-md'
      )}
      style={{
        width: sidebarCollapsed ? 60 : width ?? 300,
        minWidth: sidebarCollapsed ? 60 : 200,
        flexShrink: sidebarCollapsed ? 0 : 1,
      }}
    >
      {sidebarCollapsed ? <SidebarRail s={s} /> : <ExpandedSidebar s={s} />}
      {/* 迁移/搜索对话框：双视图共享状态，必须只在外层渲染唯一实例，
          否则 Radix Portal 双实例同时打开会叠出双遮罩+双内容 */}
      <SidebarDialogs s={s} />
      {renderSearchDialog && <SearchDialog />}
    </div>
  )
}
