/**
 * useProjectActions — 项目切换与创建的共享逻辑
 *
 * UI 层把 AgentWorkspace 展示为“项目”。底层类型和 IPC 仍沿用 workspace
 * 命名，这里只把对展示组件暴露的动作语义收敛到 project。
 *
 * 创建入口分三条互不相同的路径（设计 §6.1 / §6.2）：
 * - 托管目录（managed）：`createAgentWorkspace`，目录由 Profer 数据目录派生；
 * - 绑定项目文件夹（project）：选目录 → `createProjectWorkspace`，目录不存在绑定；
 * - 打开已有项目（project）：选目录 → `openProjectWorkspace`，已绑定时复用。
 *
 * 由于弹窗/侧边栏/折叠浮层都要走同样的顺序，IPC 编排抽成不依赖 React 的函数，
 * 由调用方注入 electronAPI，便于单元测试直接驱动「取消 / 成功 / 失败」分支。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  agentWorkspacesAtom,
  currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { getVisibleAgentWorkspaces } from '@/lib/product-feature-flags'
import type { AgentWorkspace, ProjectWorkspaceErrorCode, ProjectWorkspaceOpenResult } from '@profer/shared'

/** 项目配置目录名（与主进程 PROJECT_CONFIG_DIR_NAME 对齐） */
export const PROJECT_CONFIG_DIR_NAME = '.profer'

/**
 * 已知错误码的友好文案。
 *
 * 主进程 message 已经面向用户，但会带路径/探针目录等实现细节；UI 只展示分类文案，
 * 具体细节保留在 `parseProjectWorkspaceError().text` 里供诊断。
 * 类型约束保证 `ProjectWorkspaceErrorCode` 新增分类时这里必须补齐。
 */
export const PROJECT_WORKSPACE_ERROR_COPY = {
  'path-not-absolute': '项目路径必须是绝对路径',
  'path-not-found': '项目文件夹不存在或已被移动',
  'path-not-directory': '所选路径不是文件夹',
  'path-not-writable': '项目文件夹不可写，请检查权限后再试',
  'path-is-filesystem-root': '不能把磁盘根目录绑定为项目',
  'path-inside-config-dir': '不能把 Profer 配置目录设为项目',
  'already-bound': '该文件夹已绑定为其他项目',
  'manifest-invalid': '项目配置已损坏，已停止写入以避免覆盖',
  'not-a-project-workspace': '该工作区不是项目模式',
  'workspace-not-found': '项目不存在或已被移除',
} satisfies Record<ProjectWorkspaceErrorCode, string>

/** 运行时校验：老/新版本主进程可能给出本端不认识的 code，未知时不能当已知分类展示。 */
function isProjectWorkspaceErrorCode(value: string): value is ProjectWorkspaceErrorCode {
  return Object.prototype.hasOwnProperty.call(PROJECT_WORKSPACE_ERROR_COPY, value)
}

/**
 * 解析项目工作区错误文案。
 *
 * 主进程在 IPC 边界把 `ProjectWorkspaceError.code` 编码成
 * `[PROJECT:<code>] <原始 message>`（见 apps/electron/src/main/ipc.ts），
 * Electron 再把整条 message 包成
 * `Error invoking remote method 'agent:xxx': Error: <message>`。
 *
 * 纯函数：不读全局状态，也不依赖 Electron，因此可以直接单测。
 * - `code`：能识别出的稳定分类；旧版主进程 / 非项目错误 / 未识别的码为 undefined；
 * - `text`：剥掉包装前缀后的原始文案（保留细节，供日志与未知错误直接展示）。
 */
export function parseProjectWorkspaceError(message: string | null | undefined): {
  code?: ProjectWorkspaceErrorCode
  text: string
} {
  const raw = message ?? ''
  const unwrapped = raw
    .replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '')
    .trim()
  const tagged = /^\[PROJECT:([a-z-]+)\]\s*([\s\S]*)$/.exec(unwrapped)
  if (!tagged) return { text: unwrapped }
  const code = tagged[1] ?? ''
  const text = (tagged[2] ?? '').trim()
  return {
    ...(isProjectWorkspaceErrorCode(code) ? { code: code } : {}),
    text,
  }
}

