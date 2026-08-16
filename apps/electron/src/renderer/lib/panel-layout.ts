/**
 * 面板自适应布局 — 可见性判定（纯函数层）
 *
 * 模型：把面板的「展开意图 A」与「实际可见 B」分离。
 * - A 只跟随用户手动操作（点开 = true，点关 = false），不随窗口大小变化；
 * - B = A 为 true 且 窗口宽度足够；窗口变窄只让 B 变 false，A 保持不变；
 * - 窗口拉宽后，A=true 的面板自动显示。
 *
 * 参与自动可见性判定的面板：浏览器、右侧文件面板。
 * 左侧栏保持纯手动行为，不参与自适应；其宽度（展开 300）仍计入布局判定。
 */

/** 布局输入：sidebar 为实际展开（手动、固定）；filePanel/browser 为展开意图 A */
export interface PanelLayoutState {
  /** 左侧栏是否展开（手动控制，不参与自动收起） */
  sidebar: boolean
  /** 文件面板展开意图 A */
  filePanel: boolean
  /** 浏览器展开意图 A */
  browser: boolean
}

/** 面板实际可见性 B */
export interface PanelVisibility {
  browser: boolean
  filePanel: boolean
}

/** 对话区永不折叠的最小宽 */
export const CONVERSATION_MIN_WIDTH = 420
/** 左侧栏展开宽（折叠态 60，不参与判定） */
export const SIDEBAR_WIDTH = 300
/** 文件面板展开最小宽 */
export const FILE_PANEL_MIN_WIDTH = 300
/** 浏览器最小宽 */
export const BROWSER_MIN_WIDTH = 360
/** 分栏间隙 + 边距余量 */
export const GAP_BUFFER = 16
/** 滞后带：从不可见恢复可见需要「所需宽 + 该值」，避免窗口停在临界值附近反复闪烁 */
export const HYSTERESIS = 50

/**
 * 计算给定展开组合的最小所需窗口宽。
 * 例：三面板全开 420+300+300+360+16=1396；无浏览器 1036；仅侧栏 736；仅对话 436。
 */
export function layoutNeed(layout: PanelLayoutState): number {
  return CONVERSATION_MIN_WIDTH
    + (layout.sidebar ? SIDEBAR_WIDTH : 0)
    + (layout.filePanel ? FILE_PANEL_MIN_WIDTH : 0)
    + (layout.browser ? BROWSER_MIN_WIDTH : 0)
    + GAP_BUFFER
}

/**
 * 计算浏览器/文件面板的实际可见性 B（B = 意图 A && 窗口足够）。
 *
 * 收起优先级：浏览器最先让位（最脆弱）。
 * - 文件面板可见性不把浏览器宽度计入（浏览器总会先让位）；
 * - 浏览器可见性在「文件面板是否可见」的基础上叠加。
 *
 * 滞后带：prev 为上一次可见性。
 * - 当前可见的面板用收起阈值（W ≥ 所需宽）保持可见；
 * - 当前不可见的面板需达到展开阈值（所需宽 + HYSTERESIS）才恢复可见。
 * 这样窗口停在临界值附近时收起/展开各只触发一次，不会反复横跳。
 */
export function computeVisibility(
  windowWidth: number,
  layout: PanelLayoutState,
  prev: PanelVisibility,
): PanelVisibility {
  const base = CONVERSATION_MIN_WIDTH + (layout.sidebar ? SIDEBAR_WIDTH : 0) + GAP_BUFFER

  const filePanelThreshold = base + FILE_PANEL_MIN_WIDTH
  const filePanel = layout.filePanel
    ? (prev.filePanel
        ? windowWidth >= filePanelThreshold
        : windowWidth >= filePanelThreshold + HYSTERESIS)
    : false

  const browserThreshold = base + (filePanel ? FILE_PANEL_MIN_WIDTH : 0) + BROWSER_MIN_WIDTH
  const browser = layout.browser
    ? (prev.browser
        ? windowWidth >= browserThreshold
        : windowWidth >= browserThreshold + HYSTERESIS)
    : false

  return { browser, filePanel }
}
