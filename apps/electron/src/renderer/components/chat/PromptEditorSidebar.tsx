/**
 * PromptEditorSidebar - 提示词编辑侧栏
 *
 * 在 ChatView 右侧展开，支持切换/编辑/新建/保存提示词。
 * CRUD 逻辑复用 PromptSettings 的模式。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Plus, Trash2, Star, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogHeader, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@profer/ui/primitives/alert-dialog'
import { Input } from '@profer/ui/primitives/input'
import { Textarea } from '@profer/ui/primitives/textarea'
import { Separator } from '@profer/ui/primitives/separator'
import { Switch } from '@profer/ui/primitives/switch'
import { ScrollArea } from '@profer/ui/primitives/scroll-area'
import { cn } from '@/lib/utils'
import {
  promptConfigAtom,
  selectedPromptIdAtom,
  defaultPromptIdAtom,
  promptSidebarOpenAtom,
} from '@/atoms/system-prompt-atoms'
import { promptDeletingIdsAtom, promptSaveStateAtom, useSystemPromptAutosave } from '@/hooks/useSystemPromptAutosave'
import type { SystemPrompt, SystemPromptCreateInput, SystemPromptUpdateInput } from '@profer/shared'

export function PromptEditorSidebar(): React.ReactElement {
  const [config, setConfig] = useAtom(promptConfigAtom)
  const [selectedId, setSelectedId] = useAtom(selectedPromptIdAtom)
  const defaultPromptId = useAtomValue(defaultPromptIdAtom)
  const setPromptSidebarOpen = useSetAtom(promptSidebarOpenAtom)

  const saveState = useAtomValue(promptSaveStateAtom)
  const deletingIds = useAtomValue(promptDeletingIdsAtom)
  const debounceSave = useSystemPromptAutosave()
  const [editName, setEditName] = React.useState('')
  const [editContent, setEditContent] = React.useState('')
  const [hoveredId, setHoveredId] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const nameId = React.useId()
  const contentId = React.useId()

  const selectedPrompt = React.useMemo(
    () => config.prompts.find((p) => p.id === selectedId),
    [config.prompts, selectedId]
  )

  /** 选中提示词变化时，同步编辑字段 */
  React.useEffect(() => {
    if (selectedPrompt) {
      setEditName(selectedPrompt.name)
      setEditContent(selectedPrompt.content)
    }
  }, [selectedPrompt])

  /** 新建提示词 */
  const handleCreate = async (): Promise<void> => {
    const input: SystemPromptCreateInput = {
      name: '新提示词',
      content: '',
    }
    try {
      const created = await window.electronAPI.createSystemPrompt(input)
      setConfig((prev) => ({
        ...prev,
        prompts: [...prev.prompts, created],
      }))
      setSelectedId(created.id)
    } catch (error) {
      console.error('[提示词侧栏] 创建失败:', error)
      toast.error('创建提示词失败，请重试')
    }
  }

  /** 删除提示词 */
  const handleDelete = async (id: string): Promise<void> => {
    if (deleting) return
    setDeleting(true)
    try {
      await debounceSave.remove(id)
      setDeleteTarget(null)
    } catch (error) {
      console.error('[提示词侧栏] 删除失败:', error)
      toast.error('删除前保存或删除失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  /** 设为默认提示词 */
  const handleSetDefault = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.setDefaultPrompt(id)
      setConfig((prev) => ({ ...prev, defaultPromptId: id }))
    } catch (error) {
      console.error('[提示词侧栏] 设置默认失败:', error)
      toast.error('设置默认提示词失败，请重试')
    }
  }

  /**
   * 防抖自动保存：同一提示词的字段变更合并提交，切换提示词互不覆盖，卸载时自动 flush。
   * 详见 useSystemPromptAutosave。
   */

  /** 名称变更 */
  const handleNameChange = (value: string): void => {
    setEditName(value)
    if (selectedPrompt && !selectedPrompt.isBuiltin) {
      debounceSave(selectedPrompt.id, { name: value })
    }
  }

  /** 内容变更 */
  const handleContentChange = (value: string): void => {
    setEditContent(value)
    if (selectedPrompt && !selectedPrompt.isBuiltin) {
      debounceSave(selectedPrompt.id, { content: value })
    }
  }

  /** 更新追加设置 */
  const handleAppendChange = async (enabled: boolean): Promise<void> => {
    try {
      await window.electronAPI.updateAppendSetting(enabled)
      setConfig((prev) => ({ ...prev, appendDateTimeAndUserName: enabled }))
    } catch (error) {
      console.error('[提示词侧栏] 更新追加设置失败:', error)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 头部 */}
      <div className="flex items-center justify-between h-12 px-3 border-b shrink-0">
        <span className="text-sm font-medium">提示词</span>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCreate} title="新建提示词">
            <Plus className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPromptSidebarOpen(false)} title="关闭">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
        <span>{saveState === 'error' ? '保存失败，草稿已保留' : saveState === 'saved' ? '已保存' : '等待保存'}</span>
        {saveState === 'error' && <Button type="button" size="sm" variant="outline" onClick={() => { void debounceSave.flush().catch(() => {}) }}>重试保存</Button>}
      </div>
      {/* 提示词列表 */}
      <ScrollArea className="max-h-[200px] shrink-0">
        <div className="py-1">
          {config.prompts.map((prompt) => (
            <SidebarPromptItem
              key={prompt.id}
              prompt={prompt}
              isSelected={prompt.id === selectedId}
              isDefault={prompt.id === defaultPromptId}
              isHovered={prompt.id === hoveredId}
              onSelect={(id) => setSelectedId(id)}
              onDelete={setDeleteTarget}
              onSetDefault={handleSetDefault}
              onHoverChange={setHoveredId}
            />
          ))}
        </div>
      </ScrollArea>

      <Separator />

      {/* 编辑区 */}
      {selectedPrompt && (
        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto p-3 gap-3">
          <div>
            <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground mb-1.5 block">名称</label>
            <Input
              id={nameId}
              value={editName}
              onChange={(e) => handleNameChange(e.target.value)}
              readOnly={selectedPrompt.isBuiltin || deleting || deletingIds.includes(selectedPrompt.id)}
              className={cn('h-8 text-sm', selectedPrompt.isBuiltin && 'opacity-60 cursor-not-allowed')}
              maxLength={50}
            />
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <label htmlFor={contentId} className="text-xs font-medium text-muted-foreground mb-1.5 block">内容</label>
            <Textarea
              id={contentId}
              value={editContent}
              onChange={(e) => handleContentChange(e.target.value)}
              readOnly={selectedPrompt.isBuiltin || deleting || deletingIds.includes(selectedPrompt.id)}
              className={cn(
                'flex-1 min-h-[120px] resize-none text-sm',
                selectedPrompt.isBuiltin && 'opacity-60 cursor-not-allowed'
              )}
              placeholder="输入系统提示词内容..."
            />
          </div>
        </div>
      )}

      {/* 底部追加设置 */}
      <div className="border-t px-3 py-2.5 shrink-0">
        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-xs text-muted-foreground">追加日期时间和用户名</span>
          <Switch
            checked={config.appendDateTimeAndUserName}
            onCheckedChange={handleAppendChange}
          />
        </label>
      </div>
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除提示词？</AlertDialogTitle>
            <AlertDialogDescription>此操作无法撤销；默认提示词删除后将恢复为内置默认。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={deleting} onClick={(event) => { event.preventDefault(); if (deleteTarget) void handleDelete(deleteTarget) }}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 侧栏提示词列表项 */
