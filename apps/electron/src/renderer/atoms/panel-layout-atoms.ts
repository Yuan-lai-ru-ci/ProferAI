/**
 * 面板自适应布局 — 状态原子
 *
 * 模型：面板的「展开意图 A」与「实际可见 B」分离。
 * A（browserOpenMap / agentSidePanelOpenAtom）只随用户手动操作变化；
 * B（本文件的 panelVisibilityAtom）由 usePanelAutoLayout 依据窗口宽度统一计算。
 * 组件只读共享状态，避免 MainArea / AppShell / TabBar 各自订阅窗口造成竞态。
 */

import { atom } from 'jotai'
import type { PanelVisibility } from '@/lib/panel-layout'

/** 当前窗口宽度（px）。初始取渲染进程当前内宽；由 usePanelAutoLayout 的 resize 监听维护。 */
export const windowWidthAtom = atom<number>(
  typeof window !== 'undefined' ? window.innerWidth : 1200,
)

/**
 * 文件面板/浏览器是否参与布局判定（agent 个人视图）。
 * 团队工作区、规划中心、Agent 技能、自动化表单等视图不渲染右侧文件面板/浏览器，
 * 由 usePanelAutoLayout 依据 AppShell 传入的作用域同步。
 */
export const layoutScopeActiveAtom = atom<boolean>(true)

/**
 * 浏览器/文件面板当前实际可见性 B。
 * 初始视为「曾可见」，避免冷启动窗口刚好够宽时因滞后带产生死区（需多 50px 才显示）。
 */
export const panelVisibilityAtom = atom<PanelVisibility>({ browser: true, filePanel: true })
