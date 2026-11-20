/**
 * LeftSidebar - 左侧导航栏
 *
 * 组件已按职责拆分到 left-sidebar/ 目录：
 * - use-left-sidebar.ts  状态 + handler + 派生数据（hook）
 * - rail.tsx             常驻图标列（54px，导航 + 身份）
 * - expanded-sidebar.tsx 列表视图（新建/搜索 + 项目树 / 会话）
 * - sidebar-dialogs.tsx  删除/迁移/加入工作区弹窗
 * - session-items.tsx    列表项子组件
 * - navigation-items.tsx 导航条目小件
 * - sidebar-utils.ts / session-tree.ts 纯函数工具
 *
 * 本文件负责外壳装配：宽度语义、rail + 列表两栏、拖拽留白、红绿灯与弹窗。
 *
 * 宽度语义：外壳宽 = 54（常驻 rail）+ 列表宽；收起时只留 58 的 rail。
 * 54 + 246 = 300，与 lib/panel-layout.ts 的 SIDEBAR_WIDTH 预算保持一致。
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { SearchDialog } from "./SearchDialog";
import { useLeftSidebar } from "./left-sidebar/use-left-sidebar";
import { SidebarRail } from "./left-sidebar/rail";
import { ExpandedSidebar } from "./left-sidebar/expanded-sidebar";
import { SidebarDialogs } from "./left-sidebar/sidebar-dialogs";
import { SIDEBAR_HEADER_INSET, SIDEBAR_PANEL_TOP, SidebarWindowDragStrip } from "./left-sidebar/navigation-items";
import { useTabBarBottomOffset } from "./left-sidebar/use-tabbar-offset";
import { MacTrafficLights } from "./MacTrafficLights";
import { detectIsWindows } from "@profer/ui";

export type { LeftSidebarProps } from "./left-sidebar/types";
import type { LeftSidebarProps } from "./left-sidebar/types";

/** 常驻 rail 宽度 */
const RAIL_WIDTH = 54;
/** 收起态外壳宽：rail 居中，左右各留 2px */
const COLLAPSED_WIDTH = 58;
/** 列表宽度默认值与下限（与 atoms/sidebar-atoms、AppShell 的 clamp 对齐） */
const DEFAULT_LIST_WIDTH = 246;
const MIN_LIST_WIDTH = 230;

export function LeftSidebar({
  width,
  noTransition,
  collapsedOverride,
  widthOverride,
  listWidthOverride,
  listTranslateX,
  transitionDurationMs,
  renderSearchDialog = true,
}: LeftSidebarProps): React.ReactElement {
  const s = useLeftSidebar();
  const isClassic = s.isClassic;
  const sidebarCollapsed = collapsedOverride ?? s.sidebarCollapsed;
  // rail 跟随当前吸附预览切换，不等待列表卸载或鼠标松开。
  const sidebarModel = sidebarCollapsed === s.sidebarCollapsed
    ? s
    : { ...s, sidebarCollapsed };
  const listWidth = listWidthOverride
    ?? (widthOverride !== undefined
      ? Math.max(0, widthOverride - RAIL_WIDTH)
      : width ?? DEFAULT_LIST_WIDTH);
  // 面板顶边与 Tab 标签本体下沿对齐：运行时量真实 DOM，量不到才用常量兜底。
  const measuredPanelTop = useTabBarBottomOffset(SIDEBAR_PANEL_TOP);
  // Windows 顶部没有红绿灯，侧栏不需要给顶栏让位：rail 与列表直接顶到窗口上沿。
  // 此时 ModeSwitcher 轨道（pt-2 + 40）与主区 TabBar 外框（p-2 + 40）同高，横竖都对得上。
  const isWindows = React.useMemo(() => detectIsWindows(), []);
  const panelTop = isWindows ? 0 : measuredPanelTop;

  return (
    <div
      data-profer-sidebar=""
      className={cn(
        "relative h-full overflow-hidden sidebar-collapse-ease",
        !noTransition &&
          (transitionDurationMs !== undefined
            ? "transition-[width] will-change-[width] contain-layout"
            : "transition-[width] duration-300 will-change-[width] contain-layout"),
        // rail 与顶部共用外壳底面；列表单独着色，不能再给 rail 重复铺底。
        "bg-sidebar rounded-2xl shadow-xl dark:shadow-md",
        // isolate + -z-10：着色层压在 stacking context 底部，位于外壳底色之上、所有内容之下。
        "isolate before:absolute before:inset-0 before:-z-10 before:bg-foreground/[0.035] before:content-['']",
      )}
      style={{
        width: sidebarCollapsed
          ? COLLAPSED_WIDTH
          : RAIL_WIDTH + listWidth + (listTranslateX ?? 0),
        minWidth: sidebarCollapsed
          ? COLLAPSED_WIDTH
          : RAIL_WIDTH + Math.min(MIN_LIST_WIDTH, listWidth) + (listTranslateX ?? 0),
        flexShrink: sidebarCollapsed ? 0 : 1,
        ...(transitionDurationMs !== undefined && {
          transition: `width ${transitionDurationMs}ms cubic-bezier(0.32, 0.72, 0, 1)`,
        }),
      }}
    >
      {/* 顶部拖拽留白整条覆盖 rail + 列表，高度取 Tab 标签本体的下沿（运行时实测）；
          rail 图标与列表内容都从这条线开始，红绿灯（18–38）落在它上方。
          Windows 的 panelTop 为 0（没有红绿灯要让位），不再渲染这条 0 高拖拽条；
          窗口拖动交给 AppShell 顶部那条全局 8px 拖拽带。 */}
      {panelTop > 0 && <SidebarWindowDragStrip height={panelTop} />}

      <div className="relative h-full min-h-0">
        {/* rail 只承载导航，列表由右侧视口裁切，不依赖不透明背景遮挡。 */}
        <div
          className="relative z-20 h-full overflow-hidden transition-[width] duration-200 sidebar-collapse-ease motion-reduce:transition-none"
          style={{ width: sidebarCollapsed ? COLLAPSED_WIDTH : RAIL_WIDTH }}
        >
          <SidebarRail s={sidebarModel} topOffset={panelTop + SIDEBAR_HEADER_INSET} />
        </div>
        {(listTranslateX !== undefined || !sidebarCollapsed) && (
          <div
            className="absolute inset-y-0 right-0 z-10 overflow-clip"
            style={{ left: sidebarCollapsed ? COLLAPSED_WIDTH : RAIL_WIDTH }}
          >
            <div
              className="relative h-full min-w-0"
              style={{
                left: listTranslateX ?? 0,
                width: listWidth,
                paddingTop: panelTop,
                ...(transitionDurationMs !== undefined && {
                  transition: `left ${transitionDurationMs}ms cubic-bezier(0.32, 0.72, 0, 1)`,
                }),
              }}
            >
              {/* 固定视口裁掉滑入 rail 的部分，包括半透明底色与鼠标命中区域。 */}
              <div className="h-full overflow-hidden rounded-tl-[10px] bg-sidebar">
                <ExpandedSidebar s={s} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 红绿灯必须最后渲染，确保位于左上拖拽层之上；只有这块区域退出窗口拖拽。 */}
      {s.isMac && (
        <MacTrafficLights classic={isClassic} collapsed={sidebarCollapsed} />
      )}
      {/* 迁移/搜索对话框：双视图共享状态，必须只在外层渲染唯一实例，
          否则 Radix Portal 双实例同时打开会叠出双遮罩+双内容 */}
      <SidebarDialogs s={s} />
      {renderSearchDialog && <SearchDialog />}
    </div>
  );
}
