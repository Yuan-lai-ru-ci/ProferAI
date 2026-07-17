/**
 * project-core 单元测试
 *
 * 覆盖：graph-parser、graph-state、graph-query、project-meta
 */

import { describe, test, expect } from 'bun:test'
import {
  parseDependsOn,
  parseArtifact,
  parseUsage,
  parseForkFrom,
  parseAbandon,
  stripMetaTags,
  buildGraphFromEvents,
  applyEvent,
  createEmptyGraph,
  getReadyTasks,
  serializeEvent,
  deserializeEvent,
  parseEventsFromJsonl,
  generateSummary,
  formatSummaryAsPreamble,
  findNodeById,
  completionPercentage,
  computeLayout,
  computeForceLayout,
  computeForkEdgesLayout,
  deriveGraph,
  formatTaskContext,
  createProjectMeta,
  updateTaskCounts,
  isProjectActive,
  isProjectCompleted,
  projectProgress,
  projectStatusLabel,
  topologicalSort,
  type GraphEvent,
  type TaskGraph,
} from '../src/index'

// ===== graph-parser 测试 =====

describe('graph-parser', () => {
  describe('parseDependsOn', () => {
    test('解析单个依赖', () => {
      const result = parseDependsOn('实现登录功能\n@dependsOn: task-1')
      expect(result).toEqual(['task-1'])
    })

    test('解析多个依赖', () => {
      const result = parseDependsOn('重构认证模块\n@dependsOn: task-1, task-2, task-3')
      expect(result).toEqual(['task-1', 'task-2', 'task-3'])
    })

    test('无依赖标记返回空数组', () => {
      const result = parseDependsOn('一个普通任务描述')
      expect(result).toEqual([])
    })

    test('大小写不敏感', () => {
      const result = parseDependsOn('desc\n@DEPENDSON: a, b')
      expect(result).toEqual(['a', 'b'])
    })
  })

  describe('parseArtifact', () => {
    test('解析产出物', () => {
      const result = parseArtifact('完成了登录\n@artifact: src/login.ts, src/auth.ts')
      expect(result).toEqual(['src/login.ts', 'src/auth.ts'])
    })

    test('无产出物标记返回空数组', () => {
      const result = parseArtifact('完成')
      expect(result).toEqual([])
    })
  })

  describe('stripMetaTags', () => {
    test('清除元标记保留正文', () => {
      const result = stripMetaTags('任务描述正文\n@dependsOn: x\n@artifact: y\n补充说明')
      expect(result).toBe('任务描述正文\n补充说明')
    })
  })

  describe('parseUsage', () => {
    test('解析 usage 标记', () => {
      const result = parseUsage('完成\n@usage: tokens=1500, tools=5, duration=3200')
      expect(result).toEqual({ totalTokens: 1500, toolUses: 5, durationMs: 3200 })
    })

    test('无 usage 标记返回 null', () => {
      const result = parseUsage('无标记的描述')
      expect(result).toBeNull()
    })
  })

  describe('parseForkFrom', () => {
    test('解析分叉来源', () => {
      const result = parseForkFrom('改用 JWT 认证\n@forkFrom: task-1')
      expect(result).toBe('task-1')
    })

    test('无分叉标记返回 null', () => {
      const result = parseForkFrom('普通任务')
      expect(result).toBeNull()
    })

    test('大小写不敏感', () => {
      const result = parseForkFrom('desc\n@FORKFROM: task-42')
      expect(result).toBe('task-42')
    })
  })

  describe('stripMetaTags with forkFrom', () => {
    test('清除 @forkFrom 标记', () => {
      const result = stripMetaTags('任务正文\n@dependsOn: x\n@forkFrom: task-1\n@artifact: y')
      expect(result).toBe('任务正文')
    })
  })

  describe('parseAbandon', () => {
    test('解析放弃原因', () => {
      const result = parseAbandon('探索向量检索\n@abandon: 召回率太低，改用关键词匹配')
      expect(result).toBe('召回率太低，改用关键词匹配')
    })

    test('无放弃标记返回 null', () => {
      expect(parseAbandon('普通任务描述')).toBeNull()
    })

    test('大小写不敏感', () => {
      expect(parseAbandon('desc\n@ABANDON: 前提不成立')).toBe('前提不成立')
    })

    test('stripMetaTags 清除 @abandon 标记', () => {
      const result = stripMetaTags('任务正文\n@abandon: 走不通\n@artifact: y')
      expect(result).toBe('任务正文')
    })
  })
})

// ===== graph-state 测试 =====

