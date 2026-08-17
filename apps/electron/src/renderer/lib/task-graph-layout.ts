import type { TaskGraph, TaskNode } from '@profer/project-core'

export const TASK_GRAPH_NODE_WIDTH = 260
export const TASK_GRAPH_NODE_HEIGHT = 100
export const TASK_GRAPH_CANVAS_PADDING = 70

const MAINLINE_GAP_X = 84
const BRANCH_GAP_Y = 24
const UNLINKED_LANE_GAP_Y = 76
const UNLINKED_GRID_GAP_X = 44
const UNLINKED_GRID_GAP_Y = 28

export interface TaskGraphNodePosition {
  id: string
  x: number
  y: number
}

export interface TaskGraphEdgeRoute {
  from: string
  to: string
  d: string
  x1: number
  y1: number
  x2: number
  y2: number
  isFork: boolean
}

export interface TaskGraphUnlinkedLane {
  x: number
  y: number
  count: number
}

export interface TaskGraphLayout {
  positions: TaskGraphNodePosition[]
  edges: TaskGraphEdgeRoute[]
  mainline: string[]
  unlinkedLane?: TaskGraphUnlinkedLane
  width: number
  height: number
}

interface DirectedRelation {
  from: string
  to: string
  isFork: boolean
}

interface PathScore {
  ids: string[]
  latestUpdatedAt: number
}

function compareNodes(a: TaskNode, b: TaskNode): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

function comparePathScores(a: PathScore, b: PathScore): number {
  if (a.ids.length !== b.ids.length) return b.ids.length - a.ids.length
  if (a.latestUpdatedAt !== b.latestUpdatedAt) return b.latestUpdatedAt - a.latestUpdatedAt
  return a.ids.join('\u0000').localeCompare(b.ids.join('\u0000'))
}

function collectRelations(graph: TaskGraph): DirectedRelation[] {
  const relations = new Map<string, DirectedRelation>()
  const add = (from: string, to: string, isFork: boolean) => {
    if (!graph.nodes[from] || !graph.nodes[to] || from === to) return
    const key = `${isFork ? 'fork' : 'dependency'}:${from}:${to}`
    relations.set(key, { from, to, isFork })
  }

  for (const node of Object.values(graph.nodes)) {
    for (const dependencyId of node.dependsOn) add(dependencyId, node.id, false)
    if (node.forkFrom) add(node.forkFrom, node.id, true)
  }
  for (const edge of graph.edges) add(edge.to, edge.from, false)
  for (const edge of graph.forkEdges) add(edge.from, edge.to, true)

  return [...relations.values()].sort((a, b) => (
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || Number(a.isFork) - Number(b.isFork)
  ))
}

function buildAdjacency(nodeIds: string[], relations: DirectedRelation[]): {
  children: Map<string, string[]>
  parents: Map<string, string[]>
} {
  const children = new Map(nodeIds.map((id) => [id, [] as string[]]))
  const parents = new Map(nodeIds.map((id) => [id, [] as string[]]))
  for (const relation of relations) {
    children.get(relation.from)!.push(relation.to)
    parents.get(relation.to)!.push(relation.from)
  }
  for (const ids of children.values()) ids.sort()
  for (const ids of parents.values()) ids.sort()
  return { children, parents }
}

function selectMainline(graph: TaskGraph, children: Map<string, string[]>, parents: Map<string, string[]>): string[] {
  const nodes = Object.values(graph.nodes).sort(compareNodes)
  const roots = nodes.filter((node) => (parents.get(node.id)?.length ?? 0) === 0)
  const starts = roots.length > 0 ? roots : nodes

  const walk = (id: string, seen: Set<string>): PathScore => {
    const own = graph.nodes[id]!
    const candidates = (children.get(id) ?? [])
      .filter((childId) => !seen.has(childId))
      .map((childId) => walk(childId, new Set([...seen, childId])))
    if (candidates.length === 0) return { ids: [id], latestUpdatedAt: own.updatedAt }
    candidates.sort(comparePathScores)
    const child = candidates[0]!
    return {
      ids: [id, ...child.ids],
      latestUpdatedAt: Math.max(own.updatedAt, child.latestUpdatedAt),
    }
  }

  const candidates = starts.map((node) => walk(node.id, new Set([node.id])))
  candidates.sort(comparePathScores)
  return candidates[0]?.ids ?? []
}