/**
 * 清洗 IPC 错误文案。
 *
 * `ipcRenderer.invoke` 抛错时会把主进程 message 包成
 * `Error invoking remote method 'agent:xxx': Error: 真实文案`。
 * 用户只需要真实文案，前缀属于实现细节（要求 6：按 IPC message 展示）。
 *
 * P2-A：带 `[PROJECT:<code>]` 前缀的错误优先映射到分类文案；没有 code（未知错误）
 * 仍然展示原始文案，保持 P1-D 的既有行为。
 */
export function toProjectErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const { code, text } = parseProjectWorkspaceError(raw)
  if (code) return PROJECT_WORKSPACE_ERROR_COPY[code]
  return text || fallback
}

/** 拼接项目根下的 `.profer` 路径；只做展示/探测用，不做路径归一化。 */
export function joinProjectConfigPath(rootPath: string): string {
  const trimmed = rootPath.replace(/[/\\]+$/, '')
  if (!trimmed) return PROJECT_CONFIG_DIR_NAME
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  return `${trimmed}${separator}${PROJECT_CONFIG_DIR_NAME}`
}

/**
 * 项目路径的短展示：保留末尾 `maxSegments` 段。
 *
 * 侧栏宽度只有 200 多 px，完整路径必然截断；用 CSS 尾部省略会丢掉最有辨识度的
 * 目录名，所以这里从头部裁，末尾（项目名）始终可见。
 */
export function formatProjectRootPath(rootPath: string, maxSegments = 2): string {
  const trimmed = rootPath.trim()
  if (!trimmed) return ''
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  const parts = trimmed.split(/[/\\]+/).filter(Boolean)
  if (parts.length <= maxSegments) return `${separator === '\\' ? '' : '/'}${parts.join(separator)}`
  const tail = parts.slice(-maxSegments).join(separator)
  return `…${separator}${tail}`
}

/** 项目创建/打开所依赖的 IPC 能力（测试可注入假实现） */
export interface ProjectPickerDeps {
  /** 系统目录选择器；取消返回 null */
  selectFolder: () => Promise<string | null>
  createProjectWorkspace: (input: { rootPath: string; name?: string }) => Promise<ProjectWorkspaceOpenResult>
  openProjectWorkspace: (input: { rootPath: string; name?: string }) => Promise<ProjectWorkspaceOpenResult>
  /** 探测路径类型（存在性）；不存在的路径不会出现在返回数组里 */
  checkPathsType: (paths: string[]) => Promise<{ directories: string[]; files: string[] }>
  /** 仅用于「重新定位」：保留工作区 id/slug，只把 rootPath 指向新目录 */
  relocateProjectWorkspace: (input: { id: string; rootPath: string }) => Promise<ProjectWorkspaceOpenResult>
  /** 仅用于「重新定位」的旧链路（已由 relocateProjectWorkspace 取代，保留兼容） */
  removeProjectWorkspace: (id: string) => Promise<void>
}

/**
 * 选目录流程的结果。
 *
 * - `cancelled`：用户在系统弹窗里取消，调用方不得做任何状态变更；
 * - `opened`：已拿到工作区（`recognized` 表示目标目录原本就有 `.profer`）；
 * - `failed`：已 toast 的失败，message 是清洗后的 IPC 文案。
 */
export type ProjectPickOutcome =
  | { kind: 'cancelled' }
  | {
    kind: 'opened'
    result: ProjectWorkspaceOpenResult
    /** 选择前目标目录是否已存在 `.profer` */
    recognized: boolean
    /** 重新定位时移除旧绑定失败的非致命说明 */
    cleanupError?: string
  }
  | { kind: 'failed'; message: string }

async function hasProjectConfigDir(deps: ProjectPickerDeps, rootPath: string): Promise<boolean> {
  const configPath = joinProjectConfigPath(rootPath)
  try {
    const { directories } = await deps.checkPathsType([configPath])
    return directories.includes(configPath)
  } catch {
    // 探测失败不当成“没有骨架”，后续 open 会给出真实错误
    return false
  }
}

