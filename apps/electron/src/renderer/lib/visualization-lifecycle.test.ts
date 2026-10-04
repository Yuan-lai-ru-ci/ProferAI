import { mergeVisualizations, updateVisualizationSessionCache } from '../atoms/visualization-atoms'
import { describe, expect, test } from 'bun:test'
import { chooseVisualizationInstances } from './visualization-lifecycle'
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
  test('历史展开时活动预算保持两份，焦点结果优先于距离', () => {
    const candidates = Array.from({ length: 50 }, (_, index) => ({ id: `v${index}`, distance: index, focused: index === 49 }))
    expect([...chooseVisualizationInstances(candidates)]).toEqual(['v49', 'v0'])
    expect(chooseVisualizationInstances([]).size).toBe(0)
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
