/**
 * sidebar-dialogs.tsx — 侧边栏弹窗（新建项目/删除项目/迁移会话）
 *
 * 从 LeftSidebar 抽离的弹窗，通过 hook 返回值（SidebarModel）读取状态，
 * collapsed / expanded 两个视图共享同一实例，避免 Radix Portal 双实例叠遮罩。
 *
 * 新建项目分成三条入口（设计 §6.1 / §6.2）：
 * - 绑定项目文件夹：选本地目录 → createProjectWorkspace，目录里的文件留在原处；
 * - 打开已有项目：选本地目录 → openProjectWorkspace，已有 `.profer` 时识别为 Profer 项目；
 * - Profer 托管目录：旧行为，输入名称后在 Profer 数据目录里新建。
 */

import * as React from 'react'
import { FolderOpen, FolderPlus, HardDrive } from 'lucide-react'
import { MoveSessionDialog } from '@/components/agent/MoveSessionDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@profer/ui/primitives/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@profer/ui/primitives/dialog'
import { Button } from '@profer/ui/primitives/button'
import { cn } from '@/lib/utils'
import type { AgentWorkspace } from '@profer/shared'
import type { SidebarModel } from './use-left-sidebar'

/** 新建弹窗当前的入口状态 */
export type CreateProjectMode = 'choose' | 'managed'

/** 项目移除/删除弹窗的文案（project 与 managed 是两种完全不同的动作） */
export interface WorkspaceRemovalCopy {
  title: string
  description: string
  confirmLabel: string
  pendingLabel: string
  /** 是否使用危险色：project 只是移除绑定，不销毁数据 */
  destructive: boolean
}

/**
 * 项目移除 vs 工作区删除的文案。
 *
 * project 只删索引：项目文件、`.profer`、中央会话数据都保留（I2）；
 * managed 仍是彻底删除工作区及其资源，保留原文案与危险色。
 */
export function getWorkspaceRemovalCopy(workspace: AgentWorkspace | null): WorkspaceRemovalCopy {
  const name = workspace?.name ?? '该项目'
  if (workspace?.storageMode === 'project') {
    return {
      title: '从 Profer 移除项目',
      description: `将从 Profer 列表中移除「${name}」。不会删除项目文件或 .profer 目录，之后可以重新绑定这个文件夹。`,
      confirmLabel: '从 Profer 移除',
      pendingLabel: '移除中...',
      destructive: false,
    }
  }
  return {
    title: '确认删除项目',
    description: `将删除「${name}」及其绑定的所有会话、自动任务、MCP、Skills、工作区文件和本地项目目录。附加目录和附加文件只会移除引用，不会删除原始文件。删除后无法恢复。`,
    confirmLabel: '删除项目',
    pendingLabel: '删除中...',
    destructive: true,
  }
}

interface ProjectEntryOptionProps {
  testId: string
  icon: React.ReactNode
  title: string
  description: string
  disabled?: boolean
  onClick: () => void
}

/** 新建弹窗里的入口行：标题 + 一句解释，整行可点 */
function ProjectEntryOption({
  testId,
  icon,
  title,
  description,
  disabled,
  onClick,
}: ProjectEntryOptionProps): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg border border-border/60 px-3 py-2 text-left transition-colors',
        'hover:border-border hover:bg-foreground/[0.04]',
        'disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      <span className="mt-0.5 flex-shrink-0 text-foreground/45">{icon}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <span className="text-[11px] leading-4 text-foreground/45">{description}</span>
      </span>
    </button>
  )
}

/** 新建项目弹窗主体（与 Radix 壳分离，便于 SSR 下直接渲染做文案/分支测试） */
export interface CreateProjectDialogBodyProps {
  mode: CreateProjectMode
  name: string
  busy: boolean
  onModeChange: (mode: CreateProjectMode) => void
  onNameChange: (name: string) => void
  onBindFolder: () => void
  onOpenFolder: () => void
  onManagedSubmit: () => void
  onNameKeyDown: (event: React.KeyboardEvent) => void
}

