/**
 * ImportPresetDialog — 从其他工作区导入预设
 *
 * 列出其他工作区可用的自定义预设（自动过滤内置），
 * 选择来源工作区后一键导入到当前工作区（深拷贝 + 新 UUID）。
 * 逻辑与 ImportSkillDialog 同构。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { BriefcaseBusiness } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SettingsCard } from '@/components/settings/primitives'
import { workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import type { OtherWorkspacePresetsGroup } from '@profer/shared'

interface ImportPresetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceSlug: string
  onImported: () => void
}

export function ImportPresetDialog({ open, onOpenChange, workspaceSlug, onImported }: ImportPresetDialogProps): React.ReactElement {
  const [otherWorkspaces, setOtherWorkspaces] = React.useState<OtherWorkspacePresetsGroup[]>([])
  const [importingPresetId, setImportingPresetId] = React.useState<string | null>(null)
  const bumpCapabilities = useSetAtom(workspaceCapabilitiesVersionAtom)
  const [selectedWorkspaceSlug, setSelectedWorkspaceSlug] = React.useState('')

  React.useEffect(() => {
    if (!open || !workspaceSlug) return
    void (async () => {
      try {
        const groups = await window.electronAPI.getOtherWorkspacePresets(workspaceSlug)
        setOtherWorkspaces(groups)
      } catch (error) {
        console.error('[Agent 技能] 加载其他工作区预设失败:', error)
      }
    })()
  }, [open, workspaceSlug])

  const availableWorkspaces = React.useMemo(
    () => otherWorkspaces.filter((w) => w.presets.length > 0),
    [otherWorkspaces],
  )

  const selectedWorkspace = React.useMemo(
    () => availableWorkspaces.find((w) => w.workspaceSlug === selectedWorkspaceSlug) ?? null,
    [availableWorkspaces, selectedWorkspaceSlug],
  )

  React.useEffect(() => {
    if (!open || availableWorkspaces.length === 0) {
      setSelectedWorkspaceSlug('')
      return
    }
    setSelectedWorkspaceSlug((current) =>
      availableWorkspaces.some((w) => w.workspaceSlug === current)
        ? current
        : availableWorkspaces[0]?.workspaceSlug ?? '',
    )
  }, [availableWorkspaces, open])

  const handleImport = async (sourceSlug: string, presetId: string): Promise<void> => {
    if (!workspaceSlug || importingPresetId) return
    setImportingPresetId(presetId)
    try {
      const imported = await window.electronAPI.importPresetFromWorkspace(workspaceSlug, sourceSlug, presetId)
      bumpCapabilities((v) => v + 1)
      onImported()
      onOpenChange(false)
      toast.success(`已导入预设：${imported.name}`)
    } catch (error) {
      console.error('[Agent 技能] 导入预设失败:', error)
      const message = error instanceof Error ? error.message : '未知错误'
      toast.error('导入预设失败', { description: message })
    } finally {
      setImportingPresetId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-thin sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>从其他工作区导入预设</DialogTitle>
          <DialogDescription>
            预设为工作区级配置。选择来源工作区，把它的自定义预设复制到当前工作区（内置预设无需导入）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-foreground/70">来源工作区</label>
            <Select
              value={selectedWorkspaceSlug}
              onValueChange={setSelectedWorkspaceSlug}
              disabled={availableWorkspaces.length === 0}
            >
              <SelectTrigger><SelectValue placeholder="没有可用的来源工作区" /></SelectTrigger>
              <SelectContent>
                {availableWorkspaces.map((w) => (
                  <SelectItem key={w.workspaceSlug} value={w.workspaceSlug}>
                    {w.workspaceName}（{w.presets.length} 个预设）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {selectedWorkspace ? (
            <SettingsCard divided>
              {selectedWorkspace.presets.map((preset) => (
                <div key={preset.id} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <BriefcaseBusiness size={14} className="shrink-0 text-foreground/45" />
                      <span className="text-sm font-medium truncate">{preset.name}</span>
                    </div>
                    {preset.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{preset.description}</p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={importingPresetId !== null}
                    onClick={() => void handleImport(selectedWorkspace.workspaceSlug, preset.id)}
                  >
                    {importingPresetId === preset.id ? '导入中…' : '导入'}
                  </Button>
                </div>
              ))}
            </SettingsCard>
          ) : (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              其他工作区暂时没有可导入的自定义预设
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
