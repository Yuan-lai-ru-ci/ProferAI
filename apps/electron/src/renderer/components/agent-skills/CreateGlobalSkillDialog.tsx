import * as React from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

export function CreateGlobalSkillDialog({ open, onOpenChange, onCreated }: Props): React.ReactElement {
  const [slug, setSlug] = React.useState('')
  const [name, setName] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [content, setContent] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (open) { setSlug(''); setName(''); setDescription(''); setContent(''); setSaving(false) }
  }, [open])

  const create = async (): Promise<void> => {
    if (!slug.trim() || !name.trim()) { toast.error('请填写 Skill 名称和 slug'); return }
    setSaving(true)
    try {
      await window.electronAPI.globalSkill.createUser(slug, name, description, content)
      toast.success(`已创建全局 Skill：${name}`)
      onCreated()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建全局 Skill 失败')
    } finally { setSaving(false) }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-thin sm:max-w-[680px]">
      <DialogHeader><DialogTitle>新建全局 Skill</DialogTitle><DialogDescription>创建后保存为用户全局 Skill；工作区生效范围可在详情页单独添加。</DialogDescription></DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3"><label className="flex flex-col gap-1.5 text-xs font-medium">名称 *<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="如：代码审查" /></label><label className="flex flex-col gap-1.5 text-xs font-medium">slug *<Input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="如：code-review" /></label></div>
        <label className="flex flex-col gap-1.5 text-xs font-medium">描述<Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="一句话说明这个 Skill" /></label>
        <label className="flex flex-col gap-1.5 text-xs font-medium">SKILL.md 内容<Textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="# 代码审查\n\n在这里填写 Skill 使用说明……" className="min-h-[320px] font-mono text-sm" /></label>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button><Button onClick={() => void create()} disabled={saving}><Plus size={14} className="mr-1" />{saving ? '创建中…' : '创建全局 Skill'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}
