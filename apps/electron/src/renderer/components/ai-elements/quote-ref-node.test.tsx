import * as React from 'react'
import { describe, expect, mock, test } from 'bun:test'
import { getSchema, Node as TiptapNode } from '@tiptap/core'
import type { NodeViewProps } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { history, undo } from '@tiptap/pm/history'
import type { EditorView } from '@tiptap/pm/view'
import { createLoadedHost } from '../../../../scripts/settings-loaded-visual-host'
import { QuoteRefChipView } from './quote-ref-chip'
import { QuoteRef, createQuoteRefInsertTransaction, createQuoteRefPlugin, type QuoteRefPayload } from './quote-ref-node'

const schema = getSchema([
  TiptapNode.create({ name: 'doc', topNode: true, content: 'paragraph+' }),
  TiptapNode.create({ name: 'paragraph', group: 'block', content: 'inline*' }),
  TiptapNode.create({ name: 'text', group: 'inline' }),
  QuoteRef,
])
const quote = (id: string, origin: QuoteRefPayload['origin'] = 'manual'): QuoteRefPayload => ({
  text: `原文 ${id}`, filePath: `/tmp/${id}.md`, sourceType: 'file', capturedAt: 1, origin,
})
const chip = (id: string, origin?: QuoteRefPayload['origin']) => schema.nodes.quoteRef!.create({ n: 1, quote: quote(id, origin) })
const text = (value: string) => schema.text(value)
function stateFor(content: ProseMirrorNode[], cursor = 1) {
  let index = 0
  const numbered = content.map((node) => node.type.name === 'quoteRef'
    ? node.type.create({ ...node.attrs, n: ++index })
    : node)
  const doc = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, numbered))
  return EditorState.create({ doc, selection: TextSelection.create(doc, cursor), plugins: [createQuoteRefPlugin(), history()] })
}
function quoteOrder(state: EditorState) {
  const result: Array<{ id: string; n: number }> = []
  state.doc.descendants((node) => {
    if (node.type.name === 'quoteRef') result.push({ id: node.attrs.quote.filePath, n: node.attrs.n })
  })
  return result
}

// 不依赖 DOM：这里验证实际 ProseMirror 事务、编号、撤销和组件事件；原生鼠标拖放另做界面验收。
describe('输入框引用编辑', () => {
  test('Given 引用节点 When 读取 schema Then 支持原生拖动且普通点击不可整颗选中', () => {
    expect(schema.nodes.quoteRef!.spec).toMatchObject({ inline: true, atom: true, draggable: true, selectable: false })
  })

  test('Given 两颗紧邻引用 When 在边界键入中文 Then 保留两条引用并将文字插在中间', () => {
    let state = stateFor([chip('A'), chip('B')], 2)
    state = state.apply(state.tr.insertText('请对比这两处'))
    expect(state.doc.firstChild!.child(1).text).toBe('请对比这两处')
    expect(quoteOrder(state)).toEqual([{ id: '/tmp/A.md', n: 1 }, { id: '/tmp/B.md', n: 2 }])
  })

  test('Given 已编排的正文和引用 When 在中间添加引用 Then 不移动原引用且输入光标在新引用后', () => {
    let state = stateFor([text('前'), chip('A'), text('中'), chip('B'), text('后')], 4)
    const tr = createQuoteRefInsertTransaction(state, quote('C'))
    expect(tr).not.toBeNull()
    state = state.apply(tr!)
    expect(state.doc.firstChild!.child(0).text).toBe('前')
    expect(state.doc.firstChild!.child(2).text).toBe('中')
    expect(quoteOrder(state)).toEqual([{ id: '/tmp/A.md', n: 1 }, { id: '/tmp/C.md', n: 2 }, { id: '/tmp/B.md', n: 3 }])
    expect(state.selection).toBeInstanceOf(TextSelection)
    expect(state.selection.empty).toBe(true)
    expect(state.selection.$from.nodeBefore?.text).toBe(' ')
    state = state.apply(state.tr.insertText('补充'))
    expect(state.doc.textContent).toBe('前中 补充后')
    expect(quoteOrder(state)).toHaveLength(3)
  })

  test('Given 相同来源和原文 When 重复添加 Then 不产生事务也不挪动光标', () => {
    const state = stateFor([text('前'), chip('A'), text('后')], 4)
    expect(createQuoteRefInsertTransaction(state, { ...quote('A'), capturedAt: 99 })).toBeNull()
    expect(state.selection.from).toBe(4)
  })

  test('Given 手动引用和旧划词引用 When 替换自动划词 Then 只删除旧划词且一次撤销恢复', () => {
    let state = stateFor([chip('manual'), text('正文'), chip('old', 'browser-selection'), text('尾')], 6)
    const before = state.doc
    state = state.apply(createQuoteRefInsertTransaction(state, quote('new', 'browser-selection'))!)
    expect(quoteOrder(state)).toEqual([{ id: '/tmp/manual.md', n: 1 }, { id: '/tmp/new.md', n: 2 }])
    expect(state.doc.textContent).toBe('正文尾 ')
    expect(undo(state, (tr) => { state = state.apply(tr) })).toBe(true)
    expect(state.doc.eq(before)).toBe(true)
  })

  test('Given 新插入的引用 When 撤销 Then 一次撤回引用及其间隔而不留下空行', () => {
    let state = stateFor([text('正文')], 2)
    const before = state.doc
    state = state.apply(createQuoteRefInsertTransaction(state, quote('A'))!)
    expect(undo(state, (tr) => { state = state.apply(tr) })).toBe(true)
    expect(state.doc.eq(before)).toBe(true)
  })

  test('Given 内部拖放事务 When 引用换位 Then 按文档顺序重编号且继续键入不会覆盖引用', () => {
    let state = stateFor([chip('A'), chip('B'), text('正文')])
    const moved = state.doc.nodeAt(2)!
    const tr = state.tr.delete(2, 3).insert(1, moved)
    tr.setSelection(TextSelection.create(tr.doc, 1, 2)).setMeta('uiEvent', 'drop')
    state = state.apply(tr)
    expect(quoteOrder(state)).toEqual([{ id: '/tmp/B.md', n: 1 }, { id: '/tmp/A.md', n: 2 }])
    expect(state.selection.empty).toBe(true)
    state = state.apply(state.tr.insertText('继续'))
    expect(quoteOrder(state)).toHaveLength(2)
    expect(state.doc.firstChild!.child(1).text).toBe('继续')
  })

  test('Given 取消的拖动留下节点选区 When dragend Then 恢复引用后的文本光标', () => {
    let state = stateFor([chip('A')])
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 1)))
    const view = { get state() { return state }, dispatch(tr) { state = state.apply(tr) } } satisfies Pick<EditorView, 'state' | 'dispatch'>
    const plugin = createQuoteRefPlugin()
    plugin.props.handleDOMEvents!.dragend!.call(plugin, view as EditorView, new Event('dragend') as DragEvent)
    expect(state.selection).toBeInstanceOf(TextSelection)
    expect(state.selection.from).toBe(2)
    state = state.apply(state.tr.insertText('继续'))
    expect(quoteOrder(state)).toHaveLength(1)
  })

  test('Given 普通文本拖放 When 结束 Then 不干预原文本选区', () => {
    let state = stateFor([text('正文')])
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)).setMeta('uiEvent', 'drop'))
    expect(state.selection.from).toBe(1)
    expect(state.selection.to).toBe(3)
  })
})

