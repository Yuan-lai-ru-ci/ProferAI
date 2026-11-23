import * as React from 'react'
import { useAtom, useSetAtom, useAtomValue } from 'jotai'
import {
  Upload,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderOpen,
  LockKeyhole,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@profer/ui/primitives/dialog'
import { Button } from '@profer/ui/primitives/button'
import { Input } from '@profer/ui/primitives/input'
import { Label } from '@profer/ui/primitives/label'
import { ScrollRegion } from '@/components/ai-elements/scroll-region'
import {
  migrationImportDialogOpenAtom,
  migrationImportInitialFilePathAtom,
} from '@/atoms/migration-atoms'
import { agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { useMigrationImport } from '@/hooks/useMigrationImport'
import type { WorkspaceImportPreviewItem } from '@/hooks/useMigrationImport'

export function MigrationImportDialog(): React.ReactElement {
  const [open, setOpen] = useAtom(migrationImportDialogOpenAtom)
  const [initialFilePath, setInitialFilePath] = useAtom(migrationImportInitialFilePathAtom)
  const localWorkspaces = useAtomValue(agentWorkspacesAtom)
  const passphraseId = React.useId()

  const {
    importing,
    importPreview,
    pathMappings,
    workspaceMappings,
    conflictResolution,
    hasConflicts,
    importConfirming,
    importResult,
    isV2,
    requiresPassphrase,
    passphrase,
    passphraseError,
    setPassphrase,
    submitPassphrase,
    cancelPassphrase,
    handleSelectImportFile,
    handleConfirmImport,
    handlePathMapping,
    handleWorkspaceMapping,
    setConflictResolution,
    reset,
  } = useMigrationImport(open ? initialFilePath : null)

  React.useEffect(() => {
    const unsub = window.electronAPI.onMigrationOpenImportFile(({ filePath }) => {
      setInitialFilePath(filePath)
      setOpen(true)
    })
    return unsub
  }, [setInitialFilePath, setOpen])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      reset()
      setInitialFilePath(null)
    }
    setOpen(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>导入配置</DialogTitle>
          <DialogDescription>
            从备份文件导入数据，支持 .profer-backup 和 .profer-share 格式
          </DialogDescription>
        </DialogHeader>

        <ScrollRegion className="min-h-0 overflow-y-auto space-y-4 mt-2">
          {/* 阶段 1：选择文件 / 输入口令 */}
          {!importPreview && !importResult?.success && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                {requiresPassphrase ? (
                  <LockKeyhole size={28} className="text-muted-foreground" />
                ) : (
                  <FolderOpen size={28} className="text-muted-foreground" />
                )}
              </div>

              {requiresPassphrase ? (
                <div className="w-full max-w-sm space-y-2">
                  <p className="text-sm text-muted-foreground text-center">
                    该备份已加密，请输入导出时设置的口令。
                  </p>
                  <Label htmlFor={passphraseId}>备份口令</Label>
                  <Input
                    id={passphraseId}
                    aria-invalid={Boolean(passphraseError)}
                    aria-describedby={passphraseError ? `${passphraseId}-error` : undefined}
                    type="password"
                    autoFocus
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && passphrase.length > 0 && !importing) void submitPassphrase()
                    }}
                    disabled={importing}
                    placeholder="备份口令"
                  />
                  {passphraseError && (
                    <p id={`${passphraseId}-error`} role="alert" className="text-xs text-destructive-text">{passphraseError}</p>
                  )}
                  <div className="flex items-center justify-center gap-2">
                    <Button type="button"
                      onClick={submitPassphrase}
                      disabled={importing || passphrase.length === 0}
                    >
                      {importing ? <Loader2 size={16} className="animate-spin" /> : <LockKeyhole size={16} />}
                      {importing ? '解密中...' : '解密并解析'}
                    </Button>
                    <Button type="button"
                      onClick={cancelPassphrase}
                      disabled={importing}
                      variant="ghost"
                    >
                      返回
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground text-center">
                    选择 .profer-backup 或 .profer-share 文件开始导入
                  </p>
                  <Button type="button"
                    onClick={handleSelectImportFile}
                    disabled={importing}
                  >
                    {importing ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />}
                    {importing ? '解析中...' : '选择文件'}
                  </Button>
                </>
              )}

              {importResult && !importResult.success && (
                <div className="flex items-center gap-1.5 text-sm text-red-500">
                  <XCircle size={15} />
                  {importResult.error}
                </div>
              )}
            </div>
          )}

          {/* 阶段 2：预览 & 配置 */}
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

              {/* 本机数据（personal 备份） */}
              {importPreview.personal?.available && (
                <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 space-y-2">
                  <p className="text-sm font-medium text-foreground">同时恢复本机数据</p>
                  <p className="text-sm text-muted-foreground">
                    {importPreview.personal.sections.length > 0
                      ? importPreview.personal.sections.join('、')
                      : '本机设置与附件'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    含会话原文 {importPreview.personal.blobCount} 段
                    {importPreview.personal.blobBytes > 0 ? `（${formatBytes(importPreview.personal.blobBytes)}）` : ''}
                    {importPreview.personal.missingBlobs > 0 && (
                      <span className="text-amber-600 dark:text-amber-400">
                        ，导出时有 {importPreview.personal.missingBlobs} 段原文已丢失
                      </span>
                    )}
                  </p>
                </div>
              )}

              {/* 内容摘要 */}
              {isV2 && importPreview.workspaces ? (
                <V2ContentSummary
                  preview={importPreview}
                  workspaceMappings={workspaceMappings}
                  localWorkspaces={localWorkspaces}
                  onWorkspaceMapping={handleWorkspaceMapping}
                  hasConflicts={hasConflicts}
                  conflictResolution={conflictResolution}
                  onConflictResolutionChange={setConflictResolution}
                />
              ) : (
                <V1ContentSummary preview={importPreview} />
              )}

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

              {/* 确认 / 取消 */}
              <div className="flex items-center gap-3 pt-2">
                <Button type="button"
                  onClick={handleConfirmImport}
                  disabled={importConfirming}
                >
                  {importConfirming ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Upload size={16} />
                  )}
                  {importConfirming ? '导入中...' : '确认导入'}
                </Button>
                <Button type="button"
                  onClick={() => {
                    reset()
                    setInitialFilePath(null)
                  }}
                  disabled={importConfirming}
                  variant="ghost"
                >
                  取消
                </Button>
              </div>

              {importResult && !importResult.success && (
                <div className="flex items-center gap-1.5 text-sm text-red-500">
                  <XCircle size={15} />
                  {importResult.error}
                </div>
              )}
            </div>
          )}

          {/* 阶段 3：导入成功 */}
          {importResult?.success && !importPreview && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="w-16 h-16 rounded-2xl bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 size={28} className="text-green-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">导入成功</p>
                <p className="text-xs text-muted-foreground mt-1">请重启应用使所有更改生效</p>
              </div>
              {importResult.restored && importResult.restored.length > 0 && (
                <div className="w-full rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
                  <p className="text-sm text-muted-foreground">
                    已恢复：{importResult.restored.join('、')}
                  </p>
                </div>
              )}
              {importResult.warnings && importResult.warnings.length > 0 && (
                <div className="w-full flex items-start gap-2 rounded-lg border border-amber-200/70 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                  <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 space-y-1">
                    <p>有 {importResult.warnings.length} 条提醒：</p>
                    <ul className="list-disc pl-4 text-xs space-y-0.5 break-all">
                      {importResult.warnings.slice(0, 5).map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <Button type="button"
                onClick={() => handleOpenChange(false)}
              >
                关闭
              </Button>
            </div>
          )}
        </ScrollRegion>
      </DialogContent>
    </Dialog>
  )
}