export function CreateProjectDialogBody({
  mode,
  name,
  busy,
  onModeChange,
  onNameChange,
  onBindFolder,
  onOpenFolder,
  onManagedSubmit,
  onNameKeyDown,
}: CreateProjectDialogBodyProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5" data-testid="create-project-options">
      <ProjectEntryOption
        testId="create-project-bind-folder"
        icon={<FolderPlus size={15} />}
        title="绑定项目文件夹"
        description="选一个本地文件夹作为项目根，Profer 在其中生成 .profer 配置；代码和文件都留在原处"
        disabled={busy}
        onClick={onBindFolder}
      />
      <ProjectEntryOption
        testId="create-project-open-folder"
        icon={<FolderOpen size={15} />}
        title="打开已有项目"
        description="选择已有的项目文件夹；带 .profer 的项目会被识别并沿用原有配置"
        disabled={busy}
        onClick={onOpenFolder}
      />
      {mode === 'managed' ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
          <HardDrive size={15} className="flex-shrink-0 text-foreground/45" />
          <input
            autoFocus
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={onNameKeyDown}
            placeholder="项目名称..."
            aria-label="托管项目名称"
            data-testid="create-project-managed-name"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-foreground/30"
            maxLength={50}
          />
          <Button
            size="sm"
            variant="default"
            data-testid="create-project-managed-submit"
            disabled={busy || name.trim().length === 0}
            onClick={onManagedSubmit}
          >
            创建
          </Button>
        </div>
      ) : (
        <ProjectEntryOption
          testId="create-project-managed"
          icon={<HardDrive size={15} />}
          title="Profer 托管目录"
          description="在 Profer 数据目录里新建托管工作区（原有方式），不在本地建目录"
          disabled={busy}
          onClick={() => onModeChange('managed')}
        />
      )}
    </div>
  )
}

export function SidebarDialogs({ s }: { s: SidebarModel }): React.ReactElement {
  const {
    pendingDeleteId,
    pendingDeleteDelegatedChildCount,
    setPendingDeleteId,
    handleConfirmDelete,
    pendingDeleteWorkspaceId,
    setPendingDeleteWorkspaceId,
    deletingWorkspaceId,
    pendingDeleteWorkspace,
    handleConfirmDeleteWorkspace,
    moveTargetId,
    setMoveTargetId,
    currentWorkspaceId,
    workspaces,
    handleSessionMoved,
    createProjectDialogOpen,
    handleCreateProjectDialogOpenChange,
    createProjectMode,
    setCreateProjectMode,
    newProjectName,
    setNewProjectName,
    handleBindProjectFolder,
    handleOpenProjectFolder,
    handleCreateProject,
    handleCreateProjectKeyDown,
    projectPickerBusy,
  } = s

  const removalCopy = getWorkspaceRemovalCopy(pendingDeleteWorkspace)

  return (
    <>
      {/* 删除确认弹窗（collapsed/expanded 共享） */}
      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => { if (!open) setPendingDeleteId(null) }}
      >
        <AlertDialogContent
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleConfirmDelete()
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除对话</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteDelegatedChildCount > 0
                ? `删除后将无法恢复，并将同时永久删除 ${pendingDeleteDelegatedChildCount} 个协作子会话。`
                : '删除后将无法恢复，确定要删除这个对话吗？'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 新建项目弹窗：选择绑定文件夹 / 打开已有项目 / Profer 托管目录 */}
      <Dialog open={createProjectDialogOpen} onOpenChange={handleCreateProjectDialogOpenChange}>
        <DialogContent className="max-w-[420px] gap-3 p-4" data-testid="create-project-dialog">
          <DialogHeader className="gap-1">
            <DialogTitle className="text-[15px]">新建项目</DialogTitle>
            <DialogDescription className="text-[11px] leading-4 text-foreground/45">
              项目可以是任意本地文件夹，也可以放在 Profer 数据目录下托管。
            </DialogDescription>
          </DialogHeader>
          <CreateProjectDialogBody
            mode={createProjectMode}
            name={newProjectName}
            busy={projectPickerBusy}
            onModeChange={setCreateProjectMode}
            onNameChange={setNewProjectName}
            onBindFolder={() => { void handleBindProjectFolder() }}
            onOpenFolder={() => { void handleOpenProjectFolder() }}
            onManagedSubmit={() => { void handleCreateProject() }}
            onNameKeyDown={handleCreateProjectKeyDown}
          />
        </DialogContent>
      </Dialog>

      {/* 项目移除/删除确认弹窗：project 只移除绑定，managed 彻底删除 */}
      <AlertDialog
        open={pendingDeleteWorkspaceId !== null}
        onOpenChange={(open) => {
          if (!open && !deletingWorkspaceId) setPendingDeleteWorkspaceId(null)
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => event.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !deletingWorkspaceId) {
              e.preventDefault()
              void handleConfirmDeleteWorkspace()
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{removalCopy.title}</AlertDialogTitle>
            <AlertDialogDescription>{removalCopy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!deletingWorkspaceId}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!deletingWorkspaceId}
              onClick={handleConfirmDeleteWorkspace}
              data-testid="confirm-workspace-removal"
              className={cn(
                removalCopy.destructive
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90',
              )}
            >
              {deletingWorkspaceId ? removalCopy.pendingLabel : removalCopy.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 迁移会话对话框（collapsed/expanded 共享） */}
      <MoveSessionDialog
        open={moveTargetId !== null}
        onOpenChange={(open) => { if (!open) setMoveTargetId(null) }}
        sessionId={moveTargetId ?? ''}
        currentWorkspaceId={currentWorkspaceId ?? undefined}
        workspaces={workspaces}
        onMoved={handleSessionMoved}
      />

    </>
  )
}