function findMainlineAnchor(
  id: string,
  mainlineIndex: Map<string, number>,
  parents: Map<string, string[]>,
): { index: number; depth: number } | null {
  const queue: Array<{ id: string; depth: number }> = [{ id, depth: 0 }]
  const seen = new Set<string>([id])
  const matches: Array<{ index: number; depth: number }> = []

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const parentId of parents.get(current.id) ?? []) {
      if (seen.has(parentId)) continue
      const index = mainlineIndex.get(parentId)
      if (index !== undefined) matches.push({ index, depth: current.depth + 1 })
      else {
        seen.add(parentId)
        queue.push({ id: parentId, depth: current.depth + 1 })
      }
    }
  }

  matches.sort((a, b) => a.depth - b.depth || b.index - a.index)
  return matches[0] ?? null
}

function routeEdge(
  relation: DirectedRelation,
  positions: Map<string, TaskGraphNodePosition>,
): TaskGraphEdgeRoute | null {
  const source = positions.get(relation.from)
  const target = positions.get(relation.to)
  if (!source || !target) return null

  const sourceCx = source.x + TASK_GRAPH_NODE_WIDTH / 2
  const sourceCy = source.y + TASK_GRAPH_NODE_HEIGHT / 2
  const targetCx = target.x + TASK_GRAPH_NODE_WIDTH / 2
  const targetCy = target.y + TASK_GRAPH_NODE_HEIGHT / 2
  const useVertical = Math.abs(targetCy - sourceCy) > Math.abs(targetCx - sourceCx)

  if (useVertical) {
    const top = sourceCy <= targetCy ? source : target
    const bottom = sourceCy <= targetCy ? target : source
    const x1 = top.x + TASK_GRAPH_NODE_WIDTH / 2
    const y1 = top.y + TASK_GRAPH_NODE_HEIGHT
    const x2 = bottom.x + TASK_GRAPH_NODE_WIDTH / 2
    const y2 = bottom.y
    const midY = (y1 + y2) / 2
    return {
      from: relation.from, to: relation.to, isFork: relation.isFork,
      x1, y1, x2, y2,
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
    }
  }

  const left = sourceCx <= targetCx ? source : target
  const right = sourceCx <= targetCx ? target : source
  const x1 = left.x + TASK_GRAPH_NODE_WIDTH
  const y1 = left.y + TASK_GRAPH_NODE_HEIGHT / 2
  const x2 = right.x
  const y2 = right.y + TASK_GRAPH_NODE_HEIGHT / 2
  const midX = (x1 + x2) / 2
  return {
    from: relation.from, to: relation.to, isFork: relation.isFork,
    x1, y1, x2, y2,
    d: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
  }
}

/**
 * A stable execution-oriented layout. The longest recent dependency path is the mainline;
 * attached work stays below its nearest mainline ancestor and unrelated work moves to a lane.
 */