// ─── v1 内容摘要（原有逻辑）────────────────────────────────────────────────

function V1ContentSummary({ preview }: { preview: { manifest: { workspaceName?: string; exportedAt: number; components: string[] }; agentSessionCount: number; chatConversationCount: number; skillNames: string[]; hasMcp: boolean } }): React.ReactElement {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 space-y-2">
      <p className="text-sm font-medium text-foreground">
        包内容来自：{preview.manifest.workspaceName ?? '未知工作区'}（
        {new Date(preview.manifest.exportedAt).toLocaleDateString('zh-CN')}）
      </p>
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-muted-foreground">
        {preview.agentSessionCount > 0 && (
          <span>Agent 会话：{preview.agentSessionCount} 个</span>
        )}
        {preview.chatConversationCount > 0 && (
          <span>Chat 对话：{preview.chatConversationCount} 个</span>
        )}
        {preview.skillNames.length > 0 && (
          <span>Skills：{preview.skillNames.length} 个</span>
        )}
        {preview.hasMcp && <span>MCP 配置：已包含</span>}
        {preview.manifest.components.includes('channels') && (
          <span>模型渠道：已包含</span>
        )}
        {preview.manifest.components.includes('chattools') && (
          <span>Chat 工具：已包含</span>
        )}
      </div>
    </div>
  )
}

// ─── v2 多工作区内容摘要 ──────────────────────────────────────────────────

interface V2ContentSummaryProps {
  preview: { manifest: { exportedAt: number; components: string[] }; agentSessionCount: number; chatConversationCount: number; workspaces?: WorkspaceImportPreviewItem[] }
  workspaceMappings: Array<{ sourceSlug: string; action: string; targetWorkspaceId?: string; newWorkspaceName?: string }>
  localWorkspaces: Array<{ id: string; name: string; slug: string }>
  onWorkspaceMapping: (sourceSlug: string, mapping: Record<string, unknown>) => void
  hasConflicts: boolean
  conflictResolution: 'overwrite' | 'skip'
  onConflictResolutionChange: (value: 'overwrite' | 'skip') => void
}

