/**
 * ProjectGraphPanel — 无界画板任务图可视化（知识图谱风格）
 *
 * 支持力导向布局、分支/汇合可视化、缩放（滚轮）、平移（拖拽）、节点选中交互。
 * 作为 AgentView 工具栏 Graph 按钮的 Dialog 内容使用。
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
  GitMerge,
  GitFork,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { currentAgentSessionIdAtom, graphQuestionAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { currentGraphAtom } from '@/atoms/graph-atoms'
import { computeForceLayout, computeForkEdgesLayout, type TaskGraph, type TaskNode, type TaskStatus, type ForceLayoutResult, type ForkEdgeLayout } from '@proma/project-core'
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

const NODE_W = 270
const NODE_H = 128
const LEVEL_GAP = 80
const NODE_GAP_Y = 20
const CANVAS_PAD = 70

const MIN_SCALE = 0.25
const MAX_SCALE = 2.5
const ZOOM_STEP = 0.1

// 连线端点圆点半径
const DOT_R = 5

// 分支着色调色板（用于多分支视觉区分）
const BRANCH_COLORS = [
  { accent: 'border-blue-400/30',   tint: 'bg-blue-500/5',   stripe: '#60a5fa' },
  { accent: 'border-emerald-400/30', tint: 'bg-emerald-500/5', stripe: '#34d399' },
  { accent: 'border-violet-400/30', tint: 'bg-violet-500/5', stripe: '#a78bfa' },
  { accent: 'border-amber-400/30',  tint: 'bg-amber-500/5',  stripe: '#fbbf24' },
  { accent: 'border-rose-400/30',   tint: 'bg-rose-500/5',   stripe: '#fb7185' },
  { accent: 'border-cyan-400/30',   tint: 'bg-cyan-500/5',   stripe: '#22d3ee' },
  { accent: 'border-orange-400/30', tint: 'bg-orange-500/5', stripe: '#fb923c' },
  { accent: 'border-lime-400/30',   tint: 'bg-lime-500/5',   stripe: '#a3e635' },
]

/** 为分叉子图分配分支索引（基于 forkEdges） */
function computeBranchIndex(graph: TaskGraph): Map<string, number> {
  const branchIndex = new Map<string, number>()
  // 根节点（无 forkFrom 或 forkFrom 节点不在图中）
  for (const node of Object.values(graph.nodes)) {
    if (!node.forkFrom || !graph.nodes[node.forkFrom]) {
      branchIndex.set(node.id, 0)
    }
  }

  // BFS: 分叉子节点继承源分支号，或新分支
  const forkSourceChildren = new Map<string, number>()
  for (const fe of graph.forkEdges) {
    const children = graph.forkEdges.filter(e => e.from === fe.from)
    if (children.length > 1) {
      children.forEach((child, idx) => {
        forkSourceChildren.set(child.to, idx + 1) // 分支 1, 2, 3...
      })
    }
  }

  for (const node of Object.values(graph.nodes)) {
    if (branchIndex.has(node.id)) continue
    if (node.forkFrom && forkSourceChildren.has(node.id)) {
      branchIndex.set(node.id, forkSourceChildren.get(node.id)!)
    } else {
      // 通过依赖边继承分支号
      for (const depId of node.dependsOn) {
        const depBranch = branchIndex.get(depId)
        if (depBranch !== undefined) {
          branchIndex.set(node.id, depBranch)
          break
        }
      }
      if (!branchIndex.has(node.id)) branchIndex.set(node.id, 0)
    }
  }

  return branchIndex
}

/** 检测分叉点（有 forkEdge 从这个节点发出） */
function computeForkNodeIds(graph: TaskGraph): Set<string> {
  return new Set(graph.forkEdges.map(e => e.from))
}

/** 检测汇合点（有 ≥2 条入边） */
function computeMergeNodeIds(graph: TaskGraph): Set<string> {
  const inDegree = new Map<string, number>()
  for (const e of graph.edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
  }
  return new Set([...inDegree.entries()].filter(([, d]) => d >= 2).map(([id]) => id))
}