/** 选择文件夹并绑定为项目（新建入口的「绑定项目文件夹」） */
export async function bindProjectFolderFromPicker(
  deps: ProjectPickerDeps,
  options: { name?: string } = {},
): Promise<ProjectPickOutcome> {
  let rootPath: string | null
  try {
    rootPath = await deps.selectFolder()
  } catch (error) {
    return { kind: 'failed', message: toProjectErrorMessage(error, '无法打开文件夹选择器') }
  }
  // 取消：不动任何状态（要求 1）
  if (!rootPath) return { kind: 'cancelled' }

  const recognized = await hasProjectConfigDir(deps, rootPath)
  try {
    const result = await deps.createProjectWorkspace({ rootPath, name: options.name })
    return { kind: 'opened', result, recognized }
  } catch (error) {
    return { kind: 'failed', message: toProjectErrorMessage(error, '绑定项目文件夹失败') }
  }
}

/** 选择文件夹并打开已有项目（已绑定则复用，原有 `.profer` 只补缺失项） */
export async function openProjectFolderFromPicker(
  deps: ProjectPickerDeps,
): Promise<ProjectPickOutcome> {
  let rootPath: string | null
  try {
    rootPath = await deps.selectFolder()
  } catch (error) {
    return { kind: 'failed', message: toProjectErrorMessage(error, '无法打开文件夹选择器') }
  }
  if (!rootPath) return { kind: 'cancelled' }

  const recognized = await hasProjectConfigDir(deps, rootPath)
  try {
    const result = await deps.openProjectWorkspace({ rootPath })
    return { kind: 'opened', result, recognized }
  } catch (error) {
    return { kind: 'failed', message: toProjectErrorMessage(error, '打开项目失败') }
  }
}

/**
 * 重新定位失效项目：选新目录 → 打开（或复用已绑定）→ 移除旧索引。
 *
 * 只在用户明确点击「重新定位」时调用；绝不自动重建原目录（I4）。
 */
export async function relocateProjectFromPicker(
  deps: ProjectPickerDeps,
  target: { id: string; name: string },
): Promise<ProjectPickOutcome> {
  let rootPath: string | null
  try {
    rootPath = await deps.selectFolder()
  } catch (error) {
    return { kind: 'failed', message: toProjectErrorMessage(error, '无法打开文件夹选择器') }
  }
  if (!rootPath) return { kind: 'cancelled' }

  const recognized = await hasProjectConfigDir(deps, rootPath)
  try {
    // 保留旧 id/slug：会话、定时任务、Todo、子会话都按 id 归属，换 id 会让它们集体失效。
    const result = await deps.relocateProjectWorkspace({ id: target.id, rootPath })
    return { kind: 'opened', result, recognized }
  } catch (error) {
    return { kind: 'failed', message: toProjectErrorMessage(error, '重新定位项目失败') }
  }
}

/** 渲染进程侧默认依赖：直接转发 preload 暴露的方法 */
export function createProjectPickerDeps(): ProjectPickerDeps {
  return {
    selectFolder: () => window.electronAPI.selectProjectFolder(),
    createProjectWorkspace: (input) => window.electronAPI.createProjectWorkspace(input),
    openProjectWorkspace: (input) => window.electronAPI.openProjectWorkspace(input),
    checkPathsType: (paths) => window.electronAPI.checkPathsType(paths),
    relocateProjectWorkspace: (input) => window.electronAPI.relocateProjectWorkspace(input),
    removeProjectWorkspace: (id) => window.electronAPI.removeProjectWorkspace(id),
  }
}

interface UseProjectActionsResult {
  /** 当前产品 UI 可切换的工作区；团队工作区在隐藏开关关闭时不返回。 */
  workspaces: AgentWorkspace[]
  /** 完整工作区列表，仅供需要保持底层索引完整的写操作使用。 */
  allWorkspaces: AgentWorkspace[]
  currentWorkspaceId: string | null
  /** 切换到指定项目；已是当前项目时无副作用。默认切回对话视图，resetView:false 可保持当前视图（如停留在 Agent 技能） */
  selectProject: (workspaceId: string, opts?: { resetView?: boolean }) => void
  /** 在 Profer 数据目录下新建托管工作区（旧行为）；成功返回新项目，失败已 toast 并返回 null */
  createProject: (name: string) => Promise<AgentWorkspace | null>
  /** 绑定本地文件夹为项目；用户取消返回 null，失败已 toast */
  bindProjectFolder: () => Promise<AgentWorkspace | null>
  /** 打开已有项目文件夹（含 .profer 时识别为 Profer 项目）；用户取消返回 null */
  openProjectFolder: () => Promise<AgentWorkspace | null>
}

