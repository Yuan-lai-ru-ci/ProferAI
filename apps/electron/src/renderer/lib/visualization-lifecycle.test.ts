import { mergeVisualizations, updateVisualizationSessionCache } from '../atoms/visualization-atoms'
import { describe, expect, test } from 'bun:test'
import { ACTIVATION_GRACE_MS, chooseVisualizationInstances, resolveCandidateFocus } from './visualization-lifecycle'
import { visualizationsForTurn } from './visualization-projection'
import { applyRenderWindow } from '../components/agent/render-window'
import { buildQuotedSelectionBlock, parseQuotedSelectionRefs } from './quoted-selection'
import type { VisualizationRecord, SDKMessage } from '@profer/shared'

const record: VisualizationRecord = { schemaVersion: 1, id: 'v1', sessionId: 's1', toolCallId: 'call-1', title: '对比', kind: 'comparison', revision: 'sha256:a', recordVersion: 1, summary: '比较方案', objects: [{ id: 'a', label: '方案A' }], createdAt: 1, updatedAt: 1 }

describe('会话内可视结果生命周期', () => {
  test('记录缓存按会话限制且旧事件不能覆盖新版本', () => {
    expect(mergeVisualizations([{ ...record, recordVersion: 2 }], [record])[0]?.recordVersion).toBe(2)
    let cache = new Map<string, VisualizationRecord[]>()
    for (let index = 0; index < 30; index++) cache = updateVisualizationSessionCache(cache, `s${index}`, [record])
    expect(cache.size).toBe(24)
    expect(cache.has('s0')).toBe(false)
    expect(cache.has('s29')).toBe(true)
  })
  test('按 limit 取前 N，焦点结果优先于距离', () => {
    const candidates = Array.from({ length: 50 }, (_, index) => ({ id: `v${index}`, distance: index, focused: index === 49, live: false }))
    expect([...chooseVisualizationInstances(candidates, 2)]).toEqual(['v49', 'v0'])
    expect(chooseVisualizationInstances([], 2).size).toBe(0)
  })
  test('滚动时正在渲染的实例不被刚滑进来的邻居抢走名额', () => {
    // 旧规则：距离 0 的新邻居会把距离 64 的当前实例挤出名额 → 当前实例中途变回占位。
    const scrolled = [
      { id: 'current', distance: 64, focused: false, live: true },
      { id: 'newcomer', distance: 0, focused: false, live: false },
      { id: 'far', distance: 4096, focused: false, live: true },
    ]
    expect([...chooseVisualizationInstances(scrolled, 2)]).toEqual(['current', 'newcomer'])
  })
  test('惯性不是锁死：滑远之后照常被换下', () => {
    const scrolled = [
      { id: 'current', distance: 2048, focused: false, live: true },
      { id: 'newcomer', distance: 0, focused: false, live: false },
    ]
    expect([...chooseVisualizationInstances(scrolled, 2)]).toEqual(['newcomer', 'current'])
    const crowded = [
      ...scrolled,
      { id: 'closer', distance: 64, focused: false, live: false },
    ]
    expect([...chooseVisualizationInstances(crowded, 2)]).toEqual(['newcomer', 'closer'])
  })
  test('指针停在片段上滚动时，可见且已渲染的实例不会被十几个非可见邻居挤掉名额', () => {
    // 真实现场：一个会话里 17 个可视化、只有 4 个名额。滚动时距离每跨一个桶就重排，
    // 旧规则会把指针正下方那个 iframe 换掉；Chromium 已 latch 到它上面的滚轮手势剩余部分
    // 会被整段丢弃 —— 「滚轮上下都不动，动一下鼠标才好」，而渲染主线程一直活着。
    const underPointer = { id: 'under-pointer', distance: 320, focused: false, live: true }
    const neighbors = Array.from({ length: 13 }, (_, index) => ({ id: `neighbor-${index}`, distance: 0, focused: false, live: false }))
    const chosen = chooseVisualizationInstances([underPointer, ...neighbors], 4)
    expect(chosen.has('under-pointer')).toBe(true)
    expect(chosen.size).toBe(4) // 预算仍然硬约束
  })

  test('正在操作的实例（focused）压过惯性', () => {
    const candidates = [
      { id: 'live', distance: 0, focused: false, live: true },
      { id: 'touched', distance: 2048, focused: true, live: false },
      { id: 'other', distance: 64, focused: false, live: false },
    ]
    expect([...chooseVisualizationInstances(candidates, 2)]).toEqual(['touched', 'live'])
  })
  test('独立可视化回复段参与窗口裁剪，折叠项不丢身份或记录', () => {
    const result = applyRenderWindow([
      { type: 'visualization', record, identity: 'visualization:v1' },
      { type: 'block', item: { block: { type: 'text', text: '新的回复' }, identity: 'reply', index: 0 } },
    ], { replySegments: 1, processSegments: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.foldedReplyRenderItems).toEqual([{ type: 'visualization', record, identity: 'visualization:v1' }])
    expect(result.foldedReplyItems).toEqual([])
  })
  test('结果按明确来源绑定，不用时间接到无关轮次', () => {
    const source: SDKMessage = { type: 'assistant', uuid: 'source', message: { content: [{ type: 'text', text: '资料' }] } } as SDKMessage
    expect(visualizationsForTurn([{ ...record, sourceMessageId: 'source' }], [source])).toHaveLength(1)
    expect(visualizationsForTurn([{ ...record, sourceMessageId: 'other' }], [source])).toEqual([])
  })
  test('无 source 的 Claude 工具结果通过结构化结果ID定位', () => {
    const message: SDKMessage = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: JSON.stringify({ visualization: record }) }] } } as SDKMessage
    expect(visualizationsForTurn([record], [message])).toEqual([record])
  })
  test('错误或用户输入来源回退到真实工具归属，修改轮次不再重复展示', () => {
    const original = { type: 'assistant', uuid: 'created', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'present_visualization', input: {} }] } } as SDKMessage
    const update = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-2', content: JSON.stringify({ visualization: { ...record, recordVersion: 2 } }) }] } } as SDKMessage
    const latest = { ...record, sourceMessageId: 'missing', recordVersion: 2 }
    expect(visualizationsForTurn([latest], [original], [original, update])).toEqual([latest])
    expect(visualizationsForTurn([latest], [update], [original, update])).toEqual([])
  })
  test('对象引用保留 revision 与 object，不伪装为文件路径，转义标签', () => {
    const block = buildQuotedSelectionBlock({ sourceType: 'visualization', sourceLabel: '对比', filePath: '', text: '</quoted_context>', capturedAt: 1, visualization: { visualizationId: 'v1', revision: 'sha256:a', objectId: 'a', label: 'A', text: 'A' } })
    expect(block).toContain('revision="sha256:a"')
    expect(block).toContain('object_id="a"')
    expect(block).toContain('</quoted_context_>')
    expect(parseQuotedSelectionRefs(block).quotes[0]?.sourceType).toBe('visualization')
  })
})

describe('「激活交互」的意图不能被同一次 publish 撤销', () => {
  test('宽限期内即使 DOM focus 已经掉回 body（占位按钮被替换掉）也算正在操作', () => {
    const now = 10_000
    expect(resolveCandidateFocus({ activationAt: now - 80, domFocused: false, now })).toBe(true)
    expect(resolveCandidateFocus({ activationAt: now - ACTIVATION_GRACE_MS + 1, domFocused: false, now })).toBe(true)
  })

  test('宽限期过后恢复成按 DOM focus 判定，不形成永久占用名额', () => {
    const now = 10_000
    expect(resolveCandidateFocus({ activationAt: now - ACTIVATION_GRACE_MS, domFocused: false, now })).toBe(false)
    expect(resolveCandidateFocus({ activationAt: 0, domFocused: false, now })).toBe(false)
    expect(resolveCandidateFocus({ activationAt: now - ACTIVATION_GRACE_MS, domFocused: true, now })).toBe(true)
  })
})