const statusConfig: Record<TaskStatus, { icon: React.ReactElement; color: string; border: string; lineColor: string }> = {
  pending:     { icon: <Circle className="size-4" />,                color: 'text-muted-foreground', border: 'border-border',                lineColor: 'hsl(var(--muted-foreground)/0.4)' },
  in_progress: { icon: <Loader2 className="size-4 animate-spin" />, color: 'text-blue-400',           border: 'border-blue-400/40',          lineColor: '#60a5fa' },
  completed:   { icon: <CheckCircle2 className="size-4" />,          color: 'text-emerald-500',        border: 'border-emerald-400/40',       lineColor: '#34d399' },
  failed:      { icon: <XCircle className="size-4" />,               color: 'text-red-400',            border: 'border-red-400/40',           lineColor: '#f87171' },
  cancelled:   { icon: <AlertCircle className="size-4" />,           color: 'text-amber-500',          border: 'border-amber-400/40',         lineColor: '#fbbf24' },
}

// ===== 数据 hook =====

function useGraphData(): { graph: TaskGraph | null; loading: boolean } {
  const atomGraph = useAtomValue(currentGraphAtom)
  const sessionId = useAtomValue(currentAgentSessionIdAtom)
  const [ipcGraph, setIpcGraph] = React.useState<TaskGraph | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setLoading(true)
    const api = window.electronAPI as { getGraph?: (id: string) => Promise<TaskGraph> }
    if (!api.getGraph) { setLoading(false); return }
    api.getGraph(sessionId).then(g => {
      if (!cancelled) { setIpcGraph(g); setLoading(false) }
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId])

  const graph = atomGraph ?? ipcGraph
  return { graph, loading: loading && !graph }
}

// ===== 力导向布局坐标提取 =====

/** 从 ForceLayoutResult 提取节点位置数组（含分支色） */
function positionsFromForceLayout(
  layout: ForceLayoutResult,
  graph: TaskGraph,
): { id: string; x: number; y: number }[] {
  return Array.from(layout.positions.entries()).map(([id, pos]) => ({
    id,
    x: pos.x,
    y: pos.y,
  }))
}

// ===== SVG 连线 =====

interface EdgeData {
  from: string
  to: string
  d: string
  x1: number; y1: number
  x2: number; y2: number
  lineColor: string
  type: 'dependency' | 'fork'
  forkReason?: string
}

