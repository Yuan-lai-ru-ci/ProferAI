import * as React from 'react'

/**
 * 过程区渲染窗口的「折叠边界」推进时机。
 *
 * 窗口裁剪会把**已经渲染出来的段**从 DOM 里移走。一旦这种移除发生在内容可见期间，
 * 用户看到的就是：过程列表被从顶部抽掉一段、下方内容整体重排，折叠按钮又凭空插入——
 * 也就是「一收缩就闪一下」。而这些段在进入折叠之前早已挂载过一次，裁掉它省不到任何
 * 创建成本；窗口真正的收益只在「内容重新挂载」时兑现（重新展开长过程、加载历史轮）。
 *
 * 所以这里的规则只有一条：**边界只在过程内容未挂载时推进**。
 * - 流式期间过程组是展开的（内容已挂载）→ 边界冻结，新段只追加、绝不回收已渲染的段；
 * - 一轮输出结束、过程组自动收起（内容卸载）→ 此时推进边界，用户看不到任何重排；
 * - 首次渲染就按当时的段数折叠——那才是挂载成本真正被省下的时刻。
 *
 * 两条兜底：
 * - 可见期间边界也不允许超过尾部窗口：段数因回退/压缩变少时，至少保留最近 limit 段，
 *   不会因为冻结了旧的大边界而把整组折光；
 * - 内容不可见时边界跟随段数继续收敛，避免「收起状态下又长了很多段、再展开」时
 *   一次性把全部段渲染出来。
 */

/** 尾部窗口语义下应折叠的前导段数：保留最近 limit 段，更早的进折叠区。 */
export function computeProcessFoldCount(totalSegments: number, limit: number): number {
  return Math.max(0, totalSegments - Math.max(0, limit))
}

/**
 * 冻结值与段数共同决定的实际折叠段数。
 *
 * @param frozenFold 上一次在「内容不可见」或「挂载瞬间」固化下来的边界
 * @param visible 过程内容此刻是否在 DOM 里
 */
export function resolveProcessFoldCount(
  frozenFold: number,
  totalSegments: number,
  limit: number,
  visible: boolean,
): number {
  const tailWindowFold = computeProcessFoldCount(totalSegments, limit)
  return visible
    ? Math.min(Math.max(0, frozenFold), tailWindowFold)
    : Math.max(Math.max(0, frozenFold), tailWindowFold)
}

export interface ProcessFoldGate {
  /** 交给 applyRenderWindow 的 processFoldCount */
  foldCount: number
  /** 过程组内容挂载状态变化时上报（接 ProcessBlockGroup.onContentVisibilityChange） */
  reportContentVisibility: (visible: boolean) => void
}

/**
 * @param segmentCount 当前过程段总数（一轮至多一个过程组，取该组的段数）
 * @param limit 窗口保留的段数（DEFAULT_RENDER_WINDOW.processSegments）
 */
export function useProcessFoldGate(segmentCount: number, limit: number): ProcessFoldGate {
  // 首次渲染即折叠：这是挂载时刻，折叠与首帧一起出现，不构成可见重排。
  const [frozenFold, setFrozenFold] = React.useState(() => computeProcessFoldCount(segmentCount, limit))
  const segmentCountRef = React.useRef(segmentCount)
  const visibleRef = React.useRef(true)
  // 下面两个 ref 只被回调读取（不在渲染期读），保持最新值即可。
  segmentCountRef.current = segmentCount

  const foldCount = resolveProcessFoldCount(frozenFold, segmentCount, limit, visibleRef.current)
  const foldCountRef = React.useRef(foldCount)
  foldCountRef.current = foldCount

  const reportContentVisibility = React.useCallback((visible: boolean) => {
    visibleRef.current = visible
    // 挂载瞬间固化当前边界 → 此后新增段只追加；卸载后按当时段数收敛到尾部窗口。
    setFrozenFold(visible
      ? foldCountRef.current
      : computeProcessFoldCount(segmentCountRef.current, limit))
  }, [limit])

  return { foldCount, reportContentVisibility }
}
