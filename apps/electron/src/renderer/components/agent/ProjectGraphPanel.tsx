/**
 * ProjectGraphPanel — 无界画板任务图可视化（思维导图风格）
 *
 * 支持缩放（滚轮）、平移（拖拽）、节点选中交互。
 * 作为 TaskProgressLink 的 Dialog 内容使用。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  GitBranch,
  Loader2,
  CheckCircle2,
  Circle,
  XCircle,
  AlertCircle,
  Clock,
  FileText,
  ExternalLink,
  RefreshCw,
  CircleSlash,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { currentAgentSessionIdAtom, graphQuestionAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { currentGraphAtom, persistedGraphAtomFamily } from '@/atoms/graph-atoms'
import dagre from '@dagrejs/dagre'
import { type TaskGraph, type TaskNode, type TaskStatus } from '@profer/project-core'
import { GraphQuestionInput } from './GraphQuestionInput'
import { useOpenSession } from '@/hooks/useOpenSession'

// 呼吸动画样式（注入一次）—— 4s 周期，柔和渐变
const breatheStyle = `
@keyframes breathe {
  0%, 100% { box-shadow: 0 0 4px rgba(96,165,250,0.05), 0 0 8px rgba(96,165,250,0.03); }
  50% { box-shadow: 0 0 10px rgba(96,165,250,0.14), 0 0 20px rgba(96,165,250,0.05); }
}
.animate-breathe { animation: breathe 4s ease-in-out infinite; }
`
let styleInjected = false
function injectBreatheStyle() {
  if (styleInjected || typeof document === 'undefined') return
  const el = document.createElement('style')
  el.textContent = breatheStyle
  document.head.appendChild(el)
  styleInjected = true
}

// ===== 常量 =====

const NODE_W = 260
const NODE_H = 100
const LEVEL_GAP = 80
const NODE_GAP_Y = 16
const CANVAS_PAD = 70
// 孤立节点网格平铺时的单元间距（横向略大以留出卡片呼吸感）
const GRID_GAP_X = 48
const GRID_GAP_Y = 28

const MIN_SCALE = 0.25
const MAX_SCALE = 2.5
const ZOOM_STEP = 0.1

// 连线端点圆点半径
const DOT_R = 5

const statusConfig: Record<TaskStatus, { icon: React.ReactElement; color: string; border: string; lineColor: string }> = {
  pending:     { icon: <Circle className="size-4" />,                color: 'text-muted-foreground', border: 'border-border',                lineColor: 'hsl(var(--muted-foreground)/0.4)' },
  in_progress: { icon: <Loader2 className="size-4 animate-spin" />, color: 'text-blue-400',           border: 'border-blue-400/40',          lineColor: '#60a5fa' },
  completed:   { icon: <CheckCircle2 className="size-4" />,          color: 'text-emerald-500',        border: 'border-emerald-400/40',       lineColor: '#34d399' },
  failed:      { icon: <XCircle className="size-4" />,               color: 'text-red-400',            border: 'border-red-400/40',           lineColor: '#f87171' },
  cancelled:   { icon: <AlertCircle className="size-4" />,           color: 'text-amber-500',          border: 'border-amber-400/40',         lineColor: '#fbbf24' },
}

// ===== 数据 hook =====

function useGraphData(refreshVersion: number): { graph: TaskGraph | null; loading: boolean } {
  const atomGraph = useAtomValue(currentGraphAtom)
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const setPersistedGraph = useSetAtom(persistedGraphAtomFamily(sessionId ?? ''))
  const [ipcGraph, setIpcGraph] = React.useState<TaskGraph | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    if (!sessionId) { setIpcGraph(null); setLoading(false); return }
    let cancelled = false
    // 切换会话立即清空上一会话的残留图，避免 atomGraph 为空时 fallback 到旧 ipcGraph
    setIpcGraph(null)
    setLoading(true)
    const api = window.electronAPI as { getGraph?: (id: string) => Promise<TaskGraph> }
    if (!api.getGraph) { setLoading(false); return }
    api.getGraph(sessionId).then(g => {
      if (cancelled) return
      setIpcGraph(g)
      // 同步写回 persistedGraphAtomFamily，让 currentGraphAtom 的 baseline
      // 也有历史数据。流式期间 baseline 不再为空图，实时 TaskItem overlay 才能正常工作。
      if (g && Object.keys(g.nodes).length > 0) setPersistedGraph(g)
      setLoading(false)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId, refreshVersion, setPersistedGraph])

  // 仅在 IPC 已返回且 atom 也为空时才用 ipcGraph，避免 atom 和 ipc 的竞态
  const graph = atomGraph ?? ipcGraph
  return { graph, loading: loading && !graph }
}

// ===== 计算节点坐标（dagre 布局）=====

interface NodePosition { id: string; x: number; y: number }

const EMPTY_POSITIONS: NodePosition[] = []

interface DagreLayout {
  positions: NodePosition[]
  width: number
  height: number
}

/**
 * 布局：连通子图按分量用 dagre 分别布局（横向纵深过深的分量竖排 TB，其余横排 LR），
 * 孤立节点（不参与任何依赖/分叉边）在下方铺成网格。
 *
 * - dagre LR：被依赖节点在左、依赖方在右；TB：被依赖在上、依赖方在下。
 * - 布局默认横排；仅当某分量的 LR 横排纵深层级超过 VERTICAL_BEYOND_LR_DEPTH（横向拖得太远）
 *   时才转 TB 竖排回归，避免普通任务链被过早竖排。
 * - 孤立节点若丢给 dagre 会全挤进 rank 0 堆成一条长竖列，故单独抽出按网格平铺。
 * - dagre 返回中心点坐标，转换为左上角供 foreignObject 使用。
 */
