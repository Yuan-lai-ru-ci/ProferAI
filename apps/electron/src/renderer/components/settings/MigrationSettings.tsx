/**
 * MigrationSettings - 数据迁移设置页
 *
 * 支持两种模式：
 * - Personal 备份（.proma-backup）：全量导出，含解密 API Key
 * - Share 分发（.proma-share）：自由选择组件，凭据自动剥离
 *
 * 功能：
 * - 导出区块：选择模式、勾选组件、选择会话
 * - 导入区块：选择文件、预览内容、路径检查、确认导入
 */

import * as React from 'react'
import {
  Download,
  Upload,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderOpen,
  ArrowRight,
} from 'lucide-react'
import { SettingsSection } from './primitives'
import { useAtomValue } from 'jotai'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { cn } from '@/lib/utils'

type MigrationMode = 'personal' | 'share'
type MigrationComponent = 'sessions' | 'skills' | 'mcp' | 'channels' | 'chattools'

interface PathCheckResult {
  path: string
  exists: boolean
  suggested?: string
}

interface ImportPreview {
  manifest: {
    mode: string
    workspaceName: string
    sourcePlatform: string
    exportedAt: number
    components: MigrationComponent[]
  }
  agentSessionCount: number
  chatConversationCount: number
  skillNames: string[]
  hasMcp: boolean
  crossPlatform: boolean
  pathCheckResults: PathCheckResult[]
  tempDir: string
}

const COMPONENT_LABELS: Record<MigrationComponent, string> = {
  sessions: '会话记录',
  skills: 'Skills',
  mcp: 'MCP 配置',
  channels: '模型渠道',
  chattools: 'Chat 工具',
}

