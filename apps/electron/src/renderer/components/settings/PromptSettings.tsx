/**
 * PromptSettings - 系统提示词管理设置页
 *
 * 上方：提示词列表（选择/新建/删除/设为默认）
 * 下方：编辑区（名称 + 内容，内置只读）
 * 底部：追加日期时间和用户名开关
 */

import * as React from 'react'
import { useAtom, useAtomValue, useStore } from 'jotai'
import { Plus, Trash2, Star } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { Textarea } from '@profer/ui/primitives/textarea'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import { cn } from '@/lib/utils'
import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
} from './primitives'
import {
  promptConfigAtom,
  selectedPromptIdAtom,
  defaultPromptIdAtom,
} from '@/atoms/system-prompt-atoms'
import { promptDeletingIdsAtom, promptSaveStateAtom, useSystemPromptAutosave } from '@/hooks/useSystemPromptAutosave'
import type { SystemPrompt, SystemPromptCreateInput } from '@profer/shared'

export function PromptSettings(): React.ReactElement {
  const store = useStore()
  const [config, setConfig] = useAtom(promptConfigAtom)
  const [selectedId, setSelectedId] = useAtom(selectedPromptIdAtom)
  const defaultPromptId = useAtomValue(defaultPromptIdAtom)

  const saveState = useAtomValue(promptSaveStateAtom)
  const deletingIds = useAtomValue(promptDeletingIdsAtom)
  const debounceSave = useSystemPromptAutosave()
  const [loadError, setLoadError] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [editName, setEditName] = React.useState('')
  const [editContent, setEditContent] = React.useState('')
  const [hoveredId, setHoveredId] = React.useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<SystemPrompt | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const deletingRef = React.useRef(false)
  const nameId = React.useId()
  const contentId = React.useId()

  /** 当前选中的提示词 */
  const selectedPrompt = React.useMemo(
    () => config.prompts.find((p) => p.id === selectedId),
    [config.prompts, selectedId]
  )

  /** 初始加载配置 */
  const loadConfig = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError('')
    try {
      await debounceSave.flush()
      const beforeRead = store.get(promptConfigAtom)
      const cfg = await window.electronAPI.getSystemPromptConfig()
      if (store.get(promptConfigAtom) === beforeRead) setConfig(cfg)
    } catch {
      setLoadError('提示词读取或保存失败，当前草稿已保留，请重试')
    } finally {
      setLoading(false)
    }
  }, [setConfig, debounceSave, store])
  React.useEffect(() => { void loadConfig() }, [loadConfig])

  /** 选中提示词变化时，同步编辑字段 */
  React.useEffect(() => {
    if (selectedPrompt) {
      setEditName(selectedPrompt.name)
      setEditContent(selectedPrompt.content)
    }
  }, [selectedPrompt])

  /** 选中提示词 */
  const handleSelect = (id: string): void => {
    setSelectedId(id)
  }

  /** 新建提示词 */
  const handleCreate = async (): Promise<void> => {
    if (loading || loadError) return
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
      console.error('[提示词设置] 创建失败:', error)
      toast.error('创建提示词失败，请重试')
    }
  }

  /** 删除提示词 */
  const handleDelete = async (): Promise<void> => {
    if (!deleteTarget || deleteTarget.isBuiltin || deletingRef.current) return
    const id = deleteTarget.id
    deletingRef.current = true
    setDeleting(true)
    try {
      await debounceSave.remove(id)
      setDeleteTarget(null)
      toast.success('已删除提示词')
    } catch (error) {
      console.error('[提示词设置] 删除失败:', error)
      toast.error('删除提示词失败，内容已保留，请重试')
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  /** 设为默认提示词 */
  const handleSetDefault = async (id: string): Promise<void> => {
    try {
      await window.electronAPI.setDefaultPrompt(id)
      setConfig((prev) => ({ ...prev, defaultPromptId: id }))
    } catch (error) {
      console.error('[提示词设置] 设置默认失败:', error)
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
    if (loading || loadError) return
    try {
      await window.electronAPI.updateAppendSetting(enabled)
      setConfig((prev) => ({ ...prev, appendDateTimeAndUserName: enabled }))
    } catch (error) {
      console.error('[提示词设置] 更新追加设置失败:', error)
      toast.error('追加选项保存失败，请重试')
    }
  }

  return (
    <div className="space-y-6">
      {loadError && <div role="alert" className="flex items-center gap-3 text-sm text-destructive"><span>{loadError}</span><Button type="button" variant="outline" size="sm" onClick={() => { void loadConfig() }}>重试加载</Button></div>}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground" role="status" aria-live="polite">
        <span>{saveState === 'saving' ? '保存中...' : saveState === 'pending' ? '有待保存的更改' : saveState === 'error' ? '保存失败，草稿已保留' : '已保存'}</span>
        {(saveState === 'error' || saveState === 'pending') && <Button type="button" size="sm" variant="outline" onClick={() => { void debounceSave.flush().catch(() => {}) }}>重试保存</Button>}
      </div>
      {/* 提示词列表 */}
      <SettingsSection
        title="系统提示词"
        description="管理 Chat 模式的系统提示词"
        action={
          <Button size="sm" disabled={loading || Boolean(loadError)} onClick={handleCreate}>
            <Plus className="size-4 mr-1" />
            新建
          </Button>
        }
      >
        <SettingsCard divided={false} className="p-0">
          <div className="divide-y divide-border/50">
            {config.prompts.map((prompt) => (
              <PromptListItem
                key={prompt.id}
                prompt={prompt}
                isSelected={prompt.id === selectedId}
                isDefault={prompt.id === defaultPromptId}
                isHovered={prompt.id === hoveredId}
                onSelect={handleSelect}
                onDelete={(id) => setDeleteTarget(config.prompts.find((item) => item.id === id) ?? null)}
                onSetDefault={handleSetDefault}
                onHoverChange={(id) => setHoveredId(id)}
              />
            ))}
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 编辑区 */}
      {selectedPrompt && (
        <SettingsSection title="提示词内容">
          <SettingsCard divided={false} className="p-4 space-y-3">
            <div>
              <label htmlFor={nameId} className="text-sm font-medium text-foreground mb-1.5 block">
                名称
              </label>
              <Input
                id={nameId}
                value={editName}
                onChange={(e) => handleNameChange(e.target.value)}
                readOnly={selectedPrompt.isBuiltin || loading || Boolean(loadError) || deleting || deletingIds.includes(selectedPrompt.id)}
                className={cn(selectedPrompt.isBuiltin && 'opacity-60 cursor-not-allowed')}
                maxLength={50}
              />
            </div>
            <div>
              <label htmlFor={contentId} className="text-sm font-medium text-foreground mb-1.5 block">
                内容
              </label>
              <Textarea
                id={contentId}
                value={editContent}
                onChange={(e) => handleContentChange(e.target.value)}
                readOnly={selectedPrompt.isBuiltin || loading || Boolean(loadError) || deleting || deletingIds.includes(selectedPrompt.id)}
                className={cn(
                  'min-h-[280px] resize-y',
                  selectedPrompt.isBuiltin && 'opacity-60 cursor-not-allowed'
                )}
                placeholder="输入系统提示词内容..."
              />
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {/* 增强选项 */}
      <SettingsSection title="增强选项">
        <SettingsCard>
          <SettingsToggle
            label="追加日期时间和用户名"
            description="在提示词末尾自动追加当前日期时间和用户名"
            checked={config.appendDateTimeAndUserName}
            disabled={loading || Boolean(loadError)}
            onCheckedChange={handleAppendChange}
          />
        </SettingsCard>
      </SettingsSection>
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deletingRef.current) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除提示词？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteTarget?.name}」，此操作无法撤销。若它是默认提示词，将恢复为内置默认。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => { event.preventDefault(); void handleDelete() }}
            >
              {deleting ? '删除中…' : '删除提示词'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 提示词列表项 */
interface PromptListItemProps {
  prompt: SystemPrompt
  isSelected: boolean
  isDefault: boolean
  isHovered: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onSetDefault: (id: string) => void
  onHoverChange: (id: string | null) => void
}

function PromptListItem({
  prompt,
  isSelected,
  isDefault,
  isHovered,
  onSelect,
  onDelete,
  onSetDefault,
  onHoverChange,
}: PromptListItemProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2.5 cursor-pointer transition-colors',
        isSelected ? 'bg-accent/50' : 'hover:bg-muted/50'
      )}
      onMouseEnter={() => onHoverChange(prompt.id)}
      onMouseLeave={() => onHoverChange(null)}
    >
      {/* 名称 + 标记 */}
      <button
        type="button"
        onClick={() => onSelect(prompt.id)}
        aria-pressed={isSelected}
        className="flex-1 min-w-0 flex items-center gap-1.5 text-left rounded-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-focus/15"
      >
        <span className="text-sm font-medium truncate">{prompt.name}</span>
        {prompt.isBuiltin && (
          <span className="text-xs text-muted-foreground shrink-0">(内置)</span>
        )}
        {isDefault && (
          <Star className="size-3.5 text-amber-500 fill-amber-500 shrink-0" />
        )}
      </button>

      {/* 操作按钮 — 始终占位，hover 时显示 */}
      <div className={cn(
        'flex items-center gap-1 shrink-0 transition-opacity focus-within:opacity-100 focus-within:pointer-events-auto',
        isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none'
      )}>
        {!isDefault && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={(e) => {
              e.stopPropagation()
              onSetDefault(prompt.id)
            }}
            title="设为默认"
            aria-label={`将${prompt.name}设为默认`}
          >
            <Star className="size-3.5 text-muted-foreground" />
          </Button>
        )}
        {!prompt.isBuiltin && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(prompt.id)
            }}
            title="删除"
            aria-label={`删除提示词${prompt.name}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}