function computeDagreLayout(graph: TaskGraph): DagreLayout {
  const nodeIds = Object.keys(graph.nodes)
  if (nodeIds.length === 0) return { positions: EMPTY_POSITIONS, width: 0, height: 0 }

  // 参与任意有效边（两端都存在）的节点 = 连通；其余 = 孤立
  const connectedIds = new Set<string>()
  for (const e of graph.edges) {
    if (graph.nodes[e.from] && graph.nodes[e.to]) { connectedIds.add(e.from); connectedIds.add(e.to) }
  }
  for (const e of graph.forkEdges) {
    if (graph.nodes[e.from] && graph.nodes[e.to]) { connectedIds.add(e.from); connectedIds.add(e.to) }
  }
  const isolatedIds = nodeIds.filter(id => !connectedIds.has(id))

  const positions: NodePosition[] = []
  let right = CANVAS_PAD
  let bottom = CANVAS_PAD

  // ---- 连通节点：按无向连通分量分组，逐分量独立布局 ----
  const comps = findConnectedComponents(graph, connectedIds)
  // 存储每个分量布局后的相对偏移（分量内坐标基准为 0,0）+ 尺寸
  const laidComps: { offsets: Map<string, NodePosition>; width: number; height: number }[] = []

  for (const comp of comps) {
    const isChainLike = isChainLikeComponent(graph, comp)
    const sub = layoutOneComponent(graph, comp, isChainLike)
    if (sub) laidComps.push(sub)
  }

  // 将各分量沿水平方向依次拼接（保持从左到右；若总宽超过一定阈值则换行，避免整体过宽）
  const COMP_GAP = LEVEL_GAP * 1.5
  let cursorX = CANVAS_PAD
  let cursorY = CANVAS_PAD
  let compMaxH = 0
  // 预估拼合总宽，超过视口容忍宽度（约 3200px）就垂直堆叠换行，避免又宽又长
  const MAX_COMPONENT_ROW_W = 3200
  let rowW = 0

  for (const c of laidComps) {
    const wouldRowW = rowW + c.width + (rowW > 0 ? COMP_GAP : 0)
    if (rowW > 0 && wouldRowW > MAX_COMPONENT_ROW_W) {
      // 换行：新的一行列，从左侧重新开始，y 下移一行
      cursorX = CANVAS_PAD
      cursorY += compMaxH + COMP_GAP
      rowW = 0
      compMaxH = 0
    }
    const dx = cursorX + (rowW > 0 ? COMP_GAP : 0)
    for (const pos of c.offsets.values()) {
      positions.push({ id: pos.id, x: pos.x + dx, y: pos.y + cursorY })
      right = Math.max(right, pos.x + dx + NODE_W)
      bottom = Math.max(bottom, pos.y + cursorY + NODE_H)
    }
    rowW += c.width + (rowW > 0 ? COMP_GAP : 0)
    compMaxH = Math.max(compMaxH, c.height)
  }

  // 孤立节点：网格平铺（放在全部连通分量下方；若整图无边则占满画布）
  let gridTop = connectedIds.size > 0 ? bottom + LEVEL_GAP : CANVAS_PAD
  let rightForGrid = connectedIds.size > 0 ? right : CANVAS_PAD
  if (isolatedIds.length > 0) {
    const cellW = NODE_W + GRID_GAP_X
    const cellH = NODE_H + GRID_GAP_Y
    // 列数略宽于高，避免又细又长；至少 1 列
    const cols = Math.max(1, Math.ceil(Math.sqrt(isolatedIds.length * 1.8)))
    isolatedIds.forEach((id, i) => {
      const x = CANVAS_PAD + (i % cols) * cellW
      const y = gridTop + Math.floor(i / cols) * cellH
      positions.push({ id, x, y })
      rightForGrid = Math.max(rightForGrid, x + NODE_W)
      bottom = Math.max(bottom, y + NODE_H)
    })
  }

  return { positions, width: rightForGrid + CANVAS_PAD, height: bottom + CANVAS_PAD }
}

