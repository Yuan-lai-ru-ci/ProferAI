/**
 * types.ts — 侧边栏共享类型
 *
 * 从 LeftSidebar.tsx 抽离的公共接口，供主文件与 use-left-sidebar hook 共用。
 */

export interface LeftSidebarProps {
  /** 可选固定宽度，默认使用 CSS 响应式宽度 */
  width?: number
  /** 拖拽过程中禁用 CSS transition，保证即时响应 */
  noTransition?: boolean
  /** 是否渲染全局搜索对话框（SearchDialog）。移动版存在横屏固定侧栏 + 竖屏抽屉两个
   *  LeftSidebar 实例，SearchDialog 绑定全局 atom 且 Portal 到 body，必须只渲染一份，
   *  否则双实例同时打开会叠出双遮罩、互相触发 interactOutside 导致搜索框“一闪即逝”。 */
  renderSearchDialog?: boolean
}
