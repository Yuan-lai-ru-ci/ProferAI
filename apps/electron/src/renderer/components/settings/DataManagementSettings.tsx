/**
 * DataManagementSettings — 数据管理（迁移 + 磁盘）
 *
 * 上半部分：数据迁移（导入/导出备份）
 * 下半部分：磁盘管理（存储用量、自动清理、深度清理）
 */

import * as React from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import {
  Download,
  Upload,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  ChevronDown,
  ChevronRight,
  HardDrive,
  Trash2,
  RefreshCw,
  PackageOpen,
} from 'lucide-react'
import { toast } from 'sonner'
import { SettingsSection, SettingsCard, SettingsRow, SettingsToggle } from './primitives'
import { Button } from '@profer/ui/primitives/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@profer/ui/primitives/select'
import {
  agentWorkspacesAtom,
  agentMessageRefreshAtom,
  agentSDKMessagesCacheAtom,
  currentAgentSessionIdAtom,
  resolvedBlobMessagesAtom,
} from '@/atoms/agent-atoms'
import { migrationImportDialogOpenAtom } from '@/atoms/migration-atoms'
import { cn } from '@/lib/utils'
import { getFileBaseName } from '@/lib/file-utils'

// ==================== 导出（Migration）类型 ====================

type MigrationMode = 'personal' | 'share'
type MigrationComponent = 'sessions' | 'skills' | 'mcp' | 'channels' | 'chattools'
type ShareDetailMode = 'default' | 'custom'

interface ShareExportWorkspacePreview {
  workspace: { id: string; name: string; slug: string }
  skills: Array<{ slug: string; name: string; enabled: boolean }>
  mcpServers: Array<{ name: string; enabled: boolean; type: string }>
}

interface ShareExportPreview {
  workspaces: ShareExportWorkspacePreview[]
  agentSessionCount: number
  chatConversationCount: number
}

interface WsSelection {
  skills: Set<string>
  mcpServers: Set<string>
}

interface ExportResult {
  success: boolean
  filePath?: string
  error?: string
  warnings?: string[]
}

const COMPONENT_LABELS: Record<MigrationComponent, string> = {
  sessions: '会话记录',
  skills: 'Skills',
  mcp: 'MCP 配置',
  channels: '模型渠道',
  chattools: 'Chat 工具',
}

// ==================== 存储类型 ====================

interface StorageCategory {
  label: string
  key: string
  bytes: number
  count: number
  hasOrphans: boolean
  orphanBytes: number
  orphanCount: number
}

interface StorageStats {
  categories: StorageCategory[]
  totalBytes: number
  calculatedAt: number
}

interface CleanupResult {
  freedBytes: number
  deletedCount: number
  errors: string[]
}

