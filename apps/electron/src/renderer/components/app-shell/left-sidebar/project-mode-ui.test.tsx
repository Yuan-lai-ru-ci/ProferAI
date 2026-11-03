import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentWorkspace, ProjectWorkspaceOpenResult } from '@profer/shared'
import {
  bindProjectFolderFromPicker,
  formatProjectRootPath,
  joinProjectConfigPath,
  openProjectFolderFromPicker,
  relocateProjectFromPicker,
  toProjectErrorMessage,
  type ProjectPickerDeps,
} from '@/hooks/useProjectActions'
import { CreateProjectDialogBody, getWorkspaceRemovalCopy } from './sidebar-dialogs'
import { AgentProjectGroupItem, getWorkspaceRemoveMenuLabel } from './session-items'

/**
 * P1-D「创建/打开项目」UI 契约：
 * - 入口分支（绑定文件夹 / 打开已有 / 托管目录）与取消语义；
 * - project 行的 `.profer` 徽标 + 路径副标题；
 * - 路径失效时给出「项目路径不可用 / 重新定位 / 从列表移除」；
 * - 移除文案与 managed 的删除文案必须分家。
 */

const projectWorkspace = (overrides: Partial<AgentWorkspace> = {}): AgentWorkspace => ({
  id: 'ws-project',
  name: 'demo-app',
  slug: 'demo-app',
  createdAt: 1,
  updatedAt: 1,
  type: 'personal',
  storageMode: 'project',
  rootPath: '/Users/mac/code/demo-app',
  ...overrides,
})

const openResult = (
  workspace: AgentWorkspace,
  overrides: Partial<ProjectWorkspaceOpenResult> = {},
): ProjectWorkspaceOpenResult => ({
  workspace,
  created: true,
  warnings: [],
  ...overrides,
})

function createDeps(overrides: Partial<ProjectPickerDeps> = {}): {
  deps: ProjectPickerDeps
  calls: string[]
} {
  const calls: string[] = []
  // 录制层包在默认实现外面：测试只替换行为，调用记录始终生效
  const raw: ProjectPickerDeps = {
    selectFolder: async () => '/Users/mac/code/demo-app',
    createProjectWorkspace: async () => openResult(projectWorkspace()),
    openProjectWorkspace: async () => openResult(projectWorkspace()),
    checkPathsType: async () => ({ directories: [], files: [] }),
    relocateProjectWorkspace: async () => openResult(projectWorkspace()),
    removeProjectWorkspace: async () => {},
    ...overrides,
  }
  const deps: ProjectPickerDeps = {
    selectFolder: async () => {
      calls.push('selectFolder')
      return raw.selectFolder()
    },
    createProjectWorkspace: async (input) => {
      calls.push(`create:${input.rootPath}`)
      return raw.createProjectWorkspace(input)
    },
    openProjectWorkspace: async (input) => {
      calls.push(`open:${input.rootPath}`)
      return raw.openProjectWorkspace(input)
    },
    checkPathsType: async (paths) => {
      calls.push(`check:${paths.join(',')}`)
      return raw.checkPathsType(paths)
    },
    removeProjectWorkspace: async (id) => {
      calls.push(`remove:${id}`)
      return raw.removeProjectWorkspace(id)
    },
    relocateProjectWorkspace: async (input) => {
      calls.push(`relocate:${input.id}:${input.rootPath}`)
      return raw.relocateProjectWorkspace(input)
    },
  }
  return { deps, calls }
}

