import * as React from 'react'
import { BookOpen, Check, Copy, FolderOpen, PackagePlus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsSection, SettingsCard } from './primitives'
import type { SkinInfo, ThemeMode, ThemeStyle } from '../../../types'

const MANIFEST_TEMPLATE = `{
  "id": "my-skin",
  "name": "我的皮肤",
  "tone": "dark",
  "version": "1.0.0",
  "author": "你的名字"
}`
const CSS_TEMPLATE = `:root {
  --background: 222 25% 13%;
  --foreground: 215 28% 92%;
  --content-area: 222 30% 9%;
  --primary: 212 85% 61%;
  --border: 220 18% 25%;
}

/* 图片放在 assets/background.webp 后可使用：
body { background-image: url("assets/background.webp"); }
*/`

export function SkinManager({ skins, themeMode, themeStyle, busy, onSelect, onImport, onRefresh, onOpenFolder, onDelete }: {
  skins: SkinInfo[]; themeMode: ThemeMode; themeStyle: ThemeStyle; busy: boolean
  onSelect: (id: ThemeStyle) => void; onImport: (kind: 'zip' | 'folder') => Promise<void>; onRefresh: () => Promise<void>; onOpenFolder: () => void; onDelete: (skin: SkinInfo) => void
}): React.ReactElement {
  const [guideOpen, setGuideOpen] = React.useState(false)
  const builtin = skins.filter((skin) => skin.builtin)
  const user = skins.filter((skin) => !skin.builtin)
  return <><SettingsSection title="皮肤管理器" description="导入 ZIP 或文件夹皮肤；用户皮肤存放在本机，不会同步到云端。" action={<div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setGuideOpen(true)}><BookOpen size={14} />制作指南</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void onImport('zip')}><PackagePlus size={14} />导入 ZIP</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void onImport('folder')}><FolderOpen size={14} />导入文件夹</Button><Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => void onRefresh()} title="刷新皮肤库"><RefreshCw size={15} /></Button></div>}>
    <div className="space-y-4"><SkinGroup title="内置皮肤" skins={builtin} themeMode={themeMode} themeStyle={themeStyle} onSelect={onSelect} /><SkinGroup title="我的皮肤" skins={user} themeMode={themeMode} themeStyle={themeStyle} onSelect={onSelect} onDelete={onDelete} empty={<div className="py-8 text-center text-sm text-muted-foreground">尚未导入皮肤。可导入 ZIP，或直接选择一个皮肤文件夹。</div>} /><Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onOpenFolder}><FolderOpen size={14} />打开皮肤目录</Button></div>
  </SettingsSection><SkinAuthoringGuide open={guideOpen} onOpenChange={setGuideOpen} /></>
}
function SkinGroup({ title, skins, themeMode, themeStyle, onSelect, onDelete, empty }: { title: string; skins: SkinInfo[]; themeMode: ThemeMode; themeStyle: ThemeStyle; onSelect: (id: ThemeStyle) => void; onDelete?: (skin: SkinInfo) => void; empty?: React.ReactNode }): React.ReactElement {
  return <SettingsCard divided={false}><div className="px-4 pt-3 text-sm font-medium">{title}</div>{skins.length === 0 ? empty : <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">{skins.map((skin) => { const active = themeMode === 'special' && themeStyle === skin.id; return <button key={skin.id} onClick={() => onSelect(skin.id)} className={`relative rounded-lg overflow-hidden border text-left transition-colors ${active ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/50'}`}><SkinPreview skin={skin} /><div className="p-2"><div className="flex gap-1 items-center text-xs font-medium truncate">{skin.name}{active && <Check size={13} className="text-primary shrink-0" />}</div><div className="text-[11px] text-muted-foreground truncate">{skin.author || (skin.builtin ? 'Profer 内置' : '本地皮肤')} · {skin.tone === 'dark' ? '深色' : '浅色'}</div></div>{onDelete && <button type="button" title="删除皮肤" aria-label={`删除皮肤 ${skin.name}`} onClick={(event) => { event.stopPropagation(); onDelete(skin) }} className="absolute top-1 right-1 p-1 rounded bg-background/80 text-muted-foreground hover:text-destructive"><Trash2 size={13} /></button>}</button> })}</div>}</SettingsCard>
}
function SkinPreview({ skin }: { skin: SkinInfo }): React.ReactElement { const [src, setSrc] = React.useState<string | null>(null); React.useEffect(() => { let cancelled = false; window.electronAPI.getSkinPreview(skin.id).then((value) => { if (!cancelled) setSrc(value) }).catch(() => {}); return () => { cancelled = true } }, [skin]); return <div className={`h-20 ${skin.tone === 'dark' ? 'bg-gradient-to-br from-slate-900 to-slate-700' : 'bg-gradient-to-br from-slate-100 to-slate-300'} overflow-hidden`}>{src && <img src={src} className="w-full h-full object-cover" style={{ transform: `scale(${skin.previewScale ?? 1})`, objectPosition: skin.previewPosition }} />}</div> }
function CopyTemplate({ label, value }: { label: string; value: string }): React.ReactElement { return <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(value).then(() => toast.success(`${label} 已复制`)).catch(() => toast.error('复制失败，请手动复制'))}><Copy size={14} />复制 {label}</Button> }
function SkinAuthoringGuide({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): React.ReactElement { return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>制作 Profer 皮肤</DialogTitle><DialogDescription>创建文件夹，按模板填写文件后压缩为 ZIP；ZIP 根目录或单层包装目录均可导入。</DialogDescription></DialogHeader><div className="space-y-5 text-sm"><section><h3 className="font-medium mb-2">目录结构</h3><pre className="rounded-md bg-muted p-3 overflow-auto">{`my-skin/\n├── manifest.json\n├── skin.css\n├── preview.webp       # 可选，推荐\n└── assets/            # 可选，本地背景图片\n    └── background.webp`}</pre></section><section><h3 className="font-medium mb-2">1. manifest.json</h3><p className="text-muted-foreground mb-2">id 必须为 kebab-case，tone 只能是 light 或 dark。</p><CopyTemplate label="manifest.json" value={MANIFEST_TEMPLATE} /></section><section><h3 className="font-medium mb-2">2. skin.css</h3><p className="text-muted-foreground mb-2">主要修改 <code>:root</code> 中的 HSL 颜色 token。可使用渐变，也可引用包内 <code>assets/</code> 图片。</p><CopyTemplate label="skin.css" value={CSS_TEMPLATE} /></section><section><h3 className="font-medium mb-2">图片背景与安全规则</h3><ul className="list-disc pl-5 space-y-1 text-muted-foreground"><li>图片只放在 <code>assets/</code>，支持 png、jpg、jpeg、webp、svg，单张不超过 2 MB。</li><li>CSS 使用 <code>url("assets/background.webp")</code>；应用会安全转换为本地 data URL。</li><li>禁止外链、<code>file:</code>、<code>data:</code>、<code>@import</code>、<code>@font-face</code> 和 <code>../</code> 路径。</li><li>完整皮肤包最多 5 MB，skin.css 最多 512 KB。</li></ul></section><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void window.electronAPI.openSkinTemplateFolder()}><FolderOpen size={14} />打开官方模板目录</Button><Button onClick={() => void navigator.clipboard.writeText(`${MANIFEST_TEMPLATE}\n\n${CSS_TEMPLATE}`).then(() => toast.success('完整模板已复制')).catch(() => toast.error('复制失败，请手动复制'))}><Copy size={14} />复制完整模板</Button></div></div></DialogContent></Dialog> }