/** 找出连通 nodes 的无向连通分量（基于依赖边 + 分叉边） */
function findConnectedComponents(graph: TaskGraph, connected: Set<string>): string[][] {
  const adj = new Map<string, Set<string>>()
  const ensure = (id: string) => { if (!adj.has(id)) adj.set(id, new Set()) }
  for (const id of connected) ensure(id)
  const attach = (a: string, b: string) => {
    if (!connected.has(a) || !connected.has(b)) return
    ensure(a); ensure(b)
    adj.get(a)!.add(b); adj.get(b)!.add(a)
  }
  for (const e of graph.edges) attach(e.from, e.to)
  for (const e of graph.forkEdges) attach(e.from, e.to)

  const seen = new Set<string>()
  const comps: string[][] = []
  for (const start of connected) {
    if (seen.has(start)) continue
    const comp: string[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const cur = stack.pop()!
      comp.push(cur)
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb) }
      }
    }
    comps.push(comp)
  }
  return comps
}

/**
 * 横向纵深阈值（层数，即 dagre LR 的 rank 跨度 = 最长链边数）。
 * 只有当横排会铺到超过这个层数（横向拖得太远）时才转竖排，否则保持横排。
 * 调大 → 更晚竖排（更多情况横排）；调小 → 更早竖排。
 */
const VERTICAL_BEYOND_LR_DEPTH = 6

/**
 * 判断一个连通分量是否“横向铺得太后”（适合 TB 竖排回归）：
 * 以该分量在 LR 横排下的纵深层级（有向最长链长度）为判据，而不是节点数/度数占比。
 * 常规任务链（几层横向就能放下）保持横排；只有横向会无限拉长的深链才改竖排。
 */
function isChainLikeComponent(graph: TaskGraph, comp: string[]): boolean {
  const depth = maxDagDepth(graph, new Set(comp))
  return depth > VERTICAL_BEYOND_LR_DEPTH
}

/**
 * 计算连通分量内 DAG 的最长有向路径边长（拓扑序 DP）。
 * 依赖边和被依赖方在左/上：依赖边方向为 e.to → e.from；分叉边方向为 e.from → e.to。
 * 与 layoutOneComponent 中 dagre 建边方向保持一致，保证判据 = 实际 LR 横铺层数（rank span）。
 */
function maxDagDepth(
  graph: TaskGraph,
  compSet: Set<string>,
): number {
  if (compSet.size === 0) return 0
  const edges: Array<[string, string]> = []
  const indeg = new Map<string, number>()
  const out = new Map<string, string[]>()
  const ensure = (id: string) => {
    if (!indeg.has(id)) { indeg.set(id, 0); out.set(id, []) }
  }
  for (const id of compSet) ensure(id)
  const addEdge = (from: string, to: string) => {
    if (compSet.has(from) && compSet.has(to)) {
      edges.push([from, to])
      out.get(from)!.push(to)
      indeg.set(to, (indeg.get(to) ?? 0) + 1)
    }
  }
  for (const e of graph.edges) addEdge(e.to, e.from)   // 被依赖 → 依赖
  for (const e of graph.forkEdges) addEdge(e.from, e.to) // 分叉边

  const dist = new Map<string, number>()
  for (const id of compSet) dist.set(id, 0)
  // Kahn 拓扑排序求最长路径边长
  const queue: string[] = []
  for (const id of compSet) if ((indeg.get(id) ?? 0) === 0) queue.push(id)
  let maxDist = 0
  const indegCopy = new Map(indeg)
  while (queue.length) {
    const cur = queue.shift()!
    for (const nb of out.get(cur) ?? []) {
      const nd = (dist.get(cur) ?? 0) + 1
      if (nd > (dist.get(nb) ?? 0)) dist.set(nb, nd)
      if (nd > maxDist) maxDist = nd
      indegCopy.set(nb, (indegCopy.get(nb) ?? 0) - 1)
      if ((indegCopy.get(nb) ?? 0) === 0) queue.push(nb)
    }
  }
  // 若存在环（通常不会），退化为按节点数粗判，避免返回 0
  if (edges.length > 0 && maxDist === 0 && compSet.size > 1) {
    return compSet.size
  }
  return maxDist
}