describe('项目路径工具', () => {
  test('Given 深层绝对路径 When 短展示 Then 保留末尾两段并前置省略号', () => {
    expect(formatProjectRootPath('/Users/mac/code/demo-app')).toBe('…/code/demo-app')
    expect(formatProjectRootPath('/tmp')).toBe('/tmp')
  })

  test('Given 目录带尾部分隔符 When 拼 .profer Then 不产生双斜杠', () => {
    expect(joinProjectConfigPath('/Users/mac/code/demo-app/')).toBe('/Users/mac/code/demo-app/.profer')
    expect(joinProjectConfigPath('/tmp')).toBe('/tmp/.profer')
  })

  test('Given Electron 包装过的 IPC 错误 When 清洗 Then 只留主进程文案', () => {
    const raw = new Error(
      "Error invoking remote method 'agent:create-project-workspace': Error: 该文件夹已绑定为项目「demo」：/tmp/demo",
    )
    expect(toProjectErrorMessage(raw, '兜底')).toBe('该文件夹已绑定为项目「demo」：/tmp/demo')
    expect(toProjectErrorMessage(new Error('  '), '兜底')).toBe('兜底')
  })
})

describe('绑定项目文件夹分支', () => {
  test('Given 用户在目录选择器取消 When 绑定 Then 不调用任何绑定 IPC', async () => {
    let created = 0
    const { deps } = createDeps({
      selectFolder: async () => null,
      createProjectWorkspace: async () => {
        created += 1
        return openResult(projectWorkspace())
      },
    })

    const outcome = await bindProjectFolderFromPicker(deps)

    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(created).toBe(0)
  })

  test('Given 空目录 When 绑定 Then 走 createProjectWorkspace 且标记为非已有项目', async () => {
    const { deps, calls } = createDeps()
    const outcome = await bindProjectFolderFromPicker(deps)

    expect(outcome.kind).toBe('opened')
    expect(calls).toContain('create:/Users/mac/code/demo-app')
    expect(outcome.kind === 'opened' && outcome.recognized).toBe(false)
  })

  test('Given 目录里已有 .profer When 绑定 Then 识别为已有 Profer 项目', async () => {
    const { deps } = createDeps({
      checkPathsType: async () => ({
        directories: ['/Users/mac/code/demo-app/.profer'],
        files: [],
      }),
    })

    const outcome = await bindProjectFolderFromPicker(deps)

    expect(outcome.kind).toBe('opened')
    expect(outcome.kind === 'opened' && outcome.recognized).toBe(true)
  })

  test('Given 主进程拒绝（已绑定） When 绑定 Then 透出清洗后的 IPC 文案', async () => {
    const { deps } = createDeps({
      createProjectWorkspace: async () => {
        throw new Error(
          "Error invoking remote method 'agent:create-project-workspace': Error: 该文件夹已绑定为项目「demo」：/Users/mac/code/demo-app",
        )
      },
    })

    const outcome = await bindProjectFolderFromPicker(deps)

    expect(outcome).toEqual({
      kind: 'failed',
      message: '该文件夹已绑定为项目「demo」：/Users/mac/code/demo-app',
    })
  })
})

describe('打开已有项目分支', () => {
  test('Given 已绑定目录 When 打开 Then 复用既有工作区（created=false）', async () => {
    const existing = projectWorkspace({ id: 'ws-existing' })
    const { deps, calls } = createDeps({
      openProjectWorkspace: async () => openResult(existing, { created: false }),
    })

    const outcome = await openProjectFolderFromPicker(deps)

    expect(outcome.kind).toBe('opened')
    expect(outcome.kind === 'opened' && outcome.result.workspace.id).toBe('ws-existing')
    expect(outcome.kind === 'opened' && outcome.result.created).toBe(false)
    expect(calls).toContain('open:/Users/mac/code/demo-app')
  })

  test('Given 用户取消 When 打开 Then 返回 cancelled', async () => {
    const { deps, calls } = createDeps({ selectFolder: async () => null })

    const outcome = await openProjectFolderFromPicker(deps)

    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(calls).toEqual(['selectFolder'])
  })
})