interface SidebarPromptItemProps {
  prompt: SystemPrompt
  isSelected: boolean
  isDefault: boolean
  isHovered: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onSetDefault: (id: string) => void
  onHoverChange: (id: string | null) => void
}

function SidebarPromptItem({
  prompt,
  isSelected,
  isDefault,
  isHovered,
  onSelect,
  onDelete,
  onSetDefault,
  onHoverChange,
}: SidebarPromptItemProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 cursor-pointer transition-colors',
        isSelected ? 'bg-accent/50' : 'hover:bg-muted/50'
      )}
      onClick={() => onSelect(prompt.id)}
      onMouseEnter={() => onHoverChange(prompt.id)}
      onMouseLeave={() => onHoverChange(null)}
    >
      {/* 名称 + 标记 */}
      <div className="flex-1 min-w-0 flex items-center gap-1">
        <span className="text-sm truncate">{prompt.name}</span>
        {prompt.isBuiltin && (
          <span className="text-[10px] text-muted-foreground shrink-0">(内置)</span>
        )}
        {isDefault && (
          <Star className="size-3 text-amber-500 fill-amber-500 shrink-0" />
        )}
      </div>

      {/* 操作按钮 */}
      <div className={cn(
        'flex items-center gap-0.5 shrink-0 transition-opacity',
        isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'
      )}>
        {!isDefault && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={(e) => {
              e.stopPropagation()
              onSetDefault(prompt.id)
            }}
            title="设为默认"
          >
            <Star className="size-3 text-muted-foreground" />
          </Button>
        )}
        {!prompt.isBuiltin && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(prompt.id)
            }}
            title="删除"
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}