/** 对单个连通分量 dagre 布局，返回相对偏移（基准 0,0）与尺寸 */
function layoutOneComponent(
  graph: TaskGraph,
  comp: string[],
  isChainLike: boolean,
): { offsets: Map<string, NodePosition>; width: number; height: number } | null {
  if (comp.length === 0) return null
  const compSet = new Set(comp)
  const g = new dagre.graphlib.Graph()
  // 偏链分量竖排（长链从上往下），否则横排（分支/网状从左到右）
  g.setGraph({
    rankdir: isChainLike ? 'TB' : 'LR',
    nodesep: isChainLike ? LEVEL_GAP : NODE_GAP_Y,
    ranksep: isChainLike ? NODE_GAP_Y : LEVEL_GAP,
    marginx: 0,
    marginy: 0,
  })
  g.setDefaultEdgeLabel(() => ({}))
  for (const id of comp) g.setNode(id, { width: NODE_W, height: NODE_H })
  for (const e of graph.edges) {
    if (compSet.has(e.from) && compSet.has(e.to)) {
      // 依赖边：edges = {from:依赖方, to:被依赖方}，被依赖方在左/上 → setEdge(被依赖, 依赖)
      g.setEdge(e.to, e.from)
    }
  }
  for (const e of graph.forkEdges) {
    if (compSet.has(e.from) && compSet.has(e.to)) g.setEdge(e.from, e.to)
  }
  dagre.layout(g)

  const offsets = new Map<string, NodePosition>()
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const id of comp) {
    const n = g.node(id)
    if (!n) continue
    const x = n.x - NODE_W / 2
    const y = n.y - NODE_H / 2
    offsets.set(id, { id, x, y })
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + NODE_W); maxY = Math.max(maxY, y + NODE_H)
  }
  // 平移到 0 基准，方便拼接（避免 dagre margin 平移带回偏）
  const norm = new Map<string, NodePosition>()
  for (const pos of offsets.values()) norm.set(pos.id, { id: pos.id, x: pos.x - minX, y: pos.y - minY })
  return { offsets: norm, width: maxX - minX, height: maxY - minY }
}

// ===== SVG 连线（思维导图风格：依赖→被依赖 左→右） =====

interface EdgeData {
  from: string
  to: string
  d: string
  /** 起点坐标（左侧节点的右边缘） */
  x1: number; y1: number
  /** 终点坐标（右侧节点的左边缘） */
  x2: number; y2: number
  lineColor: string
  /** 是否为分叉边（虚线渲染） */
  isFork: boolean
}

// 分叉边配色：琥珀色，与依赖边的状态色区分
const FORK_LINE_COLOR = '#fbbf24'

