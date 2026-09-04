/**
 * 团队资料库组件准入 PoC。
 *
 * 仅在开发环境通过 ?poc=team-workspace 访问，不接入真实团队文件、IPC 或团队工作台。
 * 用于验证候选组件与现有 Radix Sheet、Tailwind 和 Electron 渲染层是否能稳定共存。
 */
import * as React from 'react'
import { flexRender, getCoreRowModel, getSortedRowModel, type ColumnDef, type SortingState, useReactTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Tree, type NodeApi } from 'react-arborist'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

type ResourceStatus = '收件箱' | '进行中' | '待审阅' | '已完成' | '已归档'

interface DemoResource {
  id: string
  name: string
  kind: 'file' | 'folder'
  status: ResourceStatus
  owner: string
  updatedAt: string
  tags: string[]
}

interface DemoTreeNode {
  id: string
  name: string
  children?: DemoTreeNode[]
}

const statuses: ResourceStatus[] = ['收件箱', '进行中', '待审阅', '已完成', '已归档']
const owners = ['原来如此', '林墨', '周宁', '陈晓']

function buildResources(count: number): DemoResource[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `resource-${index + 1}`,
    name: `${index % 19 === 0 ? '产品资料' : '团队文档'}-${String(index + 1).padStart(5, '0')}.${index % 3 === 0 ? 'md' : 'pdf'}`,
    kind: index % 19 === 0 ? 'folder' : 'file',
    status: statuses[index % statuses.length]!,
    owner: owners[index % owners.length]!,
    updatedAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}`,
    tags: index % 2 === 0 ? ['产品', '规划'] : ['研发'],
  }))
}

function buildTree(): DemoTreeNode[] {
  const groups: DemoTreeNode[] = Array.from({ length: 100 }, (_, groupIndex) => ({
    id: `group-${groupIndex}`,
    name: `资料专题 ${String(groupIndex + 1).padStart(3, '0')}`,
    children: Array.from({ length: 50 }, (_, itemIndex) => ({
      id: `group-${groupIndex}-item-${itemIndex}`,
      name: `资料项 ${String(itemIndex + 1).padStart(2, '0')}`,
    })),
  }))

  let branch: DemoTreeNode = { id: 'deep-10', name: '第 10 层目录' }
  for (let level = 9; level >= 1; level--) {
    branch = { id: `deep-${level}`, name: `第 ${level} 层目录`, children: [branch] }
  }
  groups.unshift(branch)
  return groups
}

const demoResources = buildResources(10_000)
const demoTree = buildTree()

const columns: ColumnDef<DemoResource>[] = [
  {
    accessorKey: 'name',
    header: '名称',
    cell: ({ row }) => <span className="truncate font-medium">{row.original.kind === 'folder' ? '📁 ' : '📄 '}{row.original.name}</span>,
  },
  { accessorKey: 'status', header: '状态' },
  { accessorKey: 'owner', header: '负责人' },
  { accessorKey: 'tags', header: '标签', cell: ({ row }) => row.original.tags.join(' / ') },
  { accessorKey: 'updatedAt', header: '更新时间' },
]

function TreeRow({ node, style, dragHandle }: { node: NodeApi<DemoTreeNode>; style: React.CSSProperties; dragHandle?: (el: HTMLDivElement | null) => void }): React.ReactElement {
  return (
    <div
      ref={dragHandle}
      style={style}
      className={cn(
        'flex h-8 items-center gap-1 rounded px-2 text-sm hover:bg-accent/70',
        node.isSelected && 'bg-primary/15 text-primary',
      )}
      onClick={() => node.select()}
    >
      {node.isInternal ? (
        <button className="w-4 text-left text-muted-foreground" onClick={(event) => { event.stopPropagation(); node.toggle() }}>
          {node.isOpen ? '⌄' : '›'}
        </button>
      ) : <span className="w-4" />}
      <span className="truncate">{node.isInternal ? '📁' : '📄'} {node.data.name}</span>
    </div>
  )
}

export function TeamWorkspaceComponentsPoc(): React.ReactElement {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [selected, setSelected] = React.useState<DemoResource | null>(null)
  const [treeAction, setTreeAction] = React.useState('树内移动尚未触发')
  const tableContainerRef = React.useRef<HTMLDivElement>(null)

  const table = useReactTable({
    data: demoResources,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })
  const rows = table.getRowModel().rows
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 38,
    overscan: 12,
  })

  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border/70 px-6 py-4">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">开发环境隔离验证</p>
        <h1 className="mt-1 text-xl font-semibold">团队资料库组件准入 PoC</h1>
        <p className="mt-1 text-sm text-muted-foreground">10,000 条资料表格 + 5,000+ 节点目录树；不读取真实团队数据，也不调用 IPC。</p>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-4 p-4">
        <section className="flex min-h-0 flex-col rounded-xl bg-card p-3 shadow-sm ring-1 ring-border/50">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-medium">资料目录</h2>
            <span className="text-xs text-muted-foreground">react-arborist</span>
          </div>
          <Tree<DemoTreeNode>
            data={demoTree}
            width="100%"
            height={Math.max(260, window.innerHeight - 180)}
            indent={18}
            rowHeight={32}
            overscanCount={8}
            openByDefault={false}
            idAccessor="id"
            childrenAccessor="children"
            onMove={({ dragNodes, parentNode }) => {
              // PoC 故意不修改 data：模拟服务端拒绝后由受控数据源回滚。
              const targetName = parentNode?.data.name ?? '根目录'
              setTreeAction(`已模拟拒绝移动 ${dragNodes.length} 项到「${targetName}」，树保持服务端原状。`)
            }}
          >
            {TreeRow}
          </Tree>
          <p className="mt-2 rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">{treeAction}</p>
        </section>

        <section className="flex min-h-0 flex-col rounded-xl bg-card shadow-sm ring-1 ring-border/50">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
            <div>
              <h2 className="font-medium">全部资料</h2>
              <p className="text-xs text-muted-foreground">TanStack Table + Virtual · {rows.length.toLocaleString()} 条</p>
            </div>
            <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">点击资料查看详情</span>
          </div>
          <div className="grid grid-cols-[minmax(240px,1fr)_120px_100px_120px_120px] border-b border-border/70 bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
            {table.getFlatHeaders().map((header) => (
              <button
                key={header.id}
                className="truncate text-left hover:text-foreground"
                onClick={header.column.getToggleSortingHandler()}
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
                {{ asc: ' ↑', desc: ' ↓' }[header.column.getIsSorted() as string] ?? ''}
              </button>
            ))}
          </div>
          <div ref={tableContainerRef} className="min-h-0 flex-1 overflow-auto">
            <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index]
                if (!row) return null
                return (
                  <button
                    key={row.id}
                    className="absolute left-0 grid w-full grid-cols-[minmax(240px,1fr)_120px_100px_120px_120px] items-center border-b border-border/40 px-4 text-left text-sm hover:bg-accent/60"
                    style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` }}
                    onClick={() => setSelected(row.original)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <span key={cell.id} className="truncate pr-2">{flexRender(cell.column.columnDef.cell, cell.getContext())}</span>
                    ))}
                  </button>
                )
              })}
            </div>
          </div>
        </section>
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null) }}>
        <SheetContent side="right" className="w-[420px] sm:max-w-[420px]">
          <SheetHeader>
            <SheetTitle>{selected?.name ?? '资料详情'}</SheetTitle>
            <SheetDescription>复用现有 Radix Sheet。此处仅验证焦点、Esc 与虚拟列表共存。</SheetDescription>
          </SheetHeader>
          {selected && (
            <dl className="mt-6 grid grid-cols-[80px_1fr] gap-y-3 text-sm">
              <dt className="text-muted-foreground">类型</dt><dd>{selected.kind === 'folder' ? '文件夹' : '文件'}</dd>
              <dt className="text-muted-foreground">状态</dt><dd>{selected.status}</dd>
              <dt className="text-muted-foreground">负责人</dt><dd>{selected.owner}</dd>
              <dt className="text-muted-foreground">标签</dt><dd>{selected.tags.join('、')}</dd>
              <dt className="text-muted-foreground">更新时间</dt><dd>{selected.updatedAt}</dd>
            </dl>
          )}
        </SheetContent>
      </Sheet>
    </main>
  )
}