describe('引用胶囊鼠标事件', () => {
  async function mountChip(editable = true) {
    const positions: number[] = []
    const focus = mock(() => {})
    const deleteNode = mock(() => {})
    const editor = { isDestroyed: false, isEditable: editable, commands: { setTextSelection: (pos: number) => { positions.push(pos) } }, view: { focus } }
    const props = { node: chip('A'), editor, getPos: () => 5, deleteNode } as unknown as NodeViewProps
    const host = createLoadedHost(() => <QuoteRefChipView {...props} />, new Set(['QuoteRefChipView']))
    await host.settle()
    const wrapper = host.elements().find((element) => element.props.className === 'quote-ref-chip')!
    return { host, wrapper, positions, focus, deleteNode }
  }
  const event = (over: Record<string, unknown> = {}) => ({ button: 0, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, preventDefault: mock(() => {}), stopPropagation: mock(() => {}), ...over })

  test('Given 胶囊两侧边缘 When 鼠标按下 Then 分别将文本光标落在节点前后', async () => {
    const { host, wrapper, positions, focus } = await mountChip()
    try {
      expect(wrapper.props.draggable).toBe(true)
      expect(wrapper.props['data-drag-handle']).toBe('')
      for (const side of ['before', 'after']) {
        const edge = host.elements().find((element) => element.props.className === `quote-ref-chip__edge quote-ref-chip__edge--${side}`)!
        const down = event()
        ;(edge.props.onMouseDown as (event: unknown) => void)(down)
        expect(down.preventDefault).toHaveBeenCalledTimes(1)
        expect(down.stopPropagation).toHaveBeenCalledTimes(1)
      }
      expect(positions).toEqual([5, 6])
      expect(focus).toHaveBeenCalledTimes(2)
    } finally { host.dispose() }
  })

  test('Given 单击胶囊主体 When 按下尚未拖动 Then 不提前阻止原生拖动；click 才按左右半边落光标', async () => {
    const { host, wrapper, positions } = await mountChip()
    try {
      expect(wrapper.props.onMouseDown).toBeUndefined()
      for (const clientX of [110, 190]) {
        ;(wrapper.props.onClick as (event: unknown) => void)(event({ clientX, currentTarget: { getBoundingClientRect: () => ({ left: 100, right: 200 }) } }))
      }
      expect(positions).toEqual([5, 6])
    } finally { host.dispose() }
  })

  test('Given 修饰键或非主键 When 点击边缘 Then 不覆盖浏览器原生选择；移除按钮仍只删除当前引用', async () => {
    const { host, positions, deleteNode } = await mountChip()
    try {
      const edge = host.elements().find((element) => element.props.className === 'quote-ref-chip__edge quote-ref-chip__edge--before')!
      for (const over of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { button: 2 }]) {
        const down = event(over)
        ;(edge.props.onMouseDown as (event: unknown) => void)(down)
        expect(down.preventDefault).not.toHaveBeenCalled()
      }
      expect(positions).toEqual([])
      await host.click('移除这条引用')
      expect(deleteNode).toHaveBeenCalledTimes(1)
      expect(positions).toEqual([])
    } finally { host.dispose() }
  })

  test('Given 只读编辑器 When 点击边缘 Then 不更改选区或聚焦', async () => {
    const { host, wrapper, positions, focus } = await mountChip(false)
    try {
      expect(wrapper.props.draggable).toBe(false)
      expect(wrapper.props['data-drag-handle']).toBeUndefined()
      const edge = host.elements().find((element) => element.props.className === 'quote-ref-chip__edge quote-ref-chip__edge--after')!
      ;(edge.props.onMouseDown as (event: unknown) => void)(event())
      expect(positions).toEqual([])
      expect(focus).not.toHaveBeenCalled()
    } finally { host.dispose() }
  })
})