export function computeTaskGraphLayout(graph: TaskGraph): TaskGraphLayout {
  const nodeIds = Object.keys(graph.nodes).sort((a, b) => compareNodes(graph.nodes[a]!, graph.nodes[b]!))
  if (nodeIds.length === 0) return { positions: [], edges: [], mainline: [], width: 0, height: 0 }

  const relations = collectRelations(graph)
  // 主线只代表实际执行依赖；fork 是探索血缘，只负责把支线贴回锚点，不能反过来夺走主线。
  const dependencyRelations = relations.filter((relation) => !relation.isFork)
  const { children, parents } = buildAdjacency(nodeIds, dependencyRelations)
  const { parents: allParents } = buildAdjacency(nodeIds, relations)
  const mainline = selectMainline(graph, children, parents)
  const mainlineIndex = new Map(mainline.map((id, index) => [id, index]))
  const positions = new Map<string, TaskGraphNodePosition>()

  for (const [index, id] of mainline.entries()) {
    positions.set(id, {
      id,
      x: TASK_GRAPH_CANVAS_PADDING + index * (TASK_GRAPH_NODE_WIDTH + MAINLINE_GAP_X),
      y: TASK_GRAPH_CANVAS_PADDING,
    })
  }

  const branchesByAnchor = new Map<number, Array<{ id: string; depth: number }>>()
  const unlinkedIds: string[] = []
  for (const id of nodeIds) {
    if (mainlineIndex.has(id)) continue
    const anchor = findMainlineAnchor(id, mainlineIndex, allParents)
    if (!anchor) {
      unlinkedIds.push(id)
      continue
    }
    const branch = branchesByAnchor.get(anchor.index) ?? []
    branch.push({ id, depth: anchor.depth })
    branchesByAnchor.set(anchor.index, branch)
  }

  let bottom = TASK_GRAPH_CANVAS_PADDING + TASK_GRAPH_NODE_HEIGHT
  for (const [anchorIndex, branchNodes] of branchesByAnchor) {
    branchNodes.sort((a, b) => (
      a.depth - b.depth || compareNodes(graph.nodes[a.id]!, graph.nodes[b.id]!)
    ))
    const anchor = positions.get(mainline[anchorIndex]!)!
    branchNodes.forEach((branch, row) => {
      const position = {
        id: branch.id,
        x: anchor.x,
        y: anchor.y + TASK_GRAPH_NODE_HEIGHT + BRANCH_GAP_Y + row * (TASK_GRAPH_NODE_HEIGHT + BRANCH_GAP_Y),
      }
      positions.set(branch.id, position)
      bottom = Math.max(bottom, position.y + TASK_GRAPH_NODE_HEIGHT)
    })
  }

  let unlinkedLane: TaskGraphUnlinkedLane | undefined
  if (unlinkedIds.length > 0) {
    const laneY = bottom + UNLINKED_LANE_GAP_Y
    unlinkedLane = { x: TASK_GRAPH_CANVAS_PADDING, y: laneY, count: unlinkedIds.length }
    const columns = Math.max(1, Math.ceil(Math.sqrt(unlinkedIds.length * 1.8)))
    unlinkedIds.forEach((id, index) => {
      const position = {
        id,
        x: TASK_GRAPH_CANVAS_PADDING + (index % columns) * (TASK_GRAPH_NODE_WIDTH + UNLINKED_GRID_GAP_X),
        y: laneY + 28 + Math.floor(index / columns) * (TASK_GRAPH_NODE_HEIGHT + UNLINKED_GRID_GAP_Y),
      }
      positions.set(id, position)
      bottom = Math.max(bottom, position.y + TASK_GRAPH_NODE_HEIGHT)
    })
  }

  const orderedPositions = nodeIds.map((id) => positions.get(id)!).filter(Boolean)
  const right = orderedPositions.reduce((max, position) => Math.max(max, position.x + TASK_GRAPH_NODE_WIDTH), TASK_GRAPH_CANVAS_PADDING)
  const edges = relations.map((relation) => routeEdge(relation, positions)).filter((edge): edge is TaskGraphEdgeRoute => edge !== null)
  return {
    positions: orderedPositions,
    edges,
    mainline,
    ...(unlinkedLane && { unlinkedLane }),
    width: right + TASK_GRAPH_CANVAS_PADDING,
    height: bottom + TASK_GRAPH_CANVAS_PADDING,
  }
}