function V2ContentSummary({ preview, workspaceMappings, localWorkspaces, onWorkspaceMapping, hasConflicts, conflictResolution, onConflictResolutionChange }: V2ContentSummaryProps): React.ReactElement {
  const wsCount = preview.workspaces?.length ?? 0

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3 space-y-2">
        <p className="text-sm font-medium text-foreground">
          包含 {wsCount} 个工作区的配置（导出于 {new Date(preview.manifest.exportedAt).toLocaleDateString('zh-CN')}）
        </p>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-muted-foreground">
          {preview.agentSessionCount > 0 && (
            <span>Agent 会话：{preview.agentSessionCount} 个</span>
          )}
          {preview.chatConversationCount > 0 && (
            <span>Chat 对话：{preview.chatConversationCount} 个</span>
          )}
          {preview.manifest.components.includes('channels') && (
            <span>模型渠道：已包含</span>
          )}
          {preview.manifest.components.includes('chattools') && (
            <span>Chat 工具：已包含</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">工作区导入方式</label>
        <div className="rounded-lg border border-border/50 divide-y divide-border/30">
          {(preview.workspaces ?? []).map((ws) => {
            const mapping = workspaceMappings.find((m) => m.sourceSlug === ws.workspaceSlug)
            const action = mapping?.action ?? 'merge'

            return (
              <div key={ws.workspaceSlug} className="px-4 py-3 space-y-2">
                <div className="flex items-center gap-2">
                  {ws.existsLocally ? (
                    <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                  ) : (
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-400 flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium text-foreground">{ws.workspaceName}</span>
                  <span className="text-xs text-muted-foreground font-mono">{ws.workspaceSlug}</span>
                </div>
                <div className="flex items-center gap-4 pl-5 text-xs text-muted-foreground">
                  {ws.skillNames.length > 0 && <span>Skills: {ws.skillNames.length} 个</span>}
                  {ws.mcpServerNames.length > 0 && <span>MCP: {ws.mcpServerNames.length} 个</span>}
                  {((ws.conflictingSkills?.length ?? 0) > 0 || (ws.conflictingMcpServers?.length ?? 0) > 0) && (
                    <span className="text-amber-600 dark:text-amber-400">
                      冲突: {[
                        (ws.conflictingSkills?.length ?? 0) > 0 ? `${ws.conflictingSkills.length} 个 Skill` : '',
                        (ws.conflictingMcpServers?.length ?? 0) > 0 ? `${ws.conflictingMcpServers.length} 个 MCP` : '',
                      ].filter(Boolean).join('、')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 pl-5">
                  <span className="text-xs text-muted-foreground">操作：</span>
                  <select
                    value={action}
                    onChange={(e) => {
                      const newAction = e.target.value as 'merge' | 'create' | 'skip'
                      if (newAction === 'merge' && ws.existsLocally) {
                        onWorkspaceMapping(ws.workspaceSlug, { action: 'merge', targetWorkspaceId: ws.localWorkspaceId })
                      } else if (newAction === 'merge') {
                        onWorkspaceMapping(ws.workspaceSlug, { action: 'merge', targetWorkspaceId: localWorkspaces[0]?.id })
                      } else if (newAction === 'create') {
                        onWorkspaceMapping(ws.workspaceSlug, { action: 'create', newWorkspaceName: ws.workspaceName })
                      } else {
                        onWorkspaceMapping(ws.workspaceSlug, { action: 'skip' })
                      }
                    }}
                    className="text-xs border border-border rounded px-2 py-1 bg-background"
                  >
                    {ws.existsLocally && (
                      <option value="merge">合并到已有工作区</option>
                    )}
                    {!ws.existsLocally && localWorkspaces.length > 0 && (
                      <option value="merge">合并到现有工作区...</option>
                    )}
                    <option value="create">创建新工作区</option>
                    <option value="skip">跳过</option>
                  </select>

                  {action === 'merge' && !ws.existsLocally && (
                    <select
                      value={mapping?.targetWorkspaceId ?? ''}
                      onChange={(e) => onWorkspaceMapping(ws.workspaceSlug, { action: 'merge', targetWorkspaceId: e.target.value })}
                      className="text-xs border border-border rounded px-2 py-1 bg-background"
                    >
                      <option value="">选择工作区...</option>
                      {localWorkspaces.map((lw) => (
                        <option key={lw.id} value={lw.id}>{lw.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {hasConflicts && (
        <div className="flex items-start gap-3 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 dark:bg-amber-950/20 dark:border-amber-800">
          <AlertTriangle size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              检测到同名 Skills / MCP 已存在于本地
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-amber-600 dark:text-amber-500">冲突处理：</span>
              <select
                value={conflictResolution}
                onChange={(e) => onConflictResolutionChange(e.target.value as 'overwrite' | 'skip')}
                className="text-xs border border-amber-300 dark:border-amber-700 rounded px-2 py-1 bg-background"
              >
                <option value="overwrite">用导入版本覆盖本地（推荐）</option>
                <option value="skip">保留本地版本，跳过冲突项</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}