describe('graph-state', () => {
  test('从空开始构建 Graph', () => {
    const graph = createEmptyGraph()
    expect(Object.keys(graph.nodes).length).toBe(0)
    expect(graph.edges.length).toBe(0)
  })

  test('事件重放构建完整 Graph', () => {
    const events: GraphEvent[] = [
      {
        type: 'task_created',
        timestamp: 1000,
        taskId: 'task-1',
        payload: { subject: '任务一', description: '第一个任务', dependsOn: [] },
      },
      {
        type: 'task_created',
        timestamp: 2000,
        taskId: 'task-2',
        payload: { subject: '任务二', description: '依赖任务一', dependsOn: ['task-1'] },
      },
      {
        type: 'task_status_changed',
        timestamp: 3000,
        taskId: 'task-1',
        payload: { oldStatus: null, newStatus: 'completed' },
      },
    ]

    const graph = buildGraphFromEvents(events)

    expect(Object.keys(graph.nodes).length).toBe(2)
    expect(graph.nodes['task-1']!.status).toBe('completed')
    expect(graph.nodes['task-2']!.status).toBe('pending')
    expect(graph.nodes['task-2']!.dependsOn).toEqual(['task-1'])
    // 验证反向边
    expect(graph.nodes['task-1']!.dependedBy).toContain('task-2')
    // 验证边
    expect(graph.edges.length).toBe(1)
    expect(graph.edges[0]!.from).toBe('task-2')
    expect(graph.edges[0]!.to).toBe('task-1')
  })

  test('task_created materializes metadata consistently with live derivation', () => {
    const description = '初始实现\n@artifact: src/a.ts\n@usage: tokens=500, tools=2\n@forkFrom: root\n@abandon: 改用新方案'
    const graph = buildGraphFromEvents([
      { type: 'task_created', timestamp: 1000, taskId: 'root', payload: { subject: '原方案', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 1100, taskId: 't1', payload: { subject: '实现', description, dependsOn: [] } },
    ])
    const node = graph.nodes['t1']!
    expect(node.artifact).toEqual(['src/a.ts'])
    expect(node.usage).toEqual({ totalTokens: 500, toolUses: 2 })
    expect(node.forkFrom).toBe('root')
    expect(node.abandonReason).toBe('改用新方案')
    expect(node.status).toBe('cancelled')
  })

  test('task_updated replaces the previous fork edge and suppresses dangling sources', () => {
    const graph = buildGraphFromEvents([
      { type: 'task_created', timestamp: 1000, taskId: 'a', payload: { subject: 'A', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 1100, taskId: 'b', payload: { subject: 'B', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 1200, taskId: 't1', payload: { subject: '实现', description: '@forkFrom: a', dependsOn: [] } },
      { type: 'task_updated', timestamp: 1300, taskId: 't1', payload: { description: '@forkFrom: b' } },
      { type: 'task_created', timestamp: 1400, taskId: 't2', payload: { subject: '悬空', description: '@forkFrom: missing', dependsOn: [] } },
    ])
    expect(graph.nodes['t1']!.forkFrom).toBe('b')
    expect(graph.forkEdges).toEqual([{ from: 'b', to: 't1' }])
  })

  test('task_updated materializes and merges artifact, usage, fork, and dependency metadata', () => {
    const graph = buildGraphFromEvents([
      { type: 'task_created', timestamp: 1000, taskId: 'root', payload: { subject: '原方案', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 1050, taskId: 'setup', payload: { subject: '前置准备', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 1100, taskId: 't1', payload: { subject: '实现', description: '', dependsOn: [] } },
      { type: 'task_artifact_added', timestamp: 1200, taskId: 't1', payload: { artifact: 'existing.ts' } },
      {
        type: 'task_updated',
        timestamp: 1300,
        taskId: 't1',
        payload: {
          description: '完成实现\n@artifact: existing.ts, src/new.ts\n@usage: tokens=900, tools=3\n@forkFrom: root\n@dependsOn: setup',
        },
      },
    ])
    const node = graph.nodes['t1']!
    expect(node.description).toBe('完成实现')
    expect(node.artifact).toEqual(['existing.ts', 'src/new.ts'])
    expect(node.usage).toEqual({ totalTokens: 900, toolUses: 3 })
    expect(node.forkFrom).toBe('root')
    expect(node.dependsOn).toEqual(['setup'])
    expect(graph.nodes['setup']!.dependedBy).toEqual(['t1'])
    expect(graph.edges).toContainEqual({ from: 't1', to: 'setup' })
    expect(graph.forkEdges).toEqual([{ from: 'root', to: 't1' }])
  })

  test('live derivation and event replay agree on TaskUpdate metadata', () => {
    const description = '完成实现\n@artifact: src/a.ts, src/b.ts\n@usage: tokens=700, tools=2\n@forkFrom: root\n@dependsOn: setup'
    const live = deriveGraph([
      { id: 'root', subject: '原方案', status: 'completed' },
      { id: 'setup', subject: '前置准备', status: 'completed' },
      { id: 't1', subject: '新方案', description, status: 'failed' },
    ])
    const persisted = buildGraphFromEvents([
      { type: 'task_created', timestamp: 1000, taskId: 'root', payload: { subject: '原方案', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 1050, taskId: 'setup', payload: { subject: '前置准备', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 1100, taskId: 't1', payload: { subject: '新方案', description: '', dependsOn: [] } },
      { type: 'task_updated', timestamp: 1200, taskId: 't1', payload: { description } },
      { type: 'task_status_changed', timestamp: 1300, taskId: 't1', payload: { oldStatus: null, newStatus: 'failed' } },
    ])

    expect({
      description: persisted.nodes['t1']!.description,
      artifact: persisted.nodes['t1']!.artifact,
      usage: persisted.nodes['t1']!.usage,
      forkFrom: persisted.nodes['t1']!.forkFrom,
      dependsOn: persisted.nodes['t1']!.dependsOn,
      dependedBy: persisted.nodes['setup']!.dependedBy,
      edges: persisted.edges,
      status: persisted.nodes['t1']!.status,
    }).toEqual({
      description: live.nodes['t1']!.description,
      artifact: live.nodes['t1']!.artifact,
      usage: live.nodes['t1']!.usage,
      forkFrom: live.nodes['t1']!.forkFrom,
      dependsOn: live.nodes['t1']!.dependsOn,
      dependedBy: live.nodes['setup']!.dependedBy,
      edges: live.edges,
      status: live.nodes['t1']!.status,
    })
  })

  test('tasks without explicit dependencies remain independent', () => {
    const graph = buildGraphFromEvents([
      { type: 'task_created', timestamp: 1000, taskId: 'a', payload: { subject: 'A', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 2000, taskId: 'b', payload: { subject: 'B', description: '', dependsOn: [] } },
    ])
    expect(graph.edges).toEqual([])
    expect(graph.nodes['a']!.dependsOn).toEqual([])
    expect(graph.nodes['a']!.dependedBy).toEqual([])
    expect(graph.nodes['b']!.dependsOn).toEqual([])
    expect(graph.nodes['b']!.dependedBy).toEqual([])
  })

  test('deriveGraph leaves independent input task items unchanged', () => {
    const items = [
      { id: 'a', subject: 'A', status: 'pending' as const },
      { id: 'b', subject: 'B', status: 'pending' as const },
    ]
    const snapshot = structuredClone(items)
    const graph = deriveGraph(items)
    expect(graph.edges).toEqual([])
    expect(items).toEqual(snapshot)
  })

  test('getReadyTasks 返回所有依赖已满足的 Task', () => {
    const events: GraphEvent[] = [
      { type: 'task_created', timestamp: 1000, taskId: 't1', payload: { subject: 'A', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 2000, taskId: 't2', payload: { subject: 'B', description: '', dependsOn: ['t1'] } },
      { type: 'task_created', timestamp: 3000, taskId: 't3', payload: { subject: 'C', description: '', dependsOn: ['t1'] } },
      { type: 'task_status_changed', timestamp: 4000, taskId: 't1', payload: { oldStatus: null, newStatus: 'completed' } },
    ]
    const graph = buildGraphFromEvents(events)
    const ready = getReadyTasks(graph)
    expect(ready.length).toBe(2)
    expect(ready.map(n => n.id).sort()).toEqual(['t2', 't3'])
  })

  test('拓扑排序', () => {
    const events: GraphEvent[] = [
      { type: 'task_created', timestamp: 1000, taskId: 'a', payload: { subject: 'A', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 2000, taskId: 'b', payload: { subject: 'B', description: '', dependsOn: ['a'] } },
      { type: 'task_created', timestamp: 3000, taskId: 'c', payload: { subject: 'C', description: '', dependsOn: ['b'] } },
    ]
    const graph = buildGraphFromEvents(events)
    const sorted = topologicalSort(graph)
    const ids = sorted.map(n => n.id)
    // A 应在 B 前，B 应在 C 前
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'))
  })

  test('事件序列化/反序列化往返', () => {
    const event: GraphEvent = {
      type: 'task_created',
      timestamp: 1234567890,
      taskId: 'test-id',
      payload: { subject: '测试', description: '描述', dependsOn: ['dep-1'] },
    }
    const line = serializeEvent(event)
    const parsed = deserializeEvent(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe(event.type)
    expect(parsed!.taskId).toBe(event.taskId)
  })

  test('parseEventsFromJsonl 多行解析', () => {
    const events: GraphEvent[] = [
      { type: 'task_created', timestamp: 1000, taskId: '1', payload: { subject: 'A', description: '', dependsOn: [] } },
      { type: 'task_status_changed', timestamp: 2000, taskId: '1', payload: { oldStatus: null, newStatus: 'completed' } },
    ]
    const jsonl = events.map(serializeEvent).join('\n')
    const parsed = parseEventsFromJsonl(jsonl)
    expect(parsed.length).toBe(2)
  })
})

describe('graph-state · task_abandon_annotated（回溯放弃标注）', () => {
  const created = (id: string, ts: number): GraphEvent => ({
    type: 'task_created', timestamp: ts, taskId: id,
    payload: { subject: `任务${id}`, description: '', dependsOn: [] },
  })
  const abandon = (id: string, ts: number): GraphEvent => ({
    type: 'task_abandon_annotated', timestamp: ts, taskId: id,
    payload: { reason: '走不通，换方案', confidence: 0.9, evidenceTurns: [5, 7], source: 'retrospective' },
  })

  test('写入放弃字段，且非 completed 节点被标为 cancelled', () => {
    const graph = buildGraphFromEvents([created('t1', 1000), abandon('t1', 2000)])
    const n = graph.nodes['t1']!
    expect(n.abandonReason).toBe('走不通，换方案')
    expect(n.abandonConfidence).toBe(0.9)
    expect(n.abandonEvidence).toEqual([5, 7])
    expect(n.status).toBe('cancelled')
  })

  test('已 completed 的节点保留 completed，但仍写入放弃原因', () => {
    const graph = buildGraphFromEvents([
      created('t1', 1000),
      { type: 'task_status_changed', timestamp: 1500, taskId: 't1', payload: { oldStatus: null, newStatus: 'completed' } },
      abandon('t1', 2000),
    ])
    const n = graph.nodes['t1']!
    expect(n.status).toBe('completed')
    expect(n.abandonReason).toBe('走不通，换方案')
  })

  test('幂等：重放两次结果相同', () => {
    const events = [created('t1', 1000), abandon('t1', 2000)]
    const once = buildGraphFromEvents(events)
    const twice = buildGraphFromEvents([...events, abandon('t1', 2000)])
    expect(twice.nodes['t1']).toEqual(once.nodes['t1'])
  })

  test('挂到不存在的节点 → no-op，不崩、不造节点', () => {
    const graph = buildGraphFromEvents([created('t1', 1000), abandon('ghost', 2000)])
    expect(Object.keys(graph.nodes)).toEqual(['t1'])
    expect(graph.nodes['t1']!.abandonReason).toBeUndefined()
  })

  test('新事件类型序列化/反序列化往返', () => {
    const line = serializeEvent(abandon('t1', 2000))
    const parsed = deserializeEvent(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe('task_abandon_annotated')
    expect((parsed!.payload as { reason: string }).reason).toBe('走不通，换方案')
  })

  test('Agent 显式标注（source=agent，confidence=1，无证据轮次）同样写入枯枝', () => {
    const agentAbandon: GraphEvent = {
      type: 'task_abandon_annotated', timestamp: 2000, taskId: 't1',
      payload: { reason: '换更好的思路', confidence: 1, evidenceTurns: [], source: 'agent' },
    }
    const graph = buildGraphFromEvents([created('t1', 1000), agentAbandon])
    const n = graph.nodes['t1']!
    expect(n.abandonReason).toBe('换更好的思路')
    expect(n.abandonConfidence).toBe(1)
    expect(n.status).toBe('cancelled')
  })
})

describe('graph-state · task_deleted（真删除，从图移除节点）', () => {
  // t1 ← t2 ← t3（t2 依赖 t1，t3 依赖 t2）
  const baseEvents = (): GraphEvent[] => [
    { type: 'task_created', timestamp: 1000, taskId: 't1', payload: { subject: 'A', description: '', dependsOn: [] } },
    { type: 'task_created', timestamp: 2000, taskId: 't2', payload: { subject: 'B', description: '', dependsOn: ['t1'] } },
    { type: 'task_created', timestamp: 3000, taskId: 't3', payload: { subject: 'C', description: '', dependsOn: ['t2'] } },
  ]
  const del = (id: string, ts: number): GraphEvent => ({
    type: 'task_deleted', timestamp: ts, taskId: id, payload: { source: 'agent' },
  })

  test('删除节点 → 从 nodes 移除，并清理依赖边与 dependsOn/dependedBy 引用', () => {
    const graph = buildGraphFromEvents(baseEvents())
    const after = applyEvent(graph, del('t2', 4000))
    // t2 已移除
    expect(after.nodes['t2']).toBeUndefined()
    expect(Object.keys(after.nodes).sort()).toEqual(['t1', 't3'])
    // t3 曾依赖 t2 → dependsOn 清理
    expect(after.nodes['t3']!.dependsOn).toEqual([])
    // t1 曾被 t2 依赖 → dependedBy 清理
    expect(after.nodes['t1']!.dependedBy).toEqual([])
    // 所有指向 t2 的边都被清除
    expect(after.edges.some(e => e.from === 't2' || e.to === 't2')).toBe(false)
  })

  test('删除不存在的节点 → no-op，不崩', () => {
    const graph = buildGraphFromEvents(baseEvents())
    const after = applyEvent(graph, del('ghost', 4000))
    expect(Object.keys(after.nodes).sort()).toEqual(['t1', 't2', 't3'])
  })

  test('幂等：重复删除同一节点结果相同', () => {
    const graph = buildGraphFromEvents(baseEvents())
    const once = applyEvent(graph, del('t2', 4000))
    const twice = applyEvent(once, del('t2', 5000))
    expect(Object.keys(twice.nodes).sort()).toEqual(['t1', 't3'])
    expect(twice.nodes['t3']!.dependsOn).toEqual([])
  })

  test('重放：task_created 后 task_deleted，节点最终不存在', () => {
    const graph = buildGraphFromEvents([
      ...baseEvents(),
      del('t1', 4000),
    ])
    expect(graph.nodes['t1']).toBeUndefined()
    // t2 曾依赖 t1，引用被清
    expect(graph.nodes['t2']!.dependsOn).toEqual([])
  })

  test('删除与枯枝共存：删一个节点不影响另一节点的放弃标注', () => {
    const graph = buildGraphFromEvents([
      { type: 'task_created', timestamp: 1000, taskId: 't1', payload: { subject: 'A', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 2000, taskId: 't2', payload: { subject: 'B', description: '', dependsOn: [] } },
      { type: 'task_abandon_annotated', timestamp: 3000, taskId: 't1', payload: { reason: '走不通', confidence: 0.9, evidenceTurns: [2], source: 'retrospective' } },
      { type: 'task_deleted', timestamp: 4000, taskId: 't2', payload: { source: 'user' } },
    ])
    expect(graph.nodes['t2']).toBeUndefined()
    expect(graph.nodes['t1']!.abandonReason).toBe('走不通')
    expect(graph.nodes['t1']!.status).toBe('cancelled')
  })

  test('新事件类型序列化/反序列化往返', () => {
    const line = serializeEvent(del('t2', 4000))
    const parsed = deserializeEvent(line)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe('task_deleted')
  })
})

// ===== graph-query 测试 =====

describe('graph-query', () => {
  function createSampleGraph(): TaskGraph {
    const events: GraphEvent[] = [
      { type: 'task_created', timestamp: 1000, taskId: 't1', payload: { subject: '已完成任务', description: '', dependsOn: [] } },
      { type: 'task_status_changed', timestamp: 2000, taskId: 't1', payload: { oldStatus: null, newStatus: 'completed' } },
      { type: 'task_artifact_added', timestamp: 2500, taskId: 't1', payload: { artifact: 'src/a.ts' } },
      { type: 'task_created', timestamp: 3000, taskId: 't2', payload: { subject: '进行中任务', description: '', dependsOn: ['t1'] } },
      { type: 'task_status_changed', timestamp: 4000, taskId: 't2', payload: { oldStatus: null, newStatus: 'in_progress' } },
      { type: 'task_created', timestamp: 5000, taskId: 't3', payload: { subject: '待处理任务', description: '', dependsOn: ['t2'] } },
    ]
    return buildGraphFromEvents(events)
  }

  test('generateSummary 统计正确', () => {
    const graph = createSampleGraph()
    const summary = generateSummary(graph)
    expect(summary.totalTasks).toBe(3)
    expect(summary.statusCounts.completed).toBe(1)
    expect(summary.statusCounts.in_progress).toBe(1)
    expect(summary.statusCounts.pending).toBe(1)
    expect(summary.recentCompleted.length).toBe(1)
    expect(summary.recentCompleted[0]!.artifact).toContain('src/a.ts')
  })

  test('formatSummaryAsPreamble 生成中文文本', () => {
    const graph = createSampleGraph()
    const summary = generateSummary(graph)
    const preamble = formatSummaryAsPreamble(summary)
    expect(preamble).toContain('3')
    expect(preamble).toContain('已完成')
    expect(preamble).not.toContain('Graph')
  })

  test('findNodeById', () => {
    const graph = createSampleGraph()
    expect(findNodeById(graph, 't1')!.subject).toBe('已完成任务')
    expect(findNodeById(graph, 'nonexistent')).toBeNull()
  })

  test('completionPercentage', () => {
    const graph = createSampleGraph()
    const pct = completionPercentage(graph)
    expect(pct).toBe(33) // 1/3 ≈ 33%
  })

  test('computeLayout 分层正确', () => {
    const graph = createSampleGraph()
    const layout = computeLayout(graph)
    expect(layout.totalLevels).toBe(3)
    const level0Ids = layout.levels[0]!.nodes.map(n => n.id)
    const level1Ids = layout.levels[1]!.nodes.map(n => n.id)
    const level2Ids = layout.levels[2]!.nodes.map(n => n.id)
    expect(level0Ids).toContain('t1')
    expect(level1Ids).toContain('t2')
    expect(level2Ids).toContain('t3')
  })

  test('computeLayout 空图返回空结果', () => {
    const layout = computeLayout({ nodes: {}, edges: [], forkEdges: [], updatedAt: 0 })
    expect(layout.totalLevels).toBe(0)
    expect(layout.levels).toEqual([])
  })

  test('deriveGraph 解析 @forkFrom 标记', () => {
    const graph = deriveGraph([
      { id: 't1', subject: '原方案', status: 'completed' },
      { id: 't2', subject: '修正方案 @forkFrom: t1', status: 'pending' },
    ])
    expect(graph.nodes['t2']!.forkFrom).toBe('t1')
    expect(graph.nodes['t2']!.subject).toBe('修正方案')
    expect(graph.forkEdges.length).toBe(1)
    expect(graph.forkEdges[0]!.from).toBe('t1')
    expect(graph.forkEdges[0]!.to).toBe('t2')
  })

  test('deriveGraph 从 description 解析 @forkFrom（prompt 约定的主路径）', () => {
    const graph = deriveGraph([
      { id: 't1', subject: '原方案', status: 'completed' },
      { id: 't2', subject: '修正方案', description: '重做登录\n@forkFrom: t1', status: 'pending' },
    ])
    expect(graph.nodes['t2']!.forkFrom).toBe('t1')
    expect(graph.forkEdges.length).toBe(1)
    expect(graph.forkEdges[0]!.from).toBe('t1')
    expect(graph.forkEdges[0]!.to).toBe('t2')
    // description 中的标记应被清除，不残留
    expect(graph.nodes['t2']!.description).not.toContain('@forkFrom')
  })

  test('deriveGraph 从 description 解析 @dependsOn', () => {
    const graph = deriveGraph([
      { id: 't1', subject: '接口设计', status: 'completed' },
      { id: 't2', subject: '实现登录', description: '写代码\n@dependsOn: t1', status: 'pending' },
    ])
    expect(graph.nodes['t2']!.dependsOn).toEqual(['t1'])
    expect(graph.edges.some(e => e.from === 't2' && e.to === 't1')).toBe(true)
  })

  test('deriveGraph 从 description 解析 @abandon（实时枯枝，非 completed 置 cancelled）', () => {
    const graph = deriveGraph([
      { id: 't1', subject: '探索向量检索', description: '试了半天\n@abandon: 召回率太低，改用关键词', status: 'in_progress' },
    ])
    const n = graph.nodes['t1']!
    expect(n.abandonReason).toBe('召回率太低，改用关键词')
    expect(n.status).toBe('cancelled')
    // 标记不残留在展示描述里
    expect(n.description).not.toContain('@abandon')
  })

  test('deriveGraph @abandon 的 completed 节点保留 completed 但仍带原因', () => {
    const graph = deriveGraph([
      { id: 't1', subject: '方案A', description: '@abandon: 后来发现更优解', status: 'completed' },
    ])
    expect(graph.nodes['t1']!.status).toBe('completed')
    expect(graph.nodes['t1']!.abandonReason).toBe('后来发现更优解')
  })

  test('deriveGraph description 优先，subject 回退兼容', () => {
    // 标记写在 subject（历史情况）仍应生效
    const graph = deriveGraph([
      { id: 't1', subject: '原方案', status: 'completed' },
      { id: 't2', subject: '修正 @forkFrom: t1', status: 'pending' },
    ])
    expect(graph.nodes['t2']!.forkFrom).toBe('t1')
  })

  test('deriveGraph parses artifact and usage metadata from description', () => {
    const graph = deriveGraph([
      {
        id: 't1',
        subject: '实现登录 @artifact: legacy.ts',
        description: '完成实现\n@artifact: src/login.ts, src/auth.ts\n@usage: tokens=1200, tools=4, duration=3000',
        status: 'failed',
      },
    ])
    const node = graph.nodes['t1']!
    expect(node.artifact).toEqual(['src/login.ts', 'src/auth.ts'])
    expect(node.usage).toEqual({ totalTokens: 1200, toolUses: 4, durationMs: 3000 })
    expect(node.status).toBe('failed')
    expect(node.subject).toBe('实现登录')
    expect(node.description).toBe('完成实现')
  })

  test('deriveGraph falls back to subject metadata for historical task items', () => {
    const graph = deriveGraph([
      {
        id: 't1',
        subject: '历史任务 @artifact: legacy.ts\n@usage: tokens=800, tools=2',
        status: 'completed',
      },
    ])
    expect(graph.nodes['t1']!.artifact).toEqual(['legacy.ts'])
    expect(graph.nodes['t1']!.usage).toEqual({ totalTokens: 800, toolUses: 2 })
  })

  test('deriveGraph does not create a dangling fork edge', () => {
    const graph = deriveGraph([
      { id: 't2', subject: '修正方案 @forkFrom: missing', status: 'pending' },
    ])
    expect(graph.nodes['t2']!.forkFrom).toBe('missing')
    expect(graph.forkEdges).toEqual([])
  })

  test('buildGraphFromEvents 从 description 解析 @forkFrom（持久化路径）', () => {
    const graph = buildGraphFromEvents([
      { type: 'task_created', timestamp: 1000, taskId: 't1', payload: { subject: '原方案', description: '', dependsOn: [] } },
      { type: 'task_created', timestamp: 2000, taskId: 't2', payload: { subject: '修正方案', description: '重做\n@forkFrom: t1', dependsOn: [] } },
    ])
    expect(graph.nodes['t2']!.forkFrom).toBe('t1')
    expect(graph.forkEdges.some(e => e.from === 't1' && e.to === 't2')).toBe(true)
    expect(graph.nodes['t2']!.description).not.toContain('@forkFrom')
  })

  test('formatTaskContext 格式化节点上下文', () => {
    const graph = deriveGraph([
      { id: 't1', subject: '实现注册 API', status: 'in_progress' },
      { id: 't2', subject: '邮箱验证 @dependsOn: t1', status: 'pending' },
      { id: 't3', subject: '密码加密 @dependsOn: t1', status: 'pending' },
    ])
    const node = graph.nodes['t1']!
    const ctx = formatTaskContext(node, graph)
    expect(ctx).toContain('实现注册 API')
    expect(ctx).toContain('in_progress')
    expect(ctx).toContain('邮箱验证')
    expect(ctx).toContain('密码加密')
    expect(ctx).toContain('该 Task 依赖：无')
  })

  test('formatTaskContext 包含分叉信息', () => {
    const graph = deriveGraph([
      { id: 't1', subject: '原始方案', status: 'completed' },
      { id: 't2', subject: '新方案 @forkFrom: t1', status: 'in_progress' },
    ])
    const node = graph.nodes['t2']!
    const ctx = formatTaskContext(node, graph)
    expect(ctx).toContain('分叉自：原始方案')
  })
})

// ===== project-meta 测试 =====

describe('project-meta', () => {
  test('createProjectMeta', () => {
    const meta = createProjectMeta('session-123', '/path/to/graph.jsonl')
    expect(meta.mainSessionId).toBe('session-123')
    expect(meta.projectStatus).toBe('active')
    expect(meta.totalTasks).toBe(0)
    expect(meta.completedTasks).toBe(0)
  })

  test('updateTaskCounts', () => {
    const meta = createProjectMeta('s1', '/p')
    const updated = updateTaskCounts(meta, 10, 7)
    expect(updated.totalTasks).toBe(10)
    expect(updated.completedTasks).toBe(7)
  })

  test('projectProgress', () => {
    let meta = createProjectMeta('s1', '/p')
    meta = updateTaskCounts(meta, 10, 7)
    expect(projectProgress(meta)).toBe(70)
  })

  test('生命周期', () => {
    const meta = createProjectMeta('s1', '/p')
    expect(isProjectActive(meta)).toBe(true)
    expect(isProjectCompleted(meta)).toBe(false)

    // 模拟完成
    const completed = { ...meta, projectStatus: 'completed' as const }
    expect(isProjectCompleted(completed)).toBe(true)
  })

  test('projectStatusLabel', () => {
    const meta = createProjectMeta('s1', '/p')
    expect(projectStatusLabel(meta)).toBe('进行中')

    const withTasks = updateTaskCounts(meta, 10, 5)
    expect(projectStatusLabel(withTasks)).toBe('进行中（50%）')

    const archived = { ...meta, projectStatus: 'archived' as const }
    expect(projectStatusLabel(archived)).toBe('已归档')
  })
})

// ===== graph-query 力导向布局测试 =====

describe('computeForceLayout', () => {
  test('空图返回空结果', () => {
    const result = computeForceLayout({ nodes: {}, edges: [], forkEdges: [], updatedAt: 0 })
    expect(result.positions.size).toBe(0)
    expect(result.canvasWidth).toBe(800)
    expect(result.canvasHeight).toBe(600)
    expect(result.iterations).toBe(0)
  })

  test('单节点布局在画布内', () => {
    const graph: TaskGraph = {
      nodes: {
        't1': { id: 't1', subject: '任务一', description: '', status: 'pending',
          dependsOn: [], dependedBy: [], artifact: [], reviewStatus: 'none' as const, createdAt: 1000, updatedAt: 1000 },
      },
      edges: [],
      forkEdges: [],
      updatedAt: 1000,
    }
    const result = computeForceLayout(graph, { iterations: 50 })
    expect(result.positions.size).toBe(1)
    const pos = result.positions.get('t1')
    expect(pos).toBeDefined()
    expect(pos!.x).toBeGreaterThan(0)
    expect(pos!.y).toBeGreaterThan(0)
    expect(result.canvasWidth).toBeGreaterThan(0)
    expect(result.canvasHeight).toBeGreaterThan(0)
  })

  test('线性链（A→B→C）保持从左到右阅读顺序', () => {
    const graph: TaskGraph = {
      nodes: {
        'a': { id: 'a', subject: 'A', description: '', status: 'completed',
          dependsOn: [], dependedBy: ['b'], artifact: [], reviewStatus: 'none' as const, createdAt: 1000, updatedAt: 1000 },
        'b': { id: 'b', subject: 'B', description: '', status: 'in_progress',
          dependsOn: ['a'], dependedBy: ['c'], artifact: [], reviewStatus: 'none' as const, createdAt: 2000, updatedAt: 2000 },
        'c': { id: 'c', subject: 'C', description: '', status: 'pending',
          dependsOn: ['b'], dependedBy: [], artifact: [], reviewStatus: 'none' as const, createdAt: 3000, updatedAt: 3000 },
      },
      edges: [{ from: 'b', to: 'a' }, { from: 'c', to: 'b' }],
      forkEdges: [],
      updatedAt: 3000,
    }
    const result = computeForceLayout(graph, { iterations: 100 })
    const aX = result.positions.get('a')!.x
    const bX = result.positions.get('b')!.x
    const cX = result.positions.get('c')!.x
    expect(aX).toBeLessThan(bX)
    expect(bX).toBeLessThan(cX)
  })

  test('分支图（A→B 且 A→C 且 B→D 且 C→D）形成菱形', () => {
    const graph: TaskGraph = {
      nodes: {
        'a': { id: 'a', subject: 'A', description: '', status: 'completed',
          dependsOn: [], dependedBy: ['b', 'c'], artifact: [], reviewStatus: 'none' as const, createdAt: 1000, updatedAt: 1000 },
        'b': { id: 'b', subject: 'B', description: '', status: 'completed',
          dependsOn: ['a'], dependedBy: ['d'], artifact: [], reviewStatus: 'none' as const, createdAt: 2000, updatedAt: 2000 },
        'c': { id: 'c', subject: 'C', description: '', status: 'in_progress',
          dependsOn: ['a'], dependedBy: ['d'], artifact: [], reviewStatus: 'none' as const, createdAt: 2500, updatedAt: 2500 },
        'd': { id: 'd', subject: 'D', description: '', status: 'pending',
          dependsOn: ['b', 'c'], dependedBy: [], artifact: [], reviewStatus: 'none' as const, createdAt: 3000, updatedAt: 3000 },
      },
      edges: [
        { from: 'b', to: 'a' }, { from: 'c', to: 'a' },
        { from: 'd', to: 'b' }, { from: 'd', to: 'c' },
      ],
      forkEdges: [],
      updatedAt: 3000,
    }
    const result = computeForceLayout(graph, { iterations: 150 })
    const aX = result.positions.get('a')!.x
    const bX = result.positions.get('b')!.x
    const cX = result.positions.get('c')!.x
    const dX = result.positions.get('d')!.x

    // B 和 C 应该在 A 和 D 之间（大体顺序）
    expect(aX).toBeLessThan(bX)
    expect(aX).toBeLessThan(cX)
    expect(bX).toBeLessThan(dX)
    expect(cX).toBeLessThan(dX)

    // B 和 C 应该有一定垂直分离（分叉效果）
    const bY = result.positions.get('b')!.y
    const cY = result.positions.get('c')!.y
    const yDiff = Math.abs(bY - cY)
    expect(yDiff).toBeGreaterThan(10)
  })

  test('包含分叉边的图正确参与力模拟并生成布局数据', () => {
    const graph: TaskGraph = {
      nodes: {
        't1': { id: 't1', subject: '原始方案', description: '', status: 'completed',
          dependsOn: [], dependedBy: [], artifact: [], reviewStatus: 'none' as const, createdAt: 1000, updatedAt: 1000,
          forkFrom: undefined },
        't2': { id: 't2', subject: '改进方案', description: '', status: 'in_progress',
          dependsOn: [], dependedBy: [], artifact: [], reviewStatus: 'none' as const, createdAt: 2000, updatedAt: 2000,
          forkFrom: 't1' },
      },
      edges: [],
      forkEdges: [{ from: 't1', to: 't2', reason: '改用新方案' }],
      updatedAt: 2000,
    }
    const result = computeForceLayout(graph, { iterations: 100 })
    expect(result.positions.size).toBe(2)

    // forkEdges 参与了力模拟，两个节点距离不会太远
    const t1 = result.positions.get('t1')!
    const t2 = result.positions.get('t2')!
    const dist = Math.sqrt((t1.x - t2.x) ** 2 + (t1.y - t2.y) ** 2)
    // 分叉节点有弹簧引力，距离应在合理范围内
    expect(dist).toBeLessThan(1200)

    // computeForkEdgesLayout 应正确生成分叉边布局
    const forkLayouts = computeForkEdgesLayout(graph, result.positions, 260, 100)
    expect(forkLayouts.length).toBe(1)
    expect(forkLayouts[0]!.from).toBe('t1')
    expect(forkLayouts[0]!.to).toBe('t2')
    expect(forkLayouts[0]!.reason).toBe('改用新方案')
  })
})