export function useProjectActions(): UseProjectActionsResult {
  const [allWorkspaces, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const workspaces = React.useMemo(
    () => getVisibleAgentWorkspaces(allWorkspaces),
    [allWorkspaces],
  )
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentAgentWorkspaceIdAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const createInFlightRef = React.useRef(false)

  const selectProject = React.useCallback(
    (workspaceId: string, opts?: { resetView?: boolean }): void => {
      const workspace = allWorkspaces.find((item) => item.id === workspaceId)
      if (!workspace || !getVisibleAgentWorkspaces([workspace]).length) return
      if (workspaceId === currentWorkspaceId) return
      setCurrentWorkspaceId(workspaceId)
      if (opts?.resetView !== false) setActiveView('conversations')
      window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(console.error)
    },
    [allWorkspaces, currentWorkspaceId, setCurrentWorkspaceId, setActiveView],
  )

  const applyOpenedWorkspace = React.useCallback(
    (workspace: AgentWorkspace): void => {
      setWorkspaces((prev) => (
        prev.some((item) => item.id === workspace.id)
          ? prev.map((item) => (item.id === workspace.id ? workspace : item))
          : [workspace, ...prev]
      ))
      setCurrentWorkspaceId(workspace.id)
      setActiveView('conversations')
      window.electronAPI.updateSettings({ agentWorkspaceId: workspace.id }).catch(console.error)
    },
    [setWorkspaces, setCurrentWorkspaceId, setActiveView],
  )

  const createProject = React.useCallback(
    async (name: string): Promise<AgentWorkspace | null> => {
      const trimmed = name.trim()
      if (!trimmed) return null
      if (createInFlightRef.current) return null
      createInFlightRef.current = true

      try {
        const workspace = await window.electronAPI.createAgentWorkspace(trimmed)
        applyOpenedWorkspace(workspace)
        return workspace
      } catch (error) {
        toast.error(toProjectErrorMessage(error, '创建失败'))
        return null
      } finally {
        createInFlightRef.current = false
      }
    },
    [applyOpenedWorkspace],
  )

  const runPick = React.useCallback(
    async (
      pick: (deps: ProjectPickerDeps) => Promise<ProjectPickOutcome>,
    ): Promise<AgentWorkspace | null> => {
      if (createInFlightRef.current) return null
      createInFlightRef.current = true
      try {
        const outcome = await pick(createProjectPickerDeps())
        if (outcome.kind === 'cancelled') return null
        if (outcome.kind === 'failed') {
          toast.error(outcome.message)
          return null
        }
        const { result, recognized } = outcome
        applyOpenedWorkspace(result.workspace)
        if (recognized) {
          toast.success('已识别 Profer 项目', {
            description: result.created
              ? `已加入「${result.workspace.name}」，沿用既有的 .profer 配置`
              : `已切换到「${result.workspace.name}」`,
          })
        } else if (result.created) {
          toast.success('项目已绑定', {
            description: `已为「${result.workspace.name}」生成 .profer 配置`,
          })
        } else {
          toast.success('项目已在列表中', {
            description: `已切换到「${result.workspace.name}」`,
          })
        }
        for (const warning of result.warnings) toast.warning(warning)
        return result.workspace
      } finally {
        createInFlightRef.current = false
      }
    },
    [applyOpenedWorkspace],
  )

  const bindProjectFolder = React.useCallback(
    () => runPick((deps) => bindProjectFolderFromPicker(deps)),
    [runPick],
  )

  const openProjectFolder = React.useCallback(
    () => runPick((deps) => openProjectFolderFromPicker(deps)),
    [runPick],
  )

  return {
    workspaces,
    allWorkspaces,
    currentWorkspaceId,
    selectProject,
    createProject,
    bindProjectFolder,
    openProjectFolder,
  }
}
