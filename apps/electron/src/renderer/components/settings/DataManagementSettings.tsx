/**
 * DataManagementSettings — 数据管理（迁移 + 磁盘）
 *
 * 上半部分：数据迁移（导入/导出备份）
 * 下半部分：磁盘管理（存储用量、自动清理、深度清理）
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
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
} from 'lucide-react'
import { toast } from 'sonner'
import { SettingsSection, SettingsCard, SettingsRow, SettingsToggle } from './primitives'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { migrationImportDialogOpenAtom } from '@/atoms/migration-atoms'
import { cn } from '@/lib/utils'

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
    <div className="space-y-8">
      <MigrationSection />
      <StorageSection />
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
  const [exportResult, setExportResult] = React.useState<ExportResult | null>(null)

  const [shareDetailMode, setShareDetailMode] = React.useState<ShareDetailMode>('default')
  const [sharePreview, setSharePreview] = React.useState<ShareExportPreview | null>(null)
  const [sharePreviewLoading, setSharePreviewLoading] = React.useState(false)
  const [wsSelections, setWsSelections] = React.useState<Map<string, WsSelection>>(new Map())
  const [expandedWorkspaces, setExpandedWorkspaces] = React.useState<Set<string>>(new Set())

  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspace = workspaces[0]
  const setMigrationImportDialogOpen = useSetAtom(migrationImportDialogOpenAtom)

  const hasSkillsOrMcp = shareComponents.has('skills') || shareComponents.has('mcp')

  const loadSharePreview = React.useCallback(async () => {
    setSharePreviewLoading(true)
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
      // 静默失败
    } finally {
      setSharePreviewLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (exportMode === 'share' && shareDetailMode === 'custom' && !sharePreview) {
      loadSharePreview()
    }
  }, [exportMode, shareDetailMode, sharePreview, loadSharePreview])

  const handleExport = async (): Promise<void> => {
    if (!currentWorkspace) return
    setExporting(true)
    setExportResult(null)

    try {
      const outputPath = await window.electronAPI.migrationSaveFileDialog(exportMode)
      if (!outputPath) {
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
        }) as { success: boolean; filePath: string; warnings?: string[] }
        setExportResult({ success: true, filePath: result.filePath, warnings: result.warnings })
      } else {
        const result = await window.electronAPI.migrationExportV2({
          mode: exportMode,
          components,
          outputPath,
        }) as { success: boolean; filePath: string; warnings?: string[] }
        setExportResult({ success: true, filePath: result.filePath, warnings: result.warnings })
      }
    } catch (err) {
      setExportResult({ success: false, error: err instanceof Error ? err.message : '导出失败' })
    } finally {
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
        description="将当前工作区的数据导出为可移植的备份文件"
      >
        <div className="space-y-4">
          {/* 模式选择 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">导出模式</label>
            <div className="grid grid-cols-2 gap-3">
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
              <label className="text-sm font-medium text-foreground">导出内容</label>
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
              <label className="text-sm font-medium text-foreground">工作区范围</label>
              <div className="grid grid-cols-2 gap-3">
                <button
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
                            <div
                              className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                              onClick={() => toggleWsExpand(wsId)}
                            >
                              {expanded ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
                              <span className="text-sm font-medium text-foreground flex-1">{ws.workspace.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {selectedItems}/{totalItems} 项
                              </span>
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
                    <p className="text-sm text-muted-foreground text-center py-4">加载预览失败</p>
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
          <div className="flex items-center gap-3">
            <button
              onClick={handleExport}
              disabled={exporting || !currentWorkspace || (exportMode === 'share' && shareComponents.size === 0)}
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
                  ? `已导出至 ${exportResult.filePath?.split('/').pop() ?? ''}`
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
  const [stats, setStats] = React.useState<StorageStats | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [cleaningKey, setCleaningKey] = React.useState<string | null>(null)
  const [lastResult, setLastResult] = React.useState<CleanupResult | null>(null)
  const [autoCleanupTemp, setAutoCleanupTemp] = React.useState(true)
  const [autoCleanupDays, setAutoCleanupDays] = React.useState(0)

  const loadStats = React.useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.getStorageStats() as StorageStats
      setStats(result)
    } catch (e) {
      console.error('[存储管理] 获取统计失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    loadStats()
    window.electronAPI.getSettings().then((settings) => {
      setAutoCleanupTemp(settings.autoCleanupTempOnStart !== false)
      setAutoCleanupDays(settings.autoCleanupArchivedDays ?? 0)
    }).catch(console.error)
  }, [loadStats])

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
    } finally {
      setCleaningKey(null)
    }
  }

  const handleCleanAllOrphans = async (): Promise<void> => {
    setCleaningKey('all-orphans')
    setLastResult(null)
    try {
      const result = await window.electronAPI.cleanupStorage({
        categories: ['agent-sessions', 'sdk-config', 'workspaces'],
        orphansOnly: true,
        archivedBeforeDays: 0,
      }) as CleanupResult
      setLastResult(result)
      await loadStats()
    } catch (e) {
      console.error('[存储管理] 清理孤儿数据失败:', e)
    } finally {
      setCleaningKey(null)
    }
  }

  const handleAutoCleanupTempChange = async (enabled: boolean): Promise<void> => {
    setAutoCleanupTemp(enabled)
    try {
      await window.electronAPI.updateSettings({ autoCleanupTempOnStart: enabled })
    } catch (e) {
      console.error('[存储管理] 更新自动清理设置失败:', e)
    }
  }

  const handleAutoCleanupDaysChange = async (value: string): Promise<void> => {
    const days = parseInt(value, 10)
    setAutoCleanupDays(days)
    try {
      await window.electronAPI.updateSettings({ autoCleanupArchivedDays: days })
    } catch (e) {
      console.error('[存储管理] 更新自动清理天数失败:', e)
    }
  }

  const totalOrphanBytes = stats?.categories.reduce((sum, c) => sum + c.orphanBytes, 0) ?? 0
  const hasOrphans = totalOrphanBytes > 0

  return (
    <>
      {/* 存储用量 */}
      <SettingsSection
        title="存储用量"
        description={stats ? `总计 ${formatBytes(stats.totalBytes)}` : '正在计算...'}
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
        {stats && (
          <div className="mb-4">
            <StorageBar categories={stats.categories} totalBytes={stats.totalBytes} />
          </div>
        )}
        <SettingsCard>
          {stats?.categories.map((cat, i) => (
            <SettingsRow key={cat.key} label={cat.label}>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
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
                    onClick={handleCleanTemp}
                    disabled={cleaningKey !== null || cat.bytes === 0}
                    className="h-7 gap-1 text-xs"
                  >
                    <Trash2 size={12} />
                    {cleaningKey === 'temp-files' ? '清理中...' : '清理'}
                  </Button>
                ) : cat.hasOrphans ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCleanCategory(cat.key, true)}
                    disabled={cleaningKey !== null}
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
        <SettingsCard>
          <SettingsToggle
            label="启动时清理临时文件"
            description="每次启动时自动删除预览和安装缓存"
            checked={autoCleanupTemp}
            onCheckedChange={handleAutoCleanupTempChange}
          />
          <SettingsRow label="清理已归档会话数据" description="自动清理超过指定天数的已归档会话消息和 SDK 数据">
            <Select value={String(autoCleanupDays)} onValueChange={handleAutoCleanupDaysChange}>
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
            <div className="flex items-center gap-3">
              {hasOrphans && (
                <span className="flex items-center gap-1 text-sm text-amber-500">
                  <AlertTriangle size={14} />
                  {formatBytes(totalOrphanBytes)}
                </span>
              )}
              <Button
                variant={hasOrphans ? 'default' : 'ghost'}
                size="sm"
                onClick={handleCleanAllOrphans}
                disabled={cleaningKey !== null || !hasOrphans}
                className="gap-1.5"
              >
                <HardDrive size={14} />
                {cleaningKey === 'all-orphans' ? '清理中...' : hasOrphans ? '一键清理' : '无孤儿数据'}
              </Button>
            </div>
          </SettingsRow>
        </SettingsCard>
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