/** 为依赖边计算 Bezier 曲线（左→右，水平弧线） */
function computeDependencyEdges(
  graph: TaskGraph,
  positions: { id: string; x: number; y: number }[],
): EdgeData[] {
  const posMap = new Map(positions.map(p => [p.id, p]))
  return Object.values(graph.nodes).flatMap(node => {
    return node.dependsOn.map(depId => {
      const depPos = posMap.get(depId)
      const nodePos = posMap.get(node.id)
      if (!depPos || !nodePos) return null!
      const depCfg = statusConfig[graph.nodes[depId]?.status ?? 'pending']
      const x1 = depPos.x + NODE_W
      const y1 = depPos.y + NODE_H / 2
      const x2 = nodePos.x
      const y2 = nodePos.y + NODE_H / 2
      const cx = (x1 + x2) / 2
      const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`
      return { from: depId, to: node.id, d, x1, y1, x2, y2, lineColor: depCfg.lineColor, type: 'dependency' as const }
    })
  }).filter(Boolean)
}

/** 将 ForkEdgeLayout 转换为渲染用的 EdgeData */
function computeForkEdges(
  forkLayouts: ForkEdgeLayout[],
): EdgeData[] {
  return forkLayouts.map(fl => ({
    from: fl.from,
    to: fl.to,
    d: fl.d,
    x1: fl.x1,
    y1: fl.y1,
    x2: fl.x2,
    y2: fl.y2,
    lineColor: fl.lineColor,
    type: 'fork' as const,
    forkReason: fl.reason,
  }))
}

// ===== 节点卡片（知识图谱风格 — 高信息密度） =====

function NodeCard({
  node, x, y, selected, onClick,
  isForkNode, isMergeNode, branchColor, isForkChild, graph, currentSessionId,
}: {
  node: TaskNode
  x: number
  y: number
  selected: boolean
  onClick: () => void
  isForkNode: boolean
  isMergeNode: boolean
  branchColor?: typeof BRANCH_COLORS[number]
  isForkChild: boolean
  graph: TaskGraph
  currentSessionId?: string
}) {
  const cfg = statusConfig[node.status]
  const showDesc = node.description && node.description.length > 0
  const isCancelled = node.status === 'cancelled'
  const depCount = node.dependsOn.length
  const depByCount = node.dependedBy.length
  const createdAt = new Date(node.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  const shortId = node.id.length > 12 ? node.id.slice(0, 12) + '…' : node.id
  // 检测跨会话节点（任务来自其他子会话）
  const isCrossSession = currentSessionId && node.sdkSessionId && node.sdkSessionId !== currentSessionId
  const crossSessionShortId = isCrossSession
    ? (node.sdkSessionId!.length > 8 ? node.sdkSessionId!.slice(0, 8) + '…' : node.sdkSessionId!)
    : null

  return (
    <foreignObject x={x} y={y} width={NODE_W} height={NODE_H} className="overflow-visible">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex flex-col w-full h-full rounded-xl border-2 text-left',
          'transition-all duration-200 shadow-sm',
          'bg-card',
          isForkNode
            ? 'border-dashed border-amber-400/40'
            : cfg.border,
          isMergeNode && 'ring-2 ring-purple-400/30',
          selected
            ? 'border-foreground/50 shadow-lg scale-[1.04] ring-2 ring-foreground/10'
            : 'hover:border-foreground/30 hover:shadow-md',
          node.status === 'in_progress' && !selected && 'animate-breathe',
          isCancelled && 'opacity-50',
        )}
      >
        {/* 分支颜色条纹（左侧细条） */}
        {branchColor && branchColor.stripe && !isForkNode && (
          <div
            className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full opacity-60"
            style={{ backgroundColor: branchColor.stripe }}
          />
        )}

        {/* 分叉子节点标记 */}
        {isForkChild && (
          <div className="absolute -top-1 -left-1 size-4 rounded-full bg-amber-400/20 flex items-center justify-center">
            <GitFork className="size-2.5 text-amber-400" />
          </div>
        )}

        {/* === 头部：状态图标 + 标题 + ID === */}
        <div className="flex items-start gap-2 px-3.5 pt-3 pb-1.5">
          <span className={cn('flex-shrink-0 mt-0.5', cfg.color)}>{cfg.icon}</span>
          <div className="flex-1 min-w-0">
            <div className={cn(
              'text-[13px] font-semibold leading-tight truncate',
              isCancelled && 'line-through',
              node.status === 'completed' && 'line-through opacity-80',
            )}>
              {node.subject}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <span className="text-[10px] font-mono text-muted-foreground/50 bg-muted/50 px-1.5 py-px rounded">
                #{shortId}
              </span>
              {isCrossSession && (
                <span
                  className="text-[10px] text-blue-400/80 bg-blue-500/10 px-1.5 py-px rounded font-medium"
                  title={`来自子会话 ${node.sdkSessionId}`}
                >
                  ↳ {crossSessionShortId}
                </span>
              )}
              {node.forkFrom && (
                <span className="text-[10px] text-amber-400/70">
                  分叉自 {node.forkFrom.length > 10 ? node.forkFrom.slice(0, 10) + '…' : node.forkFrom}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* === 主体：描述 === */}
        <div className="flex-1 px-3.5">
          {showDesc ? (
            <p className="text-[11px] text-muted-foreground/80 leading-relaxed line-clamp-3 whitespace-pre-line">
              {node.description}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground/30 italic">暂无描述</p>
          )}
        </div>

        {/* === 底部：统计标签行 === */}
        <div className={cn(
          'flex items-center gap-2 px-3.5 pb-2.5 pt-1.5 mt-auto',
          'border-t border-border/20',
        )}>
          {/* 依赖关系 */}
          {depCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <span className="text-[9px]">依赖</span>
              <span className="font-mono font-medium text-muted-foreground/80">{depCount}</span>
            </span>
          )}
          {depByCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <span className="text-[9px]">被依赖</span>
              <span className="font-mono font-medium text-muted-foreground/80">{depByCount}</span>
            </span>
          )}

          {/* 产出文件数 */}
          {node.artifact.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
              <FileText className="size-2.5" />
              <span className="font-mono font-medium text-muted-foreground/80">{node.artifact.length}</span>
            </span>
          )}

          {/* 分叉/汇合标记 */}
          {isForkNode && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-400/70 font-medium ml-auto">
              <GitFork className="size-2.5" />分叉
            </span>
          )}
          {isMergeNode && (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-purple-400/70 font-medium ml-auto">
              <GitMerge className="size-2.5" />汇合
            </span>
          )}

          {/* 创建时间 */}
          <span className="text-[10px] text-muted-foreground/40 ml-auto tabular-nums flex items-center gap-0.5">
            <Clock className="size-2.5" />
            {createdAt}
          </span>
        </div>

        {/* === 用量数据（如果有） === */}
        {node.usage && (node.usage.totalTokens || node.usage.toolUses || node.usage.durationMs) && (
          <div className="px-3.5 pb-2.5 flex items-center gap-3 text-[10px] text-muted-foreground/50">
            {node.usage.totalTokens != null && (
              <span className="tabular-nums">{node.usage.totalTokens.toLocaleString()} tokens</span>
            )}
            {node.usage.toolUses != null && (
              <span className="tabular-nums">{node.usage.toolUses} 工具调用</span>
            )}
            {node.usage.durationMs != null && (
              <span className="tabular-nums">{(node.usage.durationMs / 1000).toFixed(1)}s</span>
            )}
          </div>
        )}
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
      <p className="text-sm text-center">Agent 创建多步骤任务后，<br />项目知识图谱会在这里展示<br /><span className="text-muted-foreground/20 text-xs">跨会话任务自动聚合</span></p>
    </div>
  )
}

// ===== 主面板 =====

export function ProjectGraphPanel(): React.ReactElement {
  React.useEffect(() => { injectBreatheStyle() }, [])
  const { graph, loading } = useGraphData()
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

  const forceLayout = React.useMemo(() => (
    graph ? computeForceLayout(graph, {
      edgeLength: 300,
      repulsionStrength: 8000,
      iterations: 300,
    }) : null
  ), [graph])
  const positions = React.useMemo(() => (forceLayout ? positionsFromForceLayout(forceLayout, graph!) : []), [forceLayout, graph])
  const depEdges = React.useMemo(() => (graph ? computeDependencyEdges(graph, positions) : []), [graph, positions])
  const forkEdgesRender = React.useMemo(() => {
    if (!graph || !forceLayout) return []
    const forkLayouts = computeForkEdgesLayout(graph, forceLayout.positions, NODE_W, NODE_H)
    return computeForkEdges(forkLayouts)
  }, [graph, forceLayout])

  // 分支/分叉/汇合元数据
  const forkNodeIds = React.useMemo(() => (graph ? computeForkNodeIds(graph) : new Set<string>()), [graph])
  const mergeNodeIds = React.useMemo(() => (graph ? computeMergeNodeIds(graph) : new Set<string>()), [graph])
  const branchIndex = React.useMemo(() => (graph ? computeBranchIndex(graph) : new Map<string, number>()), [graph])

  const svgW = forceLayout ? forceLayout.canvasWidth : 800
  const svgH = forceLayout ? forceLayout.canvasHeight : 600

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

  // 初始镜头：定位到第一个 in_progress（否则 pending）节点的位置
  const initialCameraSet = React.useRef(false)
  React.useEffect(() => {
    if (initialCameraSet.current || !forceLayout || positions.length === 0 || !containerRef.current) return
    const activeNode = positions.find(p => {
      const n = graph?.nodes[p.id]
      return n && (n.status === 'in_progress' || n.status === 'pending')
    })
    if (!activeNode) return
    const rect = containerRef.current.getBoundingClientRect()
    const cx = rect.width / 2 - activeNode.x - NODE_W / 2
    const cy = rect.height / 2 - activeNode.y - NODE_H / 2
    setTx(cx)
    setTy(cy)
    initialCameraSet.current = true
  }, [forceLayout, positions, graph])

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
  if (!graph || !forceLayout || Object.keys(graph.nodes).length === 0) return <EmptyState />

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
              {/* 多层 SVG：依赖边 → 分叉边 → 节点卡 → 连接点（由底到顶） */}
              <svg width={svgW} height={svgH} className="absolute inset-0" style={{ overflow: 'visible' }}>
                {/* 第1层：依赖边（实线） */}
                {depEdges.map(e => (
                  <path
                    key={`dep-${e.from}-${e.to}`}
                    d={e.d}
                    fill="none"
                    stroke={e.lineColor}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    opacity={0.5}
                    style={{ pointerEvents: 'none' }}
                  />
                ))}
                {/* 第2层：分叉边（虚线，琥珀色） */}
                {forkEdgesRender.map(e => (
                  <g key={`fork-${e.from}-${e.to}`}>
                    <path
                      d={e.d}
                      fill="none"
                      stroke={e.lineColor}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeDasharray="6 4"
                      opacity={0.6}
                      style={{ pointerEvents: 'none' }}
                    />
                    {/* 分叉标签（中点位置） */}
                    {e.forkReason && (
                      <text
                        x={(e.x1 + e.x2) / 2 + 8}
                        y={(e.y1 + e.y2) / 2 - 4}
                        fontSize="9"
                        fill="#fbbf24"
                        opacity={0.7}
                        style={{ pointerEvents: 'none' }}
                      >
                        分叉: {e.forkReason.length > 8 ? e.forkReason.slice(0, 8) + '...' : e.forkReason}
                      </text>
                    )}
                  </g>
                ))}
                {/* 第3层：节点卡片 */}
                {positions.map(pos => {
                  const node = graph.nodes[pos.id]
                  if (!node) return null
                  const bIdx = branchIndex.get(node.id) ?? 0
                  const bColor = bIdx > 0 ? BRANCH_COLORS[bIdx % BRANCH_COLORS.length] : undefined
                  return (
                    <NodeCard
                      key={node.id}
                      node={node}
                      x={pos.x}
                      y={pos.y}
                      selected={selectedNode?.id === node.id}
                      isForkNode={forkNodeIds.has(node.id)}
                      isMergeNode={mergeNodeIds.has(node.id)}
                      branchColor={bColor}
                      isForkChild={!!node.forkFrom && !!graph.nodes[node.forkFrom]}
                      graph={graph}
                      currentSessionId={sessionId ?? undefined}
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
                {/* 第4层：连接点（依赖边实心圆 + 分叉边空心圆） */}
                {depEdges.map(e => (
                  <g key={`dep-dots-${e.from}-${e.to}`} style={{ pointerEvents: 'none' }}>
                    <circle cx={e.x1} cy={e.y1} r={DOT_R} fill={e.lineColor} />
                    <circle cx={e.x2} cy={e.y2} r={DOT_R} fill={e.lineColor} />
                  </g>
                ))}
                {forkEdgesRender.map(e => (
                  <g key={`fork-dots-${e.from}-${e.to}`} style={{ pointerEvents: 'none' }}>
                    <circle cx={e.x1} cy={e.y1} r={DOT_R} fill={e.lineColor} fillOpacity={0.6} />
                    <circle cx={e.x2} cy={e.y2} r={DOT_R} fill={e.lineColor} fillOpacity={0.6} />
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