/** 与 main/lib/agent-session-compaction.ts 的 SessionCompactionResult 对应 */
interface SessionCompactionResult {
  scannedFiles: number
  rewrittenFiles: number
  rewrittenLines: number
  skippedFiles: number
  failedFiles: number
  charsBefore: number
  charsAfter: number
  blobRefs: number
  blobCount: number
  blobBytes: number
  backupDir?: string
  errors: string[]
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const BAR_COLORS = [
  'bg-blue-500',
  'bg-purple-500',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-rose-500',
  'bg-cyan-500',
]

// ==================== 主组件 ====================

export function DataManagementSettings(): React.ReactElement {
  return (
    <div className="min-w-0 space-y-8">
      <div className="space-y-6">
        <h2 className="text-base font-semibold">备份与迁移</h2>
        <MigrationSection />
      </div>
      <div className="space-y-6 border-t border-border pt-6">
        <h2 className="text-base font-semibold">磁盘与清理</h2>
        <StorageSection />
      </div>
    </div>
  )
}

// ==================== 数据迁移 Section ====================

function MigrationSection(): React.ReactElement {
  const [exportMode, setExportMode] = React.useState<MigrationMode>('personal')
  const [shareComponents, setShareComponents] = React.useState<Set<MigrationComponent>>(
    new Set(['sessions', 'skills', 'mcp'])
  )
  const [exporting, setExporting] = React.useState(false)
  const exportRef = React.useRef(false)
  const [exportResult, setExportResult] = React.useState<ExportResult | null>(null)

  const [shareDetailMode, setShareDetailMode] = React.useState<ShareDetailMode>('default')
  const [sharePreview, setSharePreview] = React.useState<ShareExportPreview | null>(null)
  const [sharePreviewLoading, setSharePreviewLoading] = React.useState(false)
  const [sharePreviewError, setSharePreviewError] = React.useState(false)
  const [wsSelections, setWsSelections] = React.useState<Map<string, WsSelection>>(new Map())
  const [expandedWorkspaces, setExpandedWorkspaces] = React.useState<Set<string>>(new Set())

  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspace = workspaces[0]
  const setMigrationImportDialogOpen = useSetAtom(migrationImportDialogOpenAtom)

  const hasSkillsOrMcp = shareComponents.has('skills') || shareComponents.has('mcp')

  const loadSharePreview = React.useCallback(async () => {
    setSharePreviewLoading(true)
    setSharePreviewError(false)
    try {
      const preview = await window.electronAPI.migrationGetShareExportPreview() as ShareExportPreview
      setSharePreview(preview)
      const selections = new Map<string, WsSelection>()
      for (const ws of preview.workspaces) {
        selections.set(ws.workspace.id, {
          skills: new Set(ws.skills.map((s) => s.slug)),
          mcpServers: new Set(ws.mcpServers.map((m) => m.name)),
        })
      }
      setWsSelections(selections)
    } catch {
      setSharePreviewError(true)
    } finally {
      setSharePreviewLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (exportMode === 'share' && shareDetailMode === 'custom' && !sharePreview && !sharePreviewError) {
      loadSharePreview()
    }
  }, [exportMode, shareDetailMode, sharePreview, sharePreviewError, loadSharePreview])

  const handleExport = async (): Promise<void> => {
    if (!currentWorkspace || exportRef.current || (exportMode === 'share' && hasSkillsOrMcp && shareDetailMode === 'custom' && (!sharePreview || sharePreviewLoading || sharePreviewError))) return
    // main 将空的工作区选择解释为「全部」，这里必须明确阻断，不能扩大用户选择范围。
    if (exportMode === 'share' && hasSkillsOrMcp && shareDetailMode === 'custom' && sharePreview &&
      !sharePreview.workspaces.some((ws) => {
        const sel = wsSelections.get(ws.workspace.id)
        return (shareComponents.has('skills') && !!sel?.skills.size) || (shareComponents.has('mcp') && !!sel?.mcpServers.size)
      })) {
      setExportResult({ success: false, error: '请至少选择一个工作区项目；空选择不会导出全部工作区' })
      return
    }
    exportRef.current = true
    setExporting(true)
    setExportResult(null)

    try {
      const outputPath = await window.electronAPI.migrationSaveFileDialog(exportMode)
      if (!outputPath) {
        exportRef.current = false
        setExporting(false)
        return
      }

      const components: MigrationComponent[] =
        exportMode === 'personal'
          ? ['sessions', 'skills', 'mcp', 'channels', 'chattools']
          : Array.from(shareComponents)

      if (exportMode === 'share') {
        let workspaceSelections: Array<{ workspaceId: string; skillSlugs?: string[]; mcpServerNames?: string[] }> | undefined

        if (shareDetailMode === 'custom' && sharePreview) {
          workspaceSelections = []
          for (const ws of sharePreview.workspaces) {
            const sel = wsSelections.get(ws.workspace.id)
            if (!sel) continue
            const hasSkills = sel.skills.size > 0 && shareComponents.has('skills')
            const hasMcp = sel.mcpServers.size > 0 && shareComponents.has('mcp')
            if (!hasSkills && !hasMcp) continue
            workspaceSelections.push({
              workspaceId: ws.workspace.id,
              skillSlugs: shareComponents.has('skills') ? Array.from(sel.skills) : undefined,
              mcpServerNames: shareComponents.has('mcp') ? Array.from(sel.mcpServers) : undefined,
            })
          }
        }

        const result = await window.electronAPI.migrationExportV2({
          mode: exportMode,
          components,
          outputPath,
          workspaceSelections,
        }) as ExportResult
        setExportResult(result)
      } else {
        const result = await window.electronAPI.migrationExportV2({
          mode: exportMode,
          components,
          outputPath,
        }) as ExportResult
        setExportResult(result)
      }
    } catch (err) {
      setExportResult({ success: false, error: err instanceof Error ? err.message : '导出失败' })
    } finally {
      exportRef.current = false
      setExporting(false)
    }
  }

  const toggleShareComponent = (comp: MigrationComponent): void => {
    setShareComponents((prev) => {
      const next = new Set(prev)
      if (next.has(comp)) next.delete(comp)
      else next.add(comp)
      return next
    })
  }

  const toggleWsExpand = (wsId: string): void => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev)
      if (next.has(wsId)) next.delete(wsId)
      else next.add(wsId)
      return next
    })
  }

  const toggleWsSkill = (wsId: string, slug: string): void => {
    setWsSelections((prev) => {
      const next = new Map(prev)
      const sel = { ...next.get(wsId)!, skills: new Set(next.get(wsId)!.skills), mcpServers: new Set(next.get(wsId)!.mcpServers) }
      if (sel.skills.has(slug)) sel.skills.delete(slug)
      else sel.skills.add(slug)
      next.set(wsId, sel)
      return next
    })
  }

  const toggleWsMcp = (wsId: string, name: string): void => {
    setWsSelections((prev) => {
      const next = new Map(prev)
      const sel = { ...next.get(wsId)!, skills: new Set(next.get(wsId)!.skills), mcpServers: new Set(next.get(wsId)!.mcpServers) }
      if (sel.mcpServers.has(name)) sel.mcpServers.delete(name)
      else sel.mcpServers.add(name)
      next.set(wsId, sel)
      return next
    })
  }

  const toggleWsAll = (wsId: string, wsPreview: ShareExportWorkspacePreview): void => {
    setWsSelections((prev) => {
      const next = new Map(prev)
      const sel = next.get(wsId)
      if (!sel) return prev
      const allSkills = wsPreview.skills.map((s) => s.slug)
      const allMcp = wsPreview.mcpServers.map((m) => m.name)
      const allSelected = allSkills.every((s) => sel.skills.has(s)) && allMcp.every((m) => sel.mcpServers.has(m))
      if (allSelected) {
        next.set(wsId, { skills: new Set(), mcpServers: new Set() })
      } else {
        next.set(wsId, { skills: new Set(allSkills), mcpServers: new Set(allMcp) })
      }
      return next
    })
  }

  return (
    <>
      {/* ── 导出区块 ── */}
      <SettingsSection
        title="导出备份"
        description="将本机数据导出为可移植文件；个人备份包含敏感凭据"
      >
        <div className="space-y-4">
          {/* 模式选择 */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">导出模式</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ModeCard
                active={exportMode === 'personal'}
                onClick={() => setExportMode('personal')}
                title="个人备份"
                subtitle=".profer-backup"
                description="完整备份所有数据，含 API Key，用于换机迁移"
              />
              <ModeCard
                active={exportMode === 'share'}
                onClick={() => setExportMode('share')}
                title="团队分发"
                subtitle=".profer-share"
                description="自选组件，凭据自动剥离，分享给同事"
              />
            </div>
          </div>

          {/* Share 模式组件选择 */}
          {exportMode === 'share' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">导出内容</p>
              <div className="rounded-lg border border-border/50 divide-y divide-border/30">
                {(Object.keys(COMPONENT_LABELS) as MigrationComponent[]).map((comp) => (
                  <label
                    key={comp}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={shareComponents.has(comp)}
                      onChange={() => toggleShareComponent(comp)}
                      className="w-4 h-4 rounded border-border accent-primary"
                    />
                    <span className="text-sm text-foreground">{COMPONENT_LABELS[comp]}</span>
                    {comp === 'channels' && (
                      <span className="text-xs text-muted-foreground ml-auto">API Key 将被剥离</span>
                    )}
                    {comp === 'mcp' && (
                      <span className="text-xs text-muted-foreground ml-auto">凭据将被剥离</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Share 模式：多工作区选择 */}
          {exportMode === 'share' && hasSkillsOrMcp && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">工作区范围</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  aria-pressed={shareDetailMode === 'default'}
                  onClick={() => setShareDetailMode('default')}
                  className={cn(
                    'text-left px-3 py-2.5 rounded-lg border text-sm transition-colors',
                    shareDetailMode === 'default'
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/50 hover:border-border hover:bg-muted/30'
                  )}
                >
                  <span className="font-medium text-foreground">所有工作区</span>
                  <p className="text-xs text-muted-foreground mt-0.5">导出全部工作区的 Skills 和 MCP</p>
                </button>
                <button
                  aria-pressed={shareDetailMode === 'custom'}
                  onClick={() => setShareDetailMode('custom')}
                  className={cn(
                    'text-left px-3 py-2.5 rounded-lg border text-sm transition-colors',
                    shareDetailMode === 'custom'
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border/50 hover:border-border hover:bg-muted/30'
                  )}
                >
                  <span className="font-medium text-foreground">自定义选择</span>
                  <p className="text-xs text-muted-foreground mt-0.5">手动挑选要导出的项目</p>
                </button>
              </div>

              {/* 自定义选择面板 */}
              {shareDetailMode === 'custom' && (
                <div className="rounded-lg border border-border/50">
                  {sharePreviewLoading ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                      <Loader2 size={16} className="animate-spin" />
                      加载中...
                    </div>
                  ) : sharePreview ? (
                    <div className="divide-y divide-border/30">
                      {sharePreview.workspaces.map((ws) => {
                        const wsId = ws.workspace.id
                        const expanded = expandedWorkspaces.has(wsId)
                        const sel = wsSelections.get(wsId)
                        const totalItems = ws.skills.length + ws.mcpServers.length
                        const selectedItems = (sel?.skills.size ?? 0) + (sel?.mcpServers.size ?? 0)

                        return (
                          <div key={wsId}>
                            <div className="flex items-center gap-3 px-4 py-3">
                              <button type="button" aria-expanded={expanded} onClick={() => toggleWsExpand(wsId)} className="min-w-0 flex flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                {expanded ? <ChevronDown size={14} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={14} className="shrink-0 text-muted-foreground" />}
                                <span className="min-w-0 break-words text-sm font-medium">{ws.workspace.name}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">{selectedItems}/{totalItems} 项</span>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  toggleWsAll(wsId, ws)
                                }}
                                className="text-xs text-primary hover:underline"
                              >
                                {selectedItems === totalItems ? '取消全选' : '全选'}
                              </button>
                            </div>

                            {expanded && (
                              <div className="px-4 pb-3 pl-9 space-y-1">
                                {shareComponents.has('skills') && ws.skills.length > 0 && (
                                  <>
                                    <p className="text-xs font-medium text-muted-foreground pt-1">Skills</p>
                                    {ws.skills.map((skill) => (
                                      <label key={skill.slug} className="flex items-center gap-2 py-0.5 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={sel?.skills.has(skill.slug) ?? false}
                                          onChange={() => toggleWsSkill(wsId, skill.slug)}
                                          className="w-3.5 h-3.5 rounded border-border accent-primary"
                                        />
                                        <span className="text-sm text-foreground">{skill.name}</span>
                                        {!skill.enabled && <span className="text-xs text-muted-foreground">(已禁用)</span>}
                                      </label>
                                    ))}
                                  </>
                                )}
                                {shareComponents.has('mcp') && ws.mcpServers.length > 0 && (
                                  <>
                                    <p className="text-xs font-medium text-muted-foreground pt-1">MCP Servers</p>
                                    {ws.mcpServers.map((server) => (
                                      <label key={server.name} className="flex items-center gap-2 py-0.5 cursor-pointer">
                                        <input
                                          type="checkbox"
                                          checked={sel?.mcpServers.has(server.name) ?? false}
                                          onChange={() => toggleWsMcp(wsId, server.name)}
                                          className="w-3.5 h-3.5 rounded border-border accent-primary"
                                        />
                                        <span className="text-sm text-foreground">{server.name}</span>
                                        <span className="text-xs text-muted-foreground">({server.type})</span>
                                      </label>
                                    ))}
                                  </>
                                )}
                                {((!shareComponents.has('skills') || ws.skills.length === 0) && (!shareComponents.has('mcp') || ws.mcpServers.length === 0)) && (
                                  <p className="text-xs text-muted-foreground py-1">此工作区没有可导出的项目</p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 text-sm">
                      <span className="text-destructive">加载预览失败，自定义导出已暂停</span>
                      <Button size="sm" variant="outline" onClick={() => void loadSharePreview()}>重试预览</Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {exportMode === 'personal' && (
            <div className="rounded-lg bg-muted/30 border border-border/30 px-4 py-3">
              <p className="text-sm text-muted-foreground">
                将导出所有会话、Skills、MCP 配置、渠道（含 API Key）及个人设置。
                <br />
                请妥善保管备份文件，避免泄露其中的 API Key。
              </p>
            </div>
          )}

          {/* 导出按钮 */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={handleExport}
              disabled={exporting || !currentWorkspace || (exportMode === 'share' && (shareComponents.size === 0 || (hasSkillsOrMcp && shareDetailMode === 'custom' && (!sharePreview || sharePreviewLoading || sharePreviewError))))}
              className={cn(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {exporting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Download size={16} />
              )}
              {exporting ? '导出中...' : '选择保存位置并导出'}
            </button>

            {exportResult && (
              <div className={cn('flex items-center gap-1.5 text-sm', exportResult.success ? 'text-green-600' : 'text-red-500')}>
                {exportResult.success ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                {exportResult.success
                  ? `已导出至 ${exportResult.filePath ? getFileBaseName(exportResult.filePath) : ''}`
                  : exportResult.error}
              </div>
            )}
          </div>

          {exportResult?.success && exportResult.warnings && exportResult.warnings.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200/70 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
              <div className="min-w-0 space-y-1">
                <p>导出已完成，但有 {exportResult.warnings.length} 个项目无法读取，已跳过。</p>
                <p className="break-all text-xs opacity-90" title={exportResult.warnings.join('\n')}>
                  {exportResult.warnings[0]}
                  {exportResult.warnings.length > 1 ? ' 等' : ''}
                </p>
              </div>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* ── 导入区块 ── */}
      <SettingsSection
        title="导入备份"
        description="从备份文件导入数据，支持 .profer-backup 和 .profer-share 格式"
      >
        <button
          onClick={() => setMigrationImportDialogOpen(true)}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
            'border border-border hover:bg-muted/50'
          )}
        >
          <Upload size={16} />
          打开导入
        </button>
      </SettingsSection>
    </>
  )
}

// ==================== 磁盘管理 Section ====================

function StorageSection(): React.ReactElement {
  const store = useStore()
  const [stats, setStats] = React.useState<StorageStats | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [cleaningKey, setCleaningKey] = React.useState<string | null>(null)
  const [lastResult, setLastResult] = React.useState<CleanupResult | null>(null)
  const [autoCleanupTemp, setAutoCleanupTemp] = React.useState(true)
  const [autoCleanupDays, setAutoCleanupDays] = React.useState(0)
  const [compactionPreview, setCompactionPreview] = React.useState<SessionCompactionResult | null>(null)
  const [compactionResult, setCompactionResult] = React.useState<SessionCompactionResult | null>(null)
  const [compacting, setCompacting] = React.useState(false)
  const [statsError, setStatsError] = React.useState(false)
  const [settingsLoaded, setSettingsLoaded] = React.useState(false)
  const [settingsError, setSettingsError] = React.useState(false)
  const [savingSettings, setSavingSettings] = React.useState(false)
  const settingsBusy = React.useRef(false)
  const [confirmation, setConfirmation] = React.useState<{ label: string; description: string; run: () => Promise<void> } | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const operationBusy = React.useRef(false)

  const loadStats = React.useCallback(async () => {
    setLoading(true)
    setStatsError(false)
    try {
      const result = await window.electronAPI.getStorageStats() as StorageStats
      setStats(result)
    } catch (e) {
      console.error('[存储管理] 获取统计失败:', e)
      setStatsError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCleanupSettings = React.useCallback(async () => {
    setSettingsError(false)
    setSettingsLoaded(false)
    try {
      const settings = await window.electronAPI.getSettings()
      setAutoCleanupTemp(settings.autoCleanupTempOnStart !== false)
      setAutoCleanupDays(settings.autoCleanupArchivedDays ?? 0)
      setSettingsLoaded(true)
    } catch {
      setSettingsError(true)
    }
  }, [])

  React.useEffect(() => {
    void loadStats()
    void loadCleanupSettings()
  }, [loadStats, loadCleanupSettings])

  const runConfirmed = async (): Promise<void> => {
    if (!confirmation || operationBusy.current) return
    operationBusy.current = true
    setConfirming(true)
    try {
      await confirmation.run()
      setConfirmation(null)
    } catch {
      toast.error('操作失败，未完成的操作可在此重试')
    } finally {
      operationBusy.current = false
      setConfirming(false)
    }
  }

  const handleCleanCategory = async (key: string, orphansOnly: boolean): Promise<void> => {
    setCleaningKey(key)
    setLastResult(null)
    try {
      const result = await window.electronAPI.cleanupStorage({
        categories: [key],
        orphansOnly,
        archivedBeforeDays: 0,
      }) as CleanupResult
      setLastResult(result)
      await loadStats()
    } catch (e) {
      console.error('[存储管理] 清理失败:', e)
      throw e
    } finally {
      setCleaningKey(null)
    }
  }

  const handleCleanTemp = async (): Promise<void> => {
    setCleaningKey('temp-files')
    setLastResult(null)
    try {
      const result = await window.electronAPI.cleanupTempStorage() as CleanupResult
      setLastResult(result)
      await loadStats()
    } catch (e) {
      console.error('[存储管理] 清理临时文件失败:', e)
      throw e
    } finally {
      setCleaningKey(null)
    }
  }

  const handleCleanAllOrphans = async (): Promise<void> => {
    setCleaningKey('all-orphans')
    setLastResult(null)
    try {
      const result = await window.electronAPI.cleanupStorage({
        categories: ['agent-sessions', 'sdk-config', 'workspaces', 'session-blobs'],
        orphansOnly: true,
        archivedBeforeDays: 0,
      }) as CleanupResult
      setLastResult(result)
      await loadStats()
    } catch (e) {
      console.error('[存储管理] 清理孤儿数据失败:', e)
      throw e
    } finally {
      setCleaningKey(null)
    }
  }

  const handleAutoCleanupTempChange = async (enabled: boolean): Promise<void> => {
    if (!settingsLoaded || settingsBusy.current) return
    settingsBusy.current = true
    setSavingSettings(true)
    try {
      await window.electronAPI.updateSettings({ autoCleanupTempOnStart: enabled })
      setAutoCleanupTemp(enabled)
    } catch (e) {
      console.error('[存储管理] 更新自动清理设置失败:', e)
      toast.error('自动清理设置保存失败，保留原设置')
    } finally {
      settingsBusy.current = false
      setSavingSettings(false)
    }
  }

  const handleAutoCleanupDaysChange = async (value: string): Promise<void> => {
    if (!settingsLoaded || settingsBusy.current) return
    const days = parseInt(value, 10)
    settingsBusy.current = true
    setSavingSettings(true)
    try {
      await window.electronAPI.updateSettings({ autoCleanupArchivedDays: days })
      setAutoCleanupDays(days)
    } catch (e) {
      console.error('[存储管理] 更新自动清理天数失败:', e)
      toast.error('归档清理设置保存失败，保留原设置')
      throw e
    } finally {
      settingsBusy.current = false
      setSavingSettings(false)
    }
  }

  // 先检测再整理：整理不可逆（会替换历史消息里的超大字段），必须先让用户看到规模。
  const handlePreviewCompaction = async (): Promise<void> => {
    setCompacting(true)
    setCompactionResult(null)
    setCompactionPreview(null)
    try {
      const result = await window.electronAPI.previewSessionCompaction() as SessionCompactionResult
      setCompactionPreview(result)
      if (result.rewrittenFiles === 0) toast.info('没有需要整理的历史数据')
    } catch (e) {
      console.error('[存储管理] 检测会话整理规模失败:', e)
      toast.error('检测失败')
    } finally {
      setCompacting(false)
    }
  }

  const handleApplyCompaction = async (): Promise<void> => {
    setCompacting(true)
    try {
      const result = await window.electronAPI.applySessionCompaction() as SessionCompactionResult
      setCompactionResult(result)
      setCompactionPreview(null)

      // 整理会原子替换磁盘文件。renderer 可能仍持有整理前的整条巨型消息；
      // 必须清掉消息缓存与按需全文缓存，并让当前会话重读磁盘，否则磁盘已变瘦、
      // 打开/关闭会话时内存仍可能沿用旧对象，看起来像「整理没生效」。
      if (result.rewrittenFiles > 0) {
        const cachedSessionIds = [...store.get(agentSDKMessagesCacheAtom).keys()]
        const currentSessionId = store.get(currentAgentSessionIdAtom)
        const refreshSessionIds = new Set(cachedSessionIds)
        if (currentSessionId) refreshSessionIds.add(currentSessionId)

        store.set(agentSDKMessagesCacheAtom, new Map())
        store.set(resolvedBlobMessagesAtom, new Map())
        if (refreshSessionIds.size > 0) {
          store.set(agentMessageRefreshAtom, (prev) => {
            const next = new Map(prev)
            for (const sessionId of refreshSessionIds) {
              next.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
            }
            return next
          })
        }
      }

      toast.success(result.rewrittenFiles > 0 ? `已整理 ${result.rewrittenFiles} 个会话文件` : '没有需要整理的数据')
      await loadStats()
    } catch (e) {
      console.error('[存储管理] 执行会话整理失败:', e)
      toast.error('整理失败')
      throw e
    } finally {
      setCompacting(false)
    }
  }

  const totalOrphanBytes = stats?.categories.reduce((sum, c) => sum + c.orphanBytes, 0) ?? 0
  const hasOrphans = totalOrphanBytes > 0

  return (
    <>
      {/* 存储用量 */}
      <SettingsSection
        title="存储用量"
        description={stats ? `总计 ${formatBytes(stats.totalBytes)}` : loading ? '正在计算…' : '尚未获取存储统计'}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={loadStats}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
            刷新
          </Button>
        }
      >
        {statsError && <div role="alert" className="text-sm text-destructive">存储统计加载失败，点击刷新重试。已有结果可能已过期。</div>}
        {loading && !stats && <p role="status" className="text-sm text-muted-foreground">正在计算存储用量…</p>}
        {!loading && !statsError && stats?.categories.length === 0 && <p className="text-sm text-muted-foreground">暂无存储数据</p>}
        {stats && (
          <div className="mb-4">
            <StorageBar categories={stats.categories} totalBytes={stats.totalBytes} />
          </div>
        )}
        <SettingsCard>
          {stats?.categories.map((cat, i) => (
            <SettingsRow key={cat.key} label={cat.label}>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn('inline-block h-2.5 w-2.5 rounded-full', BAR_COLORS[i % BAR_COLORS.length])}
                  />
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {formatBytes(cat.bytes)}
                  </span>
                  {cat.hasOrphans && (
                    <span className="flex items-center gap-1 text-xs text-amber-500">
                      <AlertTriangle size={12} />
                      孤儿 {formatBytes(cat.orphanBytes)}
                    </span>
                  )}
                </div>
                {cat.key === 'temp-files' ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmation({ label: '清理临时文件', description: '删除预览与安装缓存，无法撤销；不会删除会话记录。', run: handleCleanTemp })}
                    disabled={confirming || cleaningKey !== null || compacting || loading || statsError || cat.bytes === 0}
                    className="h-7 gap-1 text-xs"
                  >
                    <Trash2 size={12} />
                    {cleaningKey === 'temp-files' ? '清理中...' : '清理'}
                  </Button>
                ) : cat.hasOrphans ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmation({ label: `清理${cat.label}孤儿数据`, description: '永久删除已失去会话或工作区关联的文件，无法撤销。请先导出需要保留的数据。', run: () => handleCleanCategory(cat.key, true) })}
                    disabled={confirming || cleaningKey !== null || compacting || loading || statsError}
                    className="h-7 gap-1 text-xs"
                  >
                    <Trash2 size={12} />
                    {cleaningKey === cat.key ? '清理中...' : '清理孤儿'}
                  </Button>
                ) : null}
              </div>
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>

      {/* 自动清理 */}
      <SettingsSection
        title="自动清理"
        description="配置启动时和定期的自动清理规则"
      >
        {settingsError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive">
          <span>自动清理配置加载失败，不会写入默认值。</span>
          <Button size="sm" variant="outline" onClick={() => void loadCleanupSettings()}>重试清理配置</Button>
        </div>}
        <SettingsCard>
          <SettingsToggle
            label="启动时清理临时文件"
            description="每次启动时自动删除预览和安装缓存"
            checked={autoCleanupTemp}
            disabled={!settingsLoaded || savingSettings}
            onCheckedChange={handleAutoCleanupTempChange}
          />
          <SettingsRow label="清理已归档会话数据" description="自动清理超过指定天数的已归档会话消息和 SDK 数据">
            <Select value={String(autoCleanupDays)} disabled={!settingsLoaded || savingSettings} onValueChange={(value) => {
              if (value === '0') void handleAutoCleanupDaysChange(value).catch(() => {})
              else setConfirmation({ label: '启用归档数据自动清理', description: `将自动删除超过 ${value} 天的已归档会话消息和 SDK 数据，删除后不可恢复。请先备份。`, run: () => handleAutoCleanupDaysChange(value) })
            }}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">禁用</SelectItem>
                <SelectItem value="7">7 天</SelectItem>
                <SelectItem value="30">30 天</SelectItem>
                <SelectItem value="90">90 天</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {/* 深度清理 */}
      <SettingsSection
        title="深度清理"
        description="检测并清理已删除会话遗留的孤儿数据"
      >
        <SettingsCard>
          <SettingsRow
            label="孤儿数据"
            description="删除会话后残留的消息文件、SDK 缓存和工作目录"
          >
            <div className="flex flex-wrap items-center gap-3">
              {hasOrphans && (
                <span className="flex items-center gap-1 text-sm text-amber-500">
                  <AlertTriangle size={14} />
                  {formatBytes(totalOrphanBytes)}
                </span>
              )}
              <Button
                variant={hasOrphans ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setConfirmation({ label: '清理全部孤儿数据', description: '永久删除已删除会话遗留的消息、SDK 缓存、工作目录和独立载荷，无法撤销。请先备份。', run: handleCleanAllOrphans })}
                disabled={confirming || cleaningKey !== null || compacting || loading || statsError || !hasOrphans}
                className="gap-1.5"
              >
                <HardDrive size={14} />
                {cleaningKey === 'all-orphans' ? '清理中...' : hasOrphans ? '一键清理' : '无孤儿数据'}
              </Button>
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {/* 整理历史数据（与「清理」不同：把载荷搬出会话文件，不删任何东西） */}
      <SettingsSection
        title="整理历史数据"
        description="把历史会话里过大的工具输出与内嵌图片搬到独立存储，会话文件里只留片段；原文完整保留可随时取回，不删任何内容"
      >
        <SettingsCard>
          <SettingsRow
            label="可整理的会话数据"
            description="检测历史会话中超过存储上限的单条消息（通常是体积很大的工具输出或内嵌图片）。整理后打开这些会话不再需要把巨型内容读进内存"
          >
            <div className="flex flex-wrap items-center gap-3">
              {compactionPreview && (
                <span
                  className={cn(
                    'text-sm tabular-nums',
                    compactionPreview.rewrittenFiles > 0 ? 'text-amber-500' : 'text-muted-foreground',
                  )}
                >
                  {compactionPreview.rewrittenFiles > 0
                    ? `${compactionPreview.rewrittenFiles} 个文件 · 会话体积 ${formatBytes(compactionPreview.charsBefore)} → ${formatBytes(compactionPreview.charsAfter)}`
                    : '无需整理'}
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={handlePreviewCompaction}
                disabled={confirming || cleaningKey !== null || compacting}
                className="h-7 gap-1 text-xs"
              >
                <RefreshCw size={12} className={cn(compacting && 'animate-spin')} />
                检测
              </Button>
              <Button
                variant={compactionPreview && compactionPreview.rewrittenFiles > 0 ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setConfirmation({ label: '整理历史数据', description: `将重写 ${compactionPreview?.rewrittenFiles ?? 0} 个会话文件；原文搬入独立存储，并保留原文件备份。请确认检测规模后继续。`, run: handleApplyCompaction })}
                disabled={confirming || cleaningKey !== null || compacting || !compactionPreview || compactionPreview.rewrittenFiles === 0}
                className="h-7 gap-1 text-xs"
              >
                <PackageOpen size={12} />
                立即整理
              </Button>
            </div>
          </SettingsRow>
        </SettingsCard>

        {compactionResult && (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
            {compactionResult.rewrittenFiles > 0 ? (
              <>
                <span className="text-emerald-600 dark:text-emerald-400">
                  已整理 {compactionResult.rewrittenFiles} 个会话文件、{compactionResult.rewrittenLines} 条消息；
                  会话体积 {formatBytes(compactionResult.charsBefore)} → {formatBytes(compactionResult.charsAfter)}
                </span>
                <div className="mt-1 text-xs text-muted-foreground">
                  原文 {formatBytes(compactionResult.blobBytes)} 已搬到独立存储
                  {compactionResult.blobRefs > compactionResult.blobCount
                    ? `（${compactionResult.blobCount} 份，重复内容已自动合并）`
                    : ''}
                  ；在会话里点「加载全文」即可取回
                </div>
                {compactionResult.backupDir && (
                  <div className="mt-1 break-all text-xs text-muted-foreground">
                    原文件已备份至 {compactionResult.backupDir}
                  </div>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">没有需要整理的数据</span>
            )}
            {compactionResult.errors.length > 0 && (
              <div className="mt-1 text-xs text-destructive">
                {compactionResult.errors.map((err, i) => <div key={i}>{err}</div>)}
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      {/* 操作结果提示 */}
      {lastResult && (
        <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
          {lastResult.freedBytes > 0 ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              已释放 {formatBytes(lastResult.freedBytes)}，删除 {lastResult.deletedCount} 个文件
            </span>
          ) : (
            <span className="text-muted-foreground">没有需要清理的数据</span>
          )}
          {lastResult.errors.length > 0 && (
            <div className="mt-1 text-xs text-destructive">
              {lastResult.errors.map((err, i) => <div key={i}>{err}</div>)}
            </div>
          )}
        </div>
      )}
      <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !operationBusy.current) setConfirmation(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.label}？</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirming}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={confirming} onClick={(event) => { event.preventDefault(); void runConfirmed() }}>
              {confirming ? '处理中…' : '确认执行'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ==================== 子组件 ====================

function StorageBar({ categories, totalBytes }: { categories: StorageCategory[]; totalBytes: number }): React.ReactElement {
  if (totalBytes === 0) {
    return <div className="h-3 w-full rounded-full bg-muted" />
  }
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
      {categories.map((cat, i) => {
        const pct = (cat.bytes / totalBytes) * 100
        if (pct < 0.5) return null
        return (
          <div
            key={cat.key}
            className={cn('h-full transition-all', BAR_COLORS[i % BAR_COLORS.length])}
            style={{ width: `${pct}%` }}
            title={`${cat.label}: ${formatBytes(cat.bytes)}`}
          />
        )
      })}
    </div>
  )
}

interface ModeCardProps {
  active: boolean
  onClick: () => void
  title: string
  subtitle: string
  description: string
}

function ModeCard({ active, onClick, title, subtitle, description }: ModeCardProps): React.ReactElement {
  return (
    <button
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'relative flex flex-col items-start gap-1 p-4 rounded-lg border text-left transition-colors',
        active
          ? 'border-primary/50 bg-primary/5'
          : 'border-border/50 hover:border-border hover:bg-muted/30'
      )}
    >
      {active && (
        <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-primary" />
      )}
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-xs font-mono text-muted-foreground">{subtitle}</span>
      <span className="text-xs text-muted-foreground leading-relaxed">{description}</span>
    </button>
  )
}