function computeEdges(graph: TaskGraph, positions: NodePosition[]): EdgeData[] {
  const posMap = new Map(positions.map(p => [p.id, p]))

  // 贝塞尔连线：按两端相对位置自适应方向。
  // - 目标在源右侧（横排 LR）→ 从左节点右边缘连向右节点左边缘（水平贝塞尔）
  // - 目标在源下方（竖排 TB）→ 从上节点底边缘连向下节点顶边缘（垂直贝塞尔）
  // 这样无论连通分量用 LR 还是 TB，连线都能贴着卡片边缘自然引出。
  const makeEdge = (
    srcId: string, tgtId: string, lineColor: string, isFork: boolean,
  ): EdgeData | null => {
    const srcPos = posMap.get(srcId)
    const tgtPos = posMap.get(tgtId)
    if (!srcPos || !tgtPos) return null
    const srcCx = srcPos.x + NODE_W / 2
    const srcCy = srcPos.y + NODE_H / 2
    const tgtCx = tgtPos.x + NODE_W / 2
    const tgtCy = tgtPos.y + NODE_H / 2
    // 垂直差更显著（或右侧距离很近，基本同列但上下排布）→ 竖排连线
    const useVertical = Math.abs(tgtCy - srcCy) > Math.abs(tgtCx - srcCx)

    if (useVertical) {
      // 上节点底边缘 → 下节点顶边缘，垂直贝塞尔（控制点沿垂直方向凸出）
      const top = srcCy < tgtCy ? srcPos : tgtPos
      const bottom = srcCy < tgtCy ? tgtPos : srcPos
      const x1 = top.x + NODE_W / 2
      const y1 = top.y + NODE_H
      const x2 = bottom.x + NODE_W / 2
      const y2 = bottom.y
      const cy = (y1 + y2) / 2
      const d = `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`
      return { from: srcId, to: tgtId, d, x1, y1, x2, y2, lineColor, isFork }
    }

    // 左节点右边缘 → 右节点左边缘，水平贝塞尔
    const left = srcCx < tgtCx ? srcPos : tgtPos
    const right = srcCx < tgtCx ? tgtPos : srcPos
    const x1 = left.x + NODE_W
    const y1 = left.y + NODE_H / 2
    const x2 = right.x
    const y2 = right.y + NODE_H / 2
    const cx = (x1 + x2) / 2
    const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`
    return { from: srcId, to: tgtId, d, x1, y1, x2, y2, lineColor, isFork }
  }

  const result: EdgeData[] = []
  // 依赖边：被依赖节点（左）→ 依赖方节点（右），实线
  for (const node of Object.values(graph.nodes)) {
    for (const depId of node.dependsOn) {
      const depCfg = statusConfig[graph.nodes[depId]?.status ?? 'pending']
      const edge = makeEdge(depId, node.id, depCfg.lineColor, false)
      if (edge) result.push(edge)
    }
  }
  // 分叉边：源节点（左）→ 分叉节点（右），虚线异色
  for (const fe of graph.forkEdges) {
    const edge = makeEdge(fe.from, fe.to, FORK_LINE_COLOR, true)
    if (edge) result.push(edge)
  }
  return result
}

// ===== 节点卡片（不透明、实色背景） =====

function NodeCard({ node, x, y, selected, onClick }: { node: TaskNode; x: number; y: number; selected: boolean; onClick: () => void }) {
  const cfg = statusConfig[node.status]
  const showDesc = node.description && node.description.length > 0
  const isCancelled = node.status === 'cancelled'
  // 枯死支线：回溯抽取标注了放弃原因的节点，比普通取消更淡、虚线描边、骷髅标记
  const isAbandoned = !!node.abandonReason
  return (
    <foreignObject x={x} y={y} width={NODE_W} height={NODE_H} className="overflow-visible">
      <button
        type="button"
        onClick={onClick}
        title={isAbandoned ? `已放弃：${node.abandonReason}` : undefined}
        className={cn(
          'flex items-start gap-2.5 w-full h-full px-3.5 py-3 rounded-xl border-2 text-left',
          'transition-all duration-200 shadow-sm',
          'bg-card', // 统一实色卡片背景
          cfg.border,
          selected
            ? 'border-foreground/50 shadow-lg scale-[1.04] ring-2 ring-foreground/10'
            : 'hover:border-foreground/30 hover:shadow-md',
          node.status === 'in_progress' && !selected && 'animate-breathe',
          isCancelled && 'opacity-50',
          isAbandoned && !selected && 'opacity-40 border-dashed !border-amber-400/50',
        )}
      >
        <span className={cn('flex-shrink-0 mt-0.5', isAbandoned ? 'text-amber-500/70' : cfg.color)}>
          {isAbandoned ? <CircleSlash className="size-4" /> : cfg.icon}
        </span>
        <div className="flex-1 min-w-0">
          <div className={cn(
            'text-sm font-semibold leading-tight',
            (isCancelled || isAbandoned) && 'line-through',
            node.status === 'completed' && 'line-through',
          )}>
            {node.subject}
          </div>
          {isAbandoned ? (
            <div className="mt-1 text-[11px] text-amber-600/80 leading-tight line-clamp-2">
              放弃：{node.abandonReason}
            </div>
          ) : showDesc && (
            <div className="mt-1 text-[11px] text-muted-foreground/70 leading-tight line-clamp-2">
              {node.description}
            </div>
          )}
          {!isAbandoned && node.artifact.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5 text-[11px] text-muted-foreground/60">
              <FileText className="size-3" />
              {node.artifact.length} 个文件
            </div>
          )}
        </div>
      </button>
    </foreignObject>
  )
}

// ===== 详情侧边面板 =====

function DetailPanel({ node, onClose }: { node: TaskNode; onClose: () => void }) {
  const cfg = statusConfig[node.status]
  const openSession = useOpenSession()
  const agentSessions = useAtomValue(agentSessionsAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)

  // 解析可导航的执行会话 ID（按优先级）：
  // 1. sdkSessionId — graph-state 中直接存了可导航的子会话 ID
  // 2. delegationId — 通过 sourceDelegationId 反向查找子会话
  // 3. currentSessionId — 兜底：任务在当前会话中直接执行（非委派）
  const targetSessionId = React.useMemo(() => {
    if (node.sdkSessionId) return node.sdkSessionId
    if (node.delegationId) {
      // 向后兼容：旧的 delegationId 可能直接是可导航的 session ID
      if (agentSessions.some(s => s.id === node.delegationId)) return node.delegationId
      // 再尝试通过 sourceDelegationId 解析（delegation UUID → child session ID）
      const childSession = agentSessions.find(s => s.sourceDelegationId === node.delegationId)
      if (childSession) return childSession.id
    }
    // 兜底：任务在当前会话中创建/执行，跳转到当前会话
    return currentSessionId
  }, [node.sdkSessionId, node.delegationId, agentSessions, currentSessionId])

  const handleJumpToSession = () => {
    if (!targetSessionId) return
    openSession('agent', targetSessionId, node.subject)
  }

  return (
    <div className={cn(
      'flex-shrink-0 w-[280px] mr-3 my-3 rounded-xl',
      'bg-card/95 backdrop-blur border border-border/40 shadow-xl',
      'flex flex-col overflow-y-auto',
      'animate-in slide-in-from-right-3 duration-200',
    )}>
      {/* 头部 */}
      <div className="flex items-start gap-3 px-4 py-4 border-b border-border/20">
        <span className={cn('mt-0.5', cfg.color)}>{cfg.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold leading-tight">{node.subject}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {node.status === 'pending' && '待处理'}
            {node.status === 'in_progress' && '进行中'}
            {node.status === 'completed' && '已完成'}
            {node.status === 'failed' && '失败'}
            {node.status === 'cancelled' && '已取消'}
            {node.forkFrom && <span className="ml-2">· 分叉自 {node.forkFrom}</span>}
          </div>
          {targetSessionId && (
            <button
              type="button"
              onClick={handleJumpToSession}
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-500 hover:text-blue-400 transition-colors"
            >
              <ExternalLink className="size-3" />
              跳转到执行会话
            </button>
          )}
        </div>
      </div>

      {/* 内容 */}
      <div className="flex-1 px-4 py-3 space-y-4">
        {/* 放弃原因（回溯抽取标注的枯死支线） */}
        {node.abandonReason && (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <CircleSlash className="size-3.5 text-amber-500/80" />
              <span className="text-[10px] font-medium text-amber-600/90 uppercase tracking-wider">放弃原因</span>
              {typeof node.abandonConfidence === 'number' && (
                <span className="ml-auto text-[10px] font-mono text-amber-600/60">
                  置信 {Math.round(node.abandonConfidence * 100)}%
                </span>
              )}
            </div>
            <p className="text-xs text-amber-700/90 dark:text-amber-300/90 leading-relaxed">{node.abandonReason}</p>
            {node.abandonEvidence && node.abandonEvidence.length > 0 && (
              <div className="mt-1.5 text-[10px] text-muted-foreground/60">
                证据轮次：{node.abandonEvidence.map((t) => `Turn ${t}`).join('、')}
              </div>
            )}
          </div>
        )}

        {/* 描述 */}
        {node.description && (
          <div>
            <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1">描述</div>
            <p className="text-xs text-muted-foreground leading-relaxed">{node.description}</p>
          </div>
        )}

        {/* 依赖关系 */}
        {(node.dependsOn.length > 0 || node.dependedBy.length > 0) && (
          <div>
            <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1.5">依赖关系</div>
            <div className="space-y-1 text-xs">
              {node.dependsOn.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/50">依赖：</span>
                  <span className="text-muted-foreground">{node.dependsOn.length} 个前置任务</span>
                </div>
              )}
              {node.dependedBy.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground/50">被依赖：</span>
                  <span className="text-muted-foreground">{node.dependedBy.length} 个后续任务</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 执行用量 */}
        {node.usage && (
          <div>
            <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1.5">执行用量</div>
            <div className="grid grid-cols-3 gap-2">
              {node.usage.totalTokens != null && (
                <div className="text-center py-2 rounded-md bg-muted/30 border border-border/20">
                  <div className="text-xs font-mono font-medium">{node.usage.totalTokens.toLocaleString()}</div>
                  <div className="text-[9px] text-muted-foreground/50">tokens</div>
                </div>
              )}
              {node.usage.toolUses != null && (
                <div className="text-center py-2 rounded-md bg-muted/30 border border-border/20">
                  <div className="text-xs font-mono font-medium">{node.usage.toolUses}</div>
                  <div className="text-[9px] text-muted-foreground/50">工具调用</div>
                </div>
              )}
              {node.usage.durationMs != null && (
                <div className="text-center py-2 rounded-md bg-muted/30 border border-border/20">
                  <div className="text-xs font-mono font-medium">{(node.usage.durationMs / 1000).toFixed(1)}s</div>
                  <div className="text-[9px] text-muted-foreground/50">耗时</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 产出文件 */}
        {node.artifact.length > 0 && (
          <div>
            <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1.5">产出文件</div>
            <div className="space-y-0.5">
              {node.artifact.map((f, i) => (
                <div key={i} className="text-[11px] font-mono text-muted-foreground/70 truncate bg-muted/30 px-2 py-1 rounded">{f}</div>
              ))}
            </div>
          </div>
        )}

        {/* 时间 */}
        <div className="text-[10px] text-muted-foreground/40 pt-2 border-t border-border/10 flex items-center gap-1">
          <Clock className="size-2.5" />
          创建于 {new Date(node.createdAt).toLocaleString()}
        </div>
      </div>
    </div>
  )
}

// ===== 空状态 =====

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground/30">
      <GitBranch className="size-14" />
      <p className="text-sm text-center">Agent 创建多步骤任务后，<br />任务关系图会在这里展示</p>
    </div>
  )
}

// ===== 刷新入口 =====

/**
 * 手动刷新按钮：从会话 JSONL 重新读取并重放持久化任务图（纯读取，不调 LLM）。
 * Agent 在对话中标了枯枝（@abandon）、删了节点或改了状态后，点此即可让面板同步到最新任务图。
 */
function GraphRefreshButton({ sessionId }: { sessionId: string }): React.ReactElement {
  const setPersistedGraph = useSetAtom(persistedGraphAtomFamily(sessionId))
  const [refreshing, setRefreshing] = React.useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const api = window.electronAPI as { getGraph?: (id: string) => Promise<TaskGraph> }
      if (!api.getGraph) { toast.error('当前版本不支持刷新'); return }
      const fresh = await api.getGraph(sessionId)
      setPersistedGraph(fresh)
    } catch {
      toast.error('刷新失败，请稍后重试')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleRefresh}
      disabled={refreshing}
      title="从会话记录重新读取任务图"
      className={cn(
        'flex-shrink-0 inline-flex items-center justify-center size-7 rounded-full',
        'text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
        refreshing && 'opacity-60 cursor-wait',
      )}
    >
      <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
    </button>
  )
}

// ===== 主面板 =====

export function ProjectGraphPanel({ refreshVersion = 0 }: { refreshVersion?: number }): React.ReactElement {
  React.useEffect(() => { injectBreatheStyle() }, [])
  const { graph, loading } = useGraphData(refreshVersion)
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const setGraphQuestion = useSetAtom(graphQuestionAtom)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [scale, setScale] = React.useState(1)
  const [tx, setTx] = React.useState(0)
  const [ty, setTy] = React.useState(0)
  const [dragging, setDragging] = React.useState(false)
  const dragRef = React.useRef<{ sx: number; sy: number; tx0: number; ty0: number } | null>(null)
  const [selectedNode, setSelectedNode] = React.useState<TaskNode | null>(null)

  // 用 ref 存 scale/tx/ty 的快照，避免 wheel handler 的依赖问题
  const scaleRef = React.useRef(scale)
  const txRef = React.useRef(tx)
  const tyRef = React.useRef(ty)
  scaleRef.current = scale
  txRef.current = tx
  tyRef.current = ty

  // 当 selectedNode 被清除时同步清除 graphQuestion
  React.useEffect(() => {
    if (!selectedNode) {
      setGraphQuestion(null)
    }
  }, [selectedNode, setGraphQuestion])

  const layout = React.useMemo(() => (graph ? computeDagreLayout(graph) : null), [graph])
  const positions = layout?.positions ?? EMPTY_POSITIONS
  const edges = React.useMemo(() => (graph ? computeEdges(graph, positions) : []), [graph, positions])

  const svgW = layout ? layout.width + CANVAS_PAD : 800
  const svgH = layout ? layout.height + CANVAS_PAD : 600

  // 缩放（滚轮）— window 级绑定 + 区域过滤，稳定可靠
  React.useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // 仅当鼠标在画布区域内才缩放
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return
      e.preventDefault()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const prev = scaleRef.current
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev + delta))
      const ratio = next / prev
      setScale(next)
      setTx(txRef.current = mx + ratio * (txRef.current - mx))
      setTy(tyRef.current = my + ratio * (tyRef.current - my))
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // 初始镜头：自动适配全图 + 居中（若图能一屏放下则全貌可见，避免"长链一字排开看不到头"）
  const initialCameraSet = React.useRef(false)
  React.useEffect(() => {
    if (initialCameraSet.current || !layout || positions.length === 0 || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    // 布局中心点（相对画板）
    const layoutCx = layout.width / 2
    const layoutCy = layout.height / 2

    // fit 比例：让整张图适配容器（水平取最小，避免被框边裁掉），并限制最小可读缩放
    const fitScale = Math.max(
      MIN_SCALE,
      Math.min(rect.width / layout.width, rect.height / layout.height),
    )
    // 拖拽/平移到布局中心
    const cx = rect.width / 2 - layoutCx * fitScale
    const cy = rect.height / 2 - layoutCy * fitScale
    setScale(fitScale)
    setTx(cx)
    setTy(cy)
    initialCameraSet.current = true
  }, [layout, positions])

  // 平移（拖拽）— 点击空白区域同时关闭选中
  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    // 点击空白画布 → 取消选中
    setSelectedNode(null)
    setDragging(true)
    dragRef.current = { sx: e.clientX, sy: e.clientY, tx0: tx, ty0: ty }
  }, [tx, ty])

  React.useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      setTx(dragRef.current.tx0 + (e.clientX - dragRef.current.sx))
      setTy(dragRef.current.ty0 + (e.clientY - dragRef.current.sy))
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [dragging])

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  }
  if (!graph || !layout || layout.positions.length === 0) return <EmptyState />

  const nodes = Object.values(graph.nodes)
  const completed = nodes.filter(n => n.status === 'completed').length
  const progress = Math.round((completed / nodes.length) * 100)

  return (
    <div className="flex flex-col h-full">
      {/* 主体区域：画布 + 可选侧面板（flex row，面板打开时画布内缩） */}
      <div className="flex-1 flex min-h-0">
        {/* 左侧：进度条 + 画布 + 追问条（面板打开时一起内缩） */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 进度条 */}
          <div className="flex-shrink-0 pl-5 pr-[80px] py-3 border-b border-border/30 flex items-center gap-4">
            <span className="text-xs text-muted-foreground flex-shrink-0">任务进度 {completed}/{nodes.length} · {progress}%</span>
            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-emerald-400 rounded-full transition-all duration-700 ease-out" style={{ width: `${progress}%` }} />
            </div>
            {sessionId && <GraphRefreshButton sessionId={sessionId} />}
          </div>

          {/* 无界画布 */}
          <div
            ref={containerRef}
            className="flex-1 overflow-hidden relative"
            style={{
              cursor: dragging ? 'grabbing' : 'grab',
              backgroundImage:
                'radial-gradient(circle, hsl(var(--muted-foreground)/0.08) 0.5px, transparent 0.5px),' +
                'radial-gradient(circle, hsl(var(--muted-foreground)/0.12) 1px, transparent 1px)',
              backgroundSize: '5px 5px, 25px 25px',
              backgroundPosition: '0 0, 0 0',
            }}
            onMouseDown={handleMouseDown}
          >
            <div
              className="absolute inset-0"
              style={{
                transform: `scale(${scale}) translate(${tx * (1 / scale)}px, ${ty * (1 / scale)}px)`,
                transformOrigin: '0 0',
              }}
            >
              {/* 单层 SVG：连线 → 节点卡 → 连接点（由底到顶） */}
              <svg width={svgW} height={svgH} className="absolute inset-0" style={{ overflow: 'visible' }}>
                {/* 第1层：连线 */}
                {edges.map(e => (
                  <path
                    key={`edge-${e.isFork ? 'fork' : 'dep'}-${e.from}-${e.to}`}
                    d={e.d}
                    fill="none"
                    stroke={e.lineColor}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeDasharray={e.isFork ? '6 5' : undefined}
                    opacity={e.isFork ? 0.7 : 0.5}
                    style={{ pointerEvents: 'none' }}
                  />
                ))}
                {/* 第2层：节点卡片 */}
                {positions.map(pos => {
                  const node = graph.nodes[pos.id]
                  if (!node) return null
                  return (
                    <NodeCard
                      key={node.id}
                      node={node}
                      x={pos.x}
                      y={pos.y}
                      selected={selectedNode?.id === node.id}
                      onClick={() => {
                        const isSelecting = selectedNode?.id !== node.id
                        setSelectedNode(prev => prev?.id === node.id ? null : node)
                        if (isSelecting && sessionId) {
                          setGraphQuestion({
                            sessionId,
                            taskId: node.id,
                            taskSubject: node.subject,
                          })
                        } else {
                          setGraphQuestion(null)
                        }
                      }}
                    />
                  )
                })}
                {/* 第3层：连接点（在节点上方，盖住节点边缘） */}
                {edges.map(e => (
                  <g key={`dots-${e.isFork ? 'fork' : 'dep'}-${e.from}-${e.to}`} style={{ pointerEvents: 'none' }}>
                    <circle cx={e.x1} cy={e.y1} r={DOT_R} fill={e.lineColor} />
                    <circle cx={e.x2} cy={e.y2} r={DOT_R} fill={e.lineColor} />
                  </g>
                ))}
              </svg>
            </div>
          </div>

          {/* 追问输入条（在左侧列内，随面板内缩） */}
          <GraphQuestionInput />
        </div>

        {/* 右侧：详情面板（在正常流中，挤压左侧） */}
        {selectedNode && <DetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />}
      </div>
    </div>
  )
}
