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
  stripMetaTags,
  buildGraphFromEvents,
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
