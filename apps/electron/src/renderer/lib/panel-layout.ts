/**
 * 面板自适应布局 — 可见性判定（纯函数层）
 *
 * 模型：把面板的「展开意图 A」与「实际可见 B」分离。
 * - A 只跟随用户手动操作（点开 = true，点关 = false），不随窗口大小变化；
 * - B = A 为 true 且 窗口宽度足够；窗口变窄只让 B 变 false，A 保持不变；
 * - 窗口拉宽后，A=true 的面板自动显示。
 *
 * 参与自动可见性判定的面板：右侧文件面板。
 * 受管浏览器已 Tab 化（工作 Tab + 组合并排），不再参与窗口宽度预算。
 * 左侧栏保持纯手动行为，不参与自适应；其宽度（展开 300）仍计入布局判定。
 */

/** 布局输入：sidebar 为实际展开（手动、固定）；filePanel 为展开意图 A */
export interface PanelLayoutState {
  /** 左侧栏是否展开（手动控制，不参与自动收起） */
  sidebar: boolean
  /** 文件面板展开意图 A */
  filePanel: boolean
  /**
   * 主区对话栏数：组合 tab 激活时为 2，否则 1。
   * 必须按栏数算，否则「组合 + 文件面板」在 1400px 级窗口上会被判「宽度够」，
   * 实际结果是面板保住自己的最小宽、两个会话被压到 CONVERSATION_MIN_WIDTH 以下。
   */
  mainPaneCount: number
}

/** 面板实际可见性 B */
export interface PanelVisibility {
  filePanel: boolean
}

/** 对话区永不折叠的最小宽（单栏） */
export const CONVERSATION_MIN_WIDTH = 420
/**
 * 组合两栏之间的分栏缝。
 * 必须与 atoms/tab-group-atoms 的 GROUP_SPLIT_GAP 同值（那边渲染、这边算预算）；
 * panel-layout.test.ts 里有一条断言锁住二者相等，避免将来只改一边。
 */
export const PANE_SPLIT_GAP = 8
/** 左侧栏展开宽（折叠态 60，不参与判定） */
export const SIDEBAR_WIDTH = 300
/** 文件面板展开最小宽 */
export const FILE_PANEL_MIN_WIDTH = 300
/** 分栏间隙 + 边距余量 */
export const GAP_BUFFER = 16
/** 滞后带：从不可见恢复可见需要「所需宽 + 该值」，避免窗口停在临界值附近反复闪烁 */
export const HYSTERESIS = 50

/**
 * 主区（对话区）最小所需宽度：每栏各需 CONVERSATION_MIN_WIDTH，栏间还要让出分栏缝。
 * 1 栏 = 420；2 栏（组合）= 420×2 + 8 = 848。
 */
export function mainAreaNeed(paneCount: number): number {
  const panes = Math.max(1, Math.floor(paneCount))
  return CONVERSATION_MIN_WIDTH * panes + (panes - 1) * PANE_SPLIT_GAP
}

/**
 * 计算给定展开组合的最小所需窗口宽。
 * 例：单栏 + 侧栏 + 文件面板 = 420+300+300+16=1036；仅侧栏 736；仅对话 436。
 * 组合（两栏）时对话区换成 848：组合+左栏 1164；再加文件面板 1464。
 */
export function layoutNeed(layout: PanelLayoutState): number {
  return mainAreaNeed(layout.mainPaneCount)
    + (layout.sidebar ? SIDEBAR_WIDTH : 0)
    + (layout.filePanel ? FILE_PANEL_MIN_WIDTH : 0)
    + GAP_BUFFER
}

/**
 * 计算文件面板的实际可见性 B（B = 意图 A && 窗口足够）。
 *
 * 滞后带：prev 为上一次可见性。
 * - 当前可见时用收起阈值（W ≥ 所需宽）保持可见；
 * - 当前不可见时需达到展开阈值（所需宽 + HYSTERESIS）才恢复可见。
 * 这样窗口停在临界值附近时收起/展开各只触发一次，不会反复横跳。
 *
 * 组合（mainPaneCount = 2）只是把对话区所需宽度换成 mainAreaNeed(2)，其余规则不变。
 */
export function computeVisibility(
  windowWidth: number,
  layout: PanelLayoutState,
  prev: PanelVisibility,
): PanelVisibility {
  const threshold = mainAreaNeed(layout.mainPaneCount)
    + (layout.sidebar ? SIDEBAR_WIDTH : 0)
    + FILE_PANEL_MIN_WIDTH
    + GAP_BUFFER

  const filePanel = layout.filePanel
    ? (prev.filePanel
        ? windowWidth >= threshold
        : windowWidth >= threshold + HYSTERESIS)
    : false

  return { filePanel }
}