describe('重新定位失效项目', () => {
  test('Given 新目录绑定成功 When 重新定位 Then 保留旧 id 只换 rootPath，不再新建+删旧', async () => {
    const relocated = projectWorkspace({ id: 'ws-project', rootPath: '/Users/mac/code/demo-app-moved' })
    const { deps, calls } = createDeps({
      relocateProjectWorkspace: async () => openResult(relocated, { created: false }),
    })

    const outcome = await relocateProjectFromPicker(deps, { id: 'ws-project', name: 'demo-app' })

    expect(outcome.kind).toBe('opened')
    expect(calls).toContain('relocate:ws-project:/Users/mac/code/demo-app')
    expect(calls.some((call) => call.startsWith('open:'))).toBe(false)
    expect(calls.some((call) => call.startsWith('remove:'))).toBe(false)
  })

  test('Given 选回同一路径 When 重新定位 Then 幂等更新绑定，不重复移除', async () => {
    const { deps, calls } = createDeps()

    await relocateProjectFromPicker(deps, { id: 'ws-project', name: 'demo-app' })

    expect(calls).toContain('relocate:ws-project:/Users/mac/code/demo-app')
    expect(calls.some((call) => call.startsWith('remove:'))).toBe(false)
  })

  test('Given 用户取消 When 重新定位 Then 不打开也不移除', async () => {
    const { deps, calls } = createDeps({ selectFolder: async () => null })

    const outcome = await relocateProjectFromPicker(deps, { id: 'ws-project', name: 'demo-app' })

    expect(outcome).toEqual({ kind: 'cancelled' })
    expect(calls).toEqual(['selectFolder'])
  })
})

describe('移除文案', () => {
  test('Given project 工作区 When 取移除文案 Then 强调不删项目文件与 .profer', () => {
    const copy = getWorkspaceRemovalCopy(projectWorkspace())

    expect(copy.title).toBe('从 Profer 移除项目')
    expect(copy.confirmLabel).toBe('从 Profer 移除')
    expect(copy.description).toContain('不会删除项目文件或 .profer')
    expect(copy.destructive).toBe(false)
  })

  test('Given managed 工作区 When 取删除文案 Then 保持删除措辞与危险色', () => {
    const copy = getWorkspaceRemovalCopy(projectWorkspace({ storageMode: 'managed', rootPath: undefined }))

    expect(copy.title).toBe('确认删除项目')
    expect(copy.confirmLabel).toBe('删除项目')
    expect(copy.destructive).toBe(true)
  })
})

describe('新建项目弹窗分支', () => {
  test('Given 入口选择态 When 渲染 Then 同时提供绑定文件夹 / 打开已有 / 托管目录', () => {
    const html = renderToStaticMarkup(
      <CreateProjectDialogBody
        mode="choose"
        name=""
        busy={false}
        onModeChange={() => {}}
        onNameChange={() => {}}
        onBindFolder={() => {}}
        onOpenFolder={() => {}}
        onManagedSubmit={() => {}}
        onNameKeyDown={() => {}}
      />,
    )

    expect(html).toContain('create-project-bind-folder')
    expect(html).toContain('create-project-open-folder')
    expect(html).toContain('create-project-managed')
    expect(html).toContain('绑定项目文件夹')
    expect(html).toContain('打开已有项目')
    expect(html).toContain('Profer 托管目录')
  })

  test('Given 选中托管目录 When 渲染 Then 出现名称输入而非托管入口行', () => {
    const html = renderToStaticMarkup(
      <CreateProjectDialogBody
        mode="managed"
        name="my-space"
        busy={false}
        onModeChange={() => {}}
        onNameChange={() => {}}
        onBindFolder={() => {}}
        onOpenFolder={() => {}}
        onManagedSubmit={() => {}}
        onNameKeyDown={() => {}}
      />,
    )

    expect(html).toContain('create-project-managed-name')
    expect(html).toContain('my-space')
    expect(html).not.toContain('data-testid="create-project-managed"')
  })
})

