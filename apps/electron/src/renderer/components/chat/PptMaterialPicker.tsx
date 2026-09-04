import * as React from 'react'
import { ImagePlus, LoaderCircle, Search } from 'lucide-react'
import type { PptMaterialItem } from '@profer/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

interface PptMaterialPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (material: PptMaterialItem) => Promise<void>
}

export function PptMaterialPicker({ open, onOpenChange, onSelect }: PptMaterialPickerProps): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [items, setItems] = React.useState<PptMaterialItem[]>([])
  const [loading, setLoading] = React.useState(false)
  const [selectingId, setSelectingId] = React.useState<string | null>(null)
  const [includeAttribution, setIncludeAttribution] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const search = React.useCallback(async (): Promise<void> => {
    if (!query.trim()) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.pptMaterials.search({ query, includeAttribution })
      setItems(result.items)
      if (result.items.length === 0) setError('没有符合当前许可筛选条件的图片。可尝试英文关键词或允许署名素材。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '素材搜索失败')
    } finally {
      setLoading(false)
    }
  }, [query, includeAttribution])

  const select = async (item: PptMaterialItem): Promise<void> => {
    setSelectingId(item.id)
    try {
      await onSelect(item)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '素材下载失败')
    } finally {
      setSelectingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-base"><ImagePlus className="size-4" />开放许可素材</DialogTitle>
        </DialogHeader>
        <div className="px-5 pt-4 flex items-center gap-2">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search() }} placeholder="搜索与 PPT 主题匹配的真实图片，建议使用英文关键词" />
          <Button type="button" size="icon" onClick={() => void search()} disabled={loading || !query.trim()} aria-label="搜索素材">
            {loading ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
          </Button>
        </div>
        <label className="mx-5 mt-3 flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
          <Switch checked={includeAttribution} onCheckedChange={setIncludeAttribution} className="scale-75" />
          包含 CC BY 素材（使用时需署名）；默认仅显示公有领域和 CC0
        </label>
        <div className="p-5 pt-3 min-h-[350px] max-h-[60vh] overflow-y-auto">
          {error && <p className="py-12 text-center text-sm text-muted-foreground">{error}</p>}
          {!error && !loading && items.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">搜索开放许可图片后，选择一张作为当前对话附件。</p>}
          {items.length > 0 && <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {items.map((item) => <button key={`${item.source}-${item.id}`} type="button" onClick={() => void select(item)} disabled={selectingId !== null} className="group text-left overflow-hidden rounded-md border bg-muted/20 hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60">
              <div className="aspect-[4/3] overflow-hidden bg-muted"><img src={item.thumbnailUrl} alt="" className="size-full object-cover transition-transform group-hover:scale-[1.03]" /></div>
              <div className="p-2"><p className="truncate text-xs font-medium">{item.title}</p><p className="mt-1 truncate text-[10px] text-muted-foreground">{selectingId === item.id ? '下载中...' : `${item.licenseCode}${item.creator ? ` · ${item.creator}` : ''}`}</p></div>
            </button>)}
          </div>}
        </div>
        <p className="px-5 py-3 border-t text-[10px] text-muted-foreground">来自 Wikimedia Commons。开放许可不覆盖商标、肖像或隐私权；请按来源页的许可与署名要求使用。</p>
      </DialogContent>
    </Dialog>
  )
}