export function MigrationSettings(): React.ReactElement {
  // ── 导出状态 ──────────────────────────────────────
  const [exportMode, setExportMode] = React.useState<MigrationMode>('personal')
  const [shareComponents, setShareComponents] = React.useState<Set<MigrationComponent>>(
    new Set(['sessions', 'skills', 'mcp'])
  )
  const [exporting, setExporting] = React.useState(false)
  const [exportResult, setExportResult] = React.useState<{ success: boolean; filePath?: string; error?: string } | null>(null)

  // ── 导入状态 ──────────────────────────────────────
  const [importing, setImporting] = React.useState(false)
  const [importPreview, setImportPreview] = React.useState<ImportPreview | null>(null)
  const [pathMappings, setPathMappings] = React.useState<Record<string, string | null>>({})
  const [importConfirming, setImportConfirming] = React.useState(false)
  const [importResult, setImportResult] = React.useState<{ success: boolean; error?: string } | null>(null)

  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspace = workspaces[0]

  // 监听双击文件触发的导入事件
  React.useEffect(() => {
    const unsub = window.electronAPI.onMigrationOpenImportFile(async ({ filePath }) => {
      setImporting(true)
      setImportPreview(null)
      setImportResult(null)
      try {
        const preview = await window.electronAPI.migrationParseImportFile(filePath) as ImportPreview
        const initialMappings: Record<string, string | null> = {}
        for (const r of preview.pathCheckResults) {
          if (!r.exists) initialMappings[r.path] = null
        }
        setPathMappings(initialMappings)
        setImportPreview(preview)
      } catch (err) {
        setImportResult({ success: false, error: err instanceof Error ? err.message : '解析文件失败' })
      } finally {
        setImporting(false)
      }
    })
    return unsub
  }, [])

  // ── 导出逻辑 ──────────────────────────────────────

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

      const result = await window.electronAPI.migrationExport({
        mode: exportMode,
        workspaceId: currentWorkspace.id,
        components,
        outputPath,
      }) as { success: boolean; filePath: string }

      setExportResult({ success: true, filePath: result.filePath })
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

  // ── 导入逻辑 ──────────────────────────────────────

  const handleSelectImportFile = async (): Promise<void> => {
    setImporting(true)
    setImportPreview(null)
    setImportResult(null)

    try {
      const filePath = await window.electronAPI.migrationOpenFileDialog()
      if (!filePath) {
        setImporting(false)
        return
      }

      const preview = await window.electronAPI.migrationParseImportFile(filePath) as ImportPreview

      // 初始化路径映射：存在的路径保留，不存在的默认移除
      const initialMappings: Record<string, string | null> = {}
      for (const r of preview.pathCheckResults) {
        if (!r.exists) {
          initialMappings[r.path] = null
        }
      }
      setPathMappings(initialMappings)
      setImportPreview(preview)
    } catch (err) {
      setImportResult({ success: false, error: err instanceof Error ? err.message : '解析文件失败' })
    } finally {
      setImporting(false)
    }
  }

  const handleConfirmImport = async (): Promise<void> => {
    if (!importPreview) return
    setImportConfirming(true)

    try {
      await window.electronAPI.migrationConfirmImport({
        tempDir: importPreview.tempDir,
        manifest: importPreview.manifest,
        pathMappings,
      })
      setImportResult({ success: true })
      setImportPreview(null)
    } catch (err) {
      setImportResult({ success: false, error: err instanceof Error ? err.message : '导入失败' })
    } finally {
      setImportConfirming(false)
    }
  }

  const handlePathMapping = (originalPath: string, newValue: string | null): void => {
    setPathMappings((prev) => ({ ...prev, [originalPath]: newValue }))
  }

  return (
    <div className="space-y-8">
      {/* ── 导出区块 ──────────────────────────────── */}
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
                subtitle=".proma-backup"
                description="完整备份所有数据，含 API Key，用于换机迁移"
              />
              <ModeCard
                active={exportMode === 'share'}
                onClick={() => setExportMode('share')}
                title="团队分发"
                subtitle=".proma-share"
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
        </div>
      </SettingsSection>

      {/* ── 导入区块 ──────────────────────────────── */}
      <SettingsSection
        title="导入备份"
        description="从备份文件导入数据，支持 .proma-backup 和 .proma-share 格式"
      >
        <div className="space-y-4">
          {/* 文件选择 */}
          {!importPreview && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleSelectImportFile}
                disabled={importing}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
                  'border border-border hover:bg-muted/50',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {importing ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />}
                {importing ? '解析中...' : '选择迁移文件'}
              </button>
              <span className="text-xs text-muted-foreground">支持 .proma-backup 和 .proma-share</span>
            </div>
          )}

          {importResult && !importPreview && (
            <div className={cn('flex items-center gap-1.5 text-sm', importResult.success ? 'text-green-600' : 'text-red-500')}>
              {importResult.success ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {importResult.success ? '导入成功！请重启应用使所有更改生效。' : importResult.error}
            </div>
          )}

          {/* 导入预览 */}
          {importPreview && (
            <div className="space-y-4">
              {/* 跨平台警告 */}
              {importPreview.crossPlatform && (
                <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 dark:bg-amber-950/20 dark:border-amber-800">
                  <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-amber-700 dark:text-amber-400">
                    <p className="font-medium">检测到跨平台迁移（{importPreview.manifest.sourcePlatform} → 当前系统）</p>
                    <p className="mt-0.5 text-amber-600 dark:text-amber-500">部分 Skills 和 MCP 工具可能需要手动调整命令路径。</p>
                  </div>
                </div>
              )}

              {/* 内容摘要 */}
              <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  包内容来自：{importPreview.manifest.workspaceName}（
                  {new Date(importPreview.manifest.exportedAt).toLocaleDateString('zh-CN')}）
                </p>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-muted-foreground">
                  {importPreview.agentSessionCount > 0 && (
                    <span>Agent 会话：{importPreview.agentSessionCount} 个</span>
                  )}
                  {importPreview.chatConversationCount > 0 && (
                    <span>Chat 对话：{importPreview.chatConversationCount} 个</span>
                  )}
                  {importPreview.skillNames.length > 0 && (
                    <span>Skills：{importPreview.skillNames.length} 个</span>
                  )}
                  {importPreview.hasMcp && <span>MCP 配置：已包含</span>}
                </div>
              </div>

              {/* 路径检查 */}
              {importPreview.pathCheckResults.length > 0 && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">附加目录处理</label>
                  <div className="rounded-lg border border-border/50 divide-y divide-border/30">
                    {importPreview.pathCheckResults.map((r) => (
                      <div key={r.path} className="px-4 py-3 space-y-1.5">
                        <div className="flex items-center gap-2">
                          {r.exists ? (
                            <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                          ) : (
                            <XCircle size={14} className="text-red-400 flex-shrink-0" />
                          )}
                          <span className="text-xs font-mono text-foreground truncate">{r.path}</span>
                        </div>
                        {!r.exists && (
                          <div className="flex items-center gap-2 pl-5">
                            <span className="text-xs text-muted-foreground">处理方式：</span>
                            <select
                              value={pathMappings[r.path] === null ? '__remove' : (pathMappings[r.path] ?? '__remove')}
                              onChange={(e) => handlePathMapping(r.path, e.target.value === '__remove' ? null : e.target.value)}
                              className="text-xs border border-border rounded px-2 py-1 bg-background"
                            >
                              <option value="__remove">移除（推荐）</option>
                              {r.suggested && (
                                <option value={r.suggested}>推断路径：{r.suggested}</option>
                              )}
                            </select>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 确认按钮 */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleConfirmImport}
                  disabled={importConfirming}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
                    'bg-primary text-primary-foreground hover:bg-primary/90',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  {importConfirming ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Upload size={16} />
                  )}
                  {importConfirming ? '导入中...' : '确认导入'}
                </button>
                <button
                  onClick={() => { setImportPreview(null); setImportResult(null) }}
                  disabled={importConfirming}
                  className="px-4 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                >
                  取消
                </button>
              </div>

              {importResult && (
                <div className={cn('flex items-center gap-1.5 text-sm', importResult.success ? 'text-green-600' : 'text-red-500')}>
                  {importResult.success ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                  {importResult.success ? '导入成功！请重启应用使所有更改生效。' : importResult.error}
                </div>
              )}
            </div>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}

// ─── 模式卡片子组件 ────────────────────────────────────────────────────────

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