function renderProjectGroup(options: {
  workspace: AgentWorkspace
  pathStatus?: 'ok' | 'missing' | 'unknown'
}): string {
  const store = createStore()
  return renderToStaticMarkup(
    <Provider store={store}>
      <AgentProjectGroupItem
        group={{ workspace: options.workspace, sessions: [] }}
        currentWorkspaceId={options.workspace.id}
        expanded={false}
        collapsed={false}
        extraCount={0}
        activeSessionId={null}
        agentIndicatorMap={new Map()}
        agentDraftIds={new Set()}
        expandedRelatedParentIds={new Set()}
        relativeTimeNow={1}
        dragging={false}
        dropPosition={null}
        onShowMore={() => {}}
        onCollapseExtra={() => {}}
        onSelectProject={() => {}}
        onToggleProjectCollapse={() => {}}
        onNewSession={async () => {}}
        onDragStart={() => {}}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        onDragEnd={() => {}}
        onToggleArchiveWorkspace={() => {}}
        onRenameWorkspace={async () => {}}
        onRequestDeleteWorkspace={() => {}}
        canDeleteWorkspace
        onSelectSession={() => {}}
        onRequestDelete={() => {}}
        onRequestMove={() => {}}
        onRename={async () => {}}
        onTogglePin={async () => {}}
        onToggleArchive={async () => {}}
        onToggleRelatedParent={() => {}}
        pathStatus={options.pathStatus}
        onRelocateProject={() => {}}
      />
    </Provider>,
  )
}

describe('项目行展示', () => {
  test('Given project 工作区 When 渲染 Then 项目名后显示「本地项目」徽章且无路径副标题', () => {
    const html = renderProjectGroup({ workspace: projectWorkspace(), pathStatus: 'ok' })

    expect(html).toContain('data-project-local-badge')
    expect(html).toContain('本地项目')
    expect(html).not.toContain('data-project-config-badge')
    expect(html).not.toContain('…/code/demo-app')
    expect(html).not.toContain('项目路径不可用')
  })

  test('Given managed 工作区 When 渲染 Then 不出现 project 徽标与路径', () => {
    const html = renderProjectGroup({
      workspace: projectWorkspace({ storageMode: 'managed', rootPath: undefined }),
      pathStatus: 'ok',
    })

    expect(html).not.toContain('data-project-meta')
    expect(html).not.toContain('data-project-config-badge')
    expect(html).not.toContain('data-project-local-badge')
    expect(html).not.toContain('本地项目')
  })

  test('Given 路径已被删除 When 渲染 Then 提示不可用并提供重新定位 / 从列表移除', () => {
    const html = renderProjectGroup({ workspace: projectWorkspace(), pathStatus: 'missing' })

    expect(html).toContain('项目路径不可用')
    expect(html).toContain('data-project-relocate')
    expect(html).toContain('重新定位')
    expect(html).toContain('data-project-remove-from-list')
    expect(html).toContain('从列表移除')
  })

  test('Given 路径不可用 When 渲染 Then 新建会话按钮禁用（避免在错误路径上建会话）', () => {
    const html = renderProjectGroup({ workspace: projectWorkspace(), pathStatus: 'missing' })
    const marker = 'aria-label="在「ws-project」中新建会话"'
    const start = html.indexOf(marker)
    expect(start).toBeGreaterThan(-1)
    const button = html.slice(start, start + 320)

    expect(button).toContain('disabled')
  })

  test('Given 索引缺少 rootPath When 渲染 Then 也按路径不可用处理', () => {
    const html = renderProjectGroup({
      workspace: projectWorkspace({ rootPath: undefined }),
      pathStatus: 'unknown',
    })

    expect(html).toContain('项目路径不可用')
  })

  test('Given project 工作区 When 取菜单移除文案 Then 用「从 Profer 移除」而不是「删除项目」', () => {
    expect(getWorkspaceRemoveMenuLabel(projectWorkspace())).toBe('从 Profer 移除')
    expect(getWorkspaceRemoveMenuLabel(projectWorkspace({ storageMode: 'managed' }))).toBe('删除项目')
  })
})
