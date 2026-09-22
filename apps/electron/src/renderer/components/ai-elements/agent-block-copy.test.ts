import { describe, expect, test } from 'bun:test'
import {
  findAgentSelectionToolbarAnchor,
  markdownToPlainText,
  parseAgentMarkdownBlocks,
  serializeAgentSelection,
  tableMarkdownToTsv,
  toggleAgentBlockSelection,
  selectAgentBlockRange,
} from './agent-block-copy'

describe('agent block copy serialization', () => {
  test('操作条位于当前连续选区右上角外部，表格不再渲染旧操作条或空气墙', async () => {
    const source = await Bun.file(`${import.meta.dir}/message.tsx`).text()
    expect(source).not.toContain('BlockCopyToolbar')
    expect(source).not.toContain('fixed z-50')
    expect(source).not.toContain('pt-8')
    expect(source).not.toContain('-left-14')
    expect(source).toContain('data-agent-toolbar-block-id={toolbarBlock.id}')
    expect(source).toContain('data-agent-toolbar-corridor="true"')
    expect(source).toContain('className="pointer-events-auto absolute -right-1 -top-9 z-20 flex h-9 items-end pb-0.5"')
    expect(source).not.toContain("hasToolbarLane && 'pt-9'")
    expect(source).toContain("const selectionPaddingClassName = selected")
    expect(source).toContain("? cn(selectionGroupStart && 'pt-2', selectionGroupEnd && 'pb-2')")
    expect(source).toContain("selectionGroupStart && 'rounded-t-md border-t-[3px]'")
    expect(source).not.toContain('bottom-full')
    expect(source).not.toContain('absolute right-0 top-0')
    expect(source).not.toContain('group-[.is-selected]/agent-block:opacity-100')
    expect(source).toContain('pointer-events-none absolute -inset-x-1 top-0 z-0 border-x-[3px] border-primary/60 bg-primary/[0.06]')
    expect(source).toContain('border-2 border-dashed border-primary/40 bg-primary/[0.025]')
    expect(source).toContain('previewVisible={!selecting && toolbarExpanded && toolbarBlock?.id === block.id}')
    expect(source).toContain("selectionGroupStart && 'rounded-t-md border-t-[3px]'")
    expect(source).toContain("selectionGroupEnd ? 'bottom-0 rounded-b-md border-b-[3px]' : selectionBridgeAfterClassName")
    expect(source).toContain("selecting && 'select-none'")
    expect(source).not.toContain('group/table')
    expect(source).not.toContain('before:absolute')
    expect(source).not.toContain('absolute -top-8 right-0')
  })

  test('首次跨块点击按文档顺序补选闭区间', () => {
    const blocks = parseAgentMarkdownBlocks('一\n\n二\n\n三\n\n四\n\n五')
    expect([...selectAgentBlockRange(blocks, blocks[4]!.id, blocks[1]!.id)]).toEqual(['1', '2', '3', '4'])
    expect([...selectAgentBlockRange(blocks, blocks[1]!.id, blocks[4]!.id)]).toEqual(['1', '2', '3', '4'])
  })

  test('连续选区中任意 hover 块都将操作条锚定到该组选区首块', async () => {
    const blocks = parseAgentMarkdownBlocks('一\n\n二\n\n三\n\n四')
    const selectedIds = new Set([blocks[0]!.id, blocks[1]!.id, blocks[2]!.id])
    expect(findAgentSelectionToolbarAnchor(blocks, selectedIds, blocks[0]!.id, true)).toBe(0)
    expect(findAgentSelectionToolbarAnchor(blocks, selectedIds, blocks[1]!.id, true)).toBe(0)
    expect(findAgentSelectionToolbarAnchor(blocks, selectedIds, blocks[2]!.id, true)).toBe(0)
    expect(findAgentSelectionToolbarAnchor(blocks, selectedIds, blocks[3]!.id, true)).toBe(3)
    expect(findAgentSelectionToolbarAnchor(blocks, selectedIds, null, true)).toBe(-1)

    const source = await Bun.file(`${import.meta.dir}/message.tsx`).text()
    expect(source).toContain('if (currentAnchor === nextAnchor && currentId !== block.id)')
    expect(source).toContain('}, 180)')
    expect(source).toContain('onMouseEnter={onToolbarEnter}')
    expect(source).toContain('selecting && !selectedIds.has(block.id)')
    expect(source).toContain('{!selecting && <button')
    expect(source).toContain('aria-label="退出多选"')
    expect(source).toContain('selectionFormatMode')
    expect(source).toContain('>Markdown</span>')
    expect(source).not.toContain('复制格式：Markdown')
    expect(source).toContain("hasSelectedMarkdown && hasSelectedTable")
    expect(source).toContain("onClick={onCopy}")
    expect(source).toContain('copied ? <Check')
    expect(source).not.toContain('event.shiftKey && selectionAnchorId')
    expect(source).not.toContain('onPointerMove={(event) =>')
  })

  test('不同 Markdown 块保留各自外部间距，连续框只从前块单侧跨越间距', async () => {
    const source = await Bun.file(`${import.meta.dir}/message.tsx`).text()
    expect(source).toContain('function listBlockSignature')
    expect(source).toContain('listBlockSignature(previous) === listSignature')
    expect(source).toContain("className: cn(joinsPrevious ? 'mt-0' : 'mt-[1.25em]', joinsNext ? 'mb-0' : 'mb-[1.25em]')")
    expect(source).toContain("className: 'my-[1.6em]'")
    expect(source).toContain("className: followsFence ? 'mt-4 mb-0' : 'my-0'")
    expect(source).toContain("className: 'my-3'")
    expect(source).toContain("className: 'my-2'")
    expect(source).toContain("className: 'my-1.5'")
    expect(source).not.toContain("selectedBefore ? '-top-1.5'")
    expect(source).toContain("const selectionPaddingClassName = selected")
    expect(source).toContain("? cn(selectionGroupStart && 'pt-2', selectionGroupEnd && 'pb-2')")
    expect(source).toContain("className={cn('group/agent-block relative transition-[padding,colors] duration-100', marginClassName, selectionPaddingClassName, selected && 'is-selected')}")
    expect(source).toContain("selectionGroupEnd ? 'bottom-0 rounded-b-md border-b-[3px]' : selectionBridgeAfterClassName")
  })

  test('多选支持 Escape 和叉号按钮统一退出', async () => {
    const source = await Bun.file(`${import.meta.dir}/message.tsx`).text()
    expect(source).toContain("if (event.key !== 'Escape') return")
    expect(source).toContain("window.addEventListener('keydown', handleKeyDown, true)")
    expect(source).toContain('toolbarExpanded')
    expect(source).toContain('previewVisible')
    expect(source).toContain('onToolbarLeave={leaveToolbar}')
    expect(source).toContain('scheduleHoverLeave')
    expect(source).toContain('}, 160)')
    expect(source).toContain('clearToolbarLeaveTimer')
    expect(source).toContain('onPointerLeave={() => { clearHoverSwitchTimer(); scheduleHoverLeave() }}')
    expect(source).toContain("window.removeEventListener('keydown', handleKeyDown, true)")
    expect(source).toContain('aria-label="退出多选"')
    expect(source).toContain('title="退出多选 (Esc)"')
    expect(source).toContain('onClick={onExitSelection}')
    expect(source).toContain('setSelection({ selectedIds: new Set(), selecting: false })')
  })

  test('图片和图片占位不会触发多选块切换', async () => {
    const source = await Bun.file(`${import.meta.dir}/message.tsx`).text()
    expect(source).toContain("const AGENT_BLOCK_INTERACTION_SELECTOR = 'a,button,input,textarea,select,img,[role=\"button\"],[role=\"img\"]'")
    expect(source).toContain('closest(AGENT_BLOCK_INTERACTION_SELECTOR)')
    expect(source).toContain('img: MarkdownImage')
    expect(source).toContain('<span role="img" aria-label={alt} />')
  })

  test('普通格式是共享状态，表格格式仅由当前表格操作条切换', async () => {
    const source = await Bun.file(`${import.meta.dir}/message.tsx`).text()
    expect(source).toContain("const [markdownFormat, setMarkdownFormat] = React.useState<'markdown' | 'plainText'>('markdown')")
    expect(source).toContain('onMarkdownFormatChange={setMarkdownFormat}')
    expect(source).toContain('block.kind === \'table\'')
    expect(source).toContain('const [tableFormats, setTableFormats] = React.useState')
    expect(source).toContain('tableFormats.get(block.id)')
    expect(source).toContain('tableFormatFor(block)')
    expect(source).toContain('onTableFormatChange={(format) => updateTableFormat(toolbarTarget.id, format)}')
  })

  test('流式回答继续走 Markdown 渲染，展开思考允许外部操作条溢出', async () => {
    const source = await Bun.file(`${import.meta.dir}/message.tsx`).text()
    const contentBlockSource = await Bun.file(`${import.meta.dir}/../agent/ContentBlock.tsx`).text()
    expect(source).not.toContain("if (streaming) return <div className={cn(containerClassName, 'whitespace-pre-wrap break-words')}>{processed}</div>")
    expect(source).toContain('<Markdown remarkPlugins={plugins} rehypePlugins={REHYPE_PLUGINS}')
    expect(contentBlockSource).toContain("shouldCollapse && !isExpanded && 'max-h-[5.6em]'")
  })

  test('按块级节点切分，代码块和表格不按视觉行拆分', () => {
    const blocks = parseAgentMarkdownBlocks('第一段很长\n仍是第一段\n\n## 标题\n\n```ts\nconst value = 1\nconsole.log(value)\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(blocks.map((block) => block.kind)).toEqual(['markdown', 'markdown', 'markdown', 'table'])
    expect(blocks[0]?.source).toBe('第一段很长\n仍是第一段')
    expect(blocks[2]?.source).toContain('console.log(value)')
  })

  test('普通段落的换行保持在同一块内', () => {
    const blocks = parseAgentMarkdownBlocks('第一行换行文本\n第二行仍属于同一段\n\n下一段')
    expect(blocks.map((block) => block.source)).toEqual(['第一行换行文本\n第二行仍属于同一段', '下一段'])
  })

  test('同级列表项独立成块，嵌套列表保留在对应父项中', () => {
    const blocks = parseAgentMarkdownBlocks('- parent\n  - child\n  - child2\n- sibling\n\nnext')
    expect(blocks.map((block) => block.source)).toEqual([
      '- parent\n  - child\n  - child2',
      '- sibling',
      'next',
    ])
  })

  test('Setext 标题与下划线保持为一个块', () => {
    expect(parseAgentMarkdownBlocks('Title\n===\n\nSubtitle\n---\n\nnext').map((block) => block.source)).toEqual([
      'Title\n===',
      'Subtitle\n---',
      'next',
    ])
  })

  test('空的无序和有序列表项也各自成为块，未缩进正文不并入空项', () => {
    expect(parseAgentMarkdownBlocks('-\n* item\n+\n\nnext').map((block) => block.source)).toEqual([
      '-',
      '* item',
      '+',
      'next',
    ])
    expect(parseAgentMarkdownBlocks('1.\n2) item\n3.\n\nnext').map((block) => block.source)).toEqual([
      '1.',
      '2) item',
      '3.',
      'next',
    ])
    expect(parseAgentMarkdownBlocks('-\nparagraph').map((block) => block.source)).toEqual(['-', 'paragraph'])
    expect(parseAgentMarkdownBlocks('-\n paragraph').map((block) => block.source)).toEqual(['-', ' paragraph'])
    expect(parseAgentMarkdownBlocks('-\n  paragraph').map((block) => block.source)).toEqual(['-\n  paragraph'])
    expect(parseAgentMarkdownBlocks('1.\n  paragraph').map((block) => block.source)).toEqual(['1.', '  paragraph'])
    expect(parseAgentMarkdownBlocks('1.\n   paragraph').map((block) => block.source)).toEqual(['1.\n   paragraph'])
  })

  test('连续引用保持为一个块', () => {
    const blocks = parseAgentMarkdownBlocks('> line one\n> line two\n\n> line three\n\nnext')
    expect(blocks.map((block) => block.source)).toEqual(['> line one\n> line two\n\n> line three', 'next'])
  })

  test('代码围栏要求 closer 使用相同字符且长度不少于 opener', () => {
    const backtick = parseAgentMarkdownBlocks('```ts\nconst value = 1\n```')
    const tilde = parseAgentMarkdownBlocks('~~~js\nconst value = 1\n~~~')
    expect(backtick).toHaveLength(1)
    expect(backtick[0]?.source).toBe('```ts\nconst value = 1\n```')
    expect(tilde).toHaveLength(1)
    expect(tilde[0]?.source).toBe('~~~js\nconst value = 1\n~~~')
  })

  test('错配和不同长度 closer 不会拆开围栏内容', () => {
    const mismatched = parseAgentMarkdownBlocks('```ts\n~~~\ninside\n```\nafter')
    expect(mismatched).toHaveLength(2)
    expect(mismatched[0]?.source).toBe('```ts\n~~~\ninside\n```')
    expect(mismatched[1]?.source).toBe('after')

    const shorter = parseAgentMarkdownBlocks('````ts\ninside\n```\nstill code\n````\n\nafter')
    expect(shorter.map((block) => block.source)).toEqual(['````ts\ninside\n```\nstill code\n````', 'after'])
  })

  test('未闭合围栏将剩余内容保留在同一代码块', () => {
    const blocks = parseAgentMarkdownBlocks('~~~js\nconst value = 1\n普通段落')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.source).toBe('~~~js\nconst value = 1\n普通段落')
  })

  test('取消最后一个块后自动退出多选', () => {
    const update = toggleAgentBlockSelection(new Set(['block-1']), 'block-1')
    expect(update.selectedIds.size).toBe(0)
    expect(update.selecting).toBe(false)
  })

  test('普通块支持 Markdown 与纯文本', () => {
    const blocks = parseAgentMarkdownBlocks('# 标题\n\n[链接](https://example.com) **重点**')
    expect(markdownToPlainText(blocks[0]!.source)).toBe('标题')
    expect(markdownToPlainText(blocks[1]!.source)).toBe('链接 重点')
  })

  test('纯文本复制移除反引号和波浪号 fence 的语言标识', () => {
    expect(markdownToPlainText('~~~ts\nconst x = 1\n~~~')).toBe('const x = 1')
    expect(markdownToPlainText('```ts\nconst x = 1\n```')).toBe('const x = 1')
    expect(markdownToPlainText('~~~ts\nconst x = 1')).toBe('const x = 1')
    expect(markdownToPlainText('~~~ts\nconst x = 1\n```\nafter')).toBe('const x = 1\nafter')
  })

  test('纯文本复制保留普通文本中的 pipe', () => {
    expect(markdownToPlainText('状态 A | B 与 `x | y`')).toBe('状态 A | B 与 x | y')
  })

  test('纯文本复制保留多行普通文本中的 pipe', () => {
    expect(markdownToPlainText('第一行 | 左右\n第二行包含 | 管道')).toBe('第一行 | 左右\n第二行包含 | 管道')
  })

  test('表格支持 Markdown 与 TSV', () => {
    const source = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    expect(tableMarkdownToTsv(source)).toBe('A\tB\n1\t2')
  })

  test('表格 TSV 将 escaped pipe 保留为单元格内容并移除转义反斜杠', () => {
    const source = '| Name | Description |\n| --- | --- |\n| A \\| B | C \\| D |'
    expect(tableMarkdownToTsv(source)).toBe('Name\tDescription\nA | B\tC | D')
  })

  test('表格 TSV 保留普通分隔管道和 escaped backslash 语义', () => {
    const source = 'A \\\\| B | C\n--- | ---\nD | E'
    expect(tableMarkdownToTsv(source)).toBe(['A \\\\', 'B', 'C'].join('\t') + '\nD\tE')
  })

  test('表格 TSV 正确处理行首行尾边界管道', () => {
    expect(tableMarkdownToTsv(' | A | B | \n| --- | --- |\n| 1 | 2 | ')).toBe('A\tB\n1\t2')
    expect(tableMarkdownToTsv('A | B')).toBe('A\tB')
  })

  test('混合选择保持原始顺序并以空行连接', () => {
    const blocks = parseAgentMarkdownBlocks('普通块\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n末尾块')
    expect(serializeAgentSelection({
      blocks: [blocks[2]!, blocks[0]!, blocks[1]!],
      markdownFormat: 'plainText',
      tableFormat: 'tsv',
    })).toBe('末尾块\n\n普通块\n\nA\tB\n1\t2')
  })
})
