import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * 关闭态源码守卫（`design.md` §1.2 / §10 单测第 4 组）。
 *
 * 本包与旧插件分支最大的结构差异是：**关闭态逐点保真——一律不删现有自动清除路径**。
 * 旧分支删掉了内存集合并把 R1–R9 全部移除，本包刻意反过来：保留全部调用点，只在
 * 「模式感知 atom」这一处统一门控。这个测试就是那条约束的护栏——如果以后有人「顺手清理」
 * 掉某个自动清除点，未读行为会在关闭态发生静默变化而无人发现。
 *
 * 断言的是**代码级存在性**（不是行为），因此只读源码、不做运行时求值。
 */

const APP_ROOT = join(import.meta.dir, '..', '..', '..')

/** 读取仓库内源码并归一换行符（工作副本是 CRLF，仓库存储是 LF）。 */
async function readSource(relativePath: string): Promise<string> {
  const file = Bun.file(join(APP_ROOT, relativePath))
  expect(await file.exists()).toBe(true)
  return (await file.text()).replace(/\r\n/g, '\n')
}

/** 断言源码里同时存在若干片段（缺失哪一段就报哪一段）。 */
function expectContains(source: string, snippets: string[]): void {
  for (const snippet of snippets) {
    expect(source).toContain(snippet)
  }
}

describe('不修改 agent-completion-presence.ts（关闭态未读产生的对照组）', () => {
  test('Given 关闭态未读产生 When 检查判定函数 Then 判据未被改写', async () => {
    const source = await readSource('src/renderer/lib/agent-completion-presence.ts')
    expectContains(source, [
      'export function isAgentSessionActiveForCompletion(',
      'export function getAgentCompletionMarkers(',
      // 窗口失焦一律算「未查看」
      'if (!documentHasFocus) return false',
      // 用户不在该会话才产生未读
      'markUnviewedCompleted: !isActiveSession',
    ])
  })

  test('Given 既有对照单测 When 检查文件 Then 仍存在且未被改写为「开启态」口径', async () => {
    const source = await readSource('src/renderer/lib/agent-completion-presence.test.ts')
    expectContains(source, ['Agent 完成归属判断'])
    expect(source).not.toContain('completedButUnconfirmed')
  })
})

describe('渲染层未读产生（P1/P2）保留', () => {
  test('Given STREAM_COMPLETE 入账 When 检查监听器 Then presence 判定与内存写入都在', async () => {
    const source = await readSource('src/renderer/hooks/useGlobalAgentListeners.ts')
    expectContains(source, [
      "import { getAgentCompletionMarkers } from '@/lib/agent-completion-presence'",
      'const completionMarkers = getAgentCompletionMarkers({',
      'if (completionMarkers.markUnviewedCompleted && !backgroundTasksPending) {',
      'store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => {',
    ])
  })
})

describe('渲染层自动清除点（R1–R10）一个都不能少', () => {
  const points: Array<{ id: string; file: string; snippets: string[] }> = [
    {
      id: 'R1 useOpenSession 打开会话',
      file: 'src/renderer/hooks/useOpenSession.ts',
      snippets: [
        'setUnviewedCompleted((prev) => {',
        "shouldAutoClearUnreadOnView(manualReadConfirmEnabled ? 'manual' : 'auto')",
        'window.electronAPI.clearAgentCompletionState(sessionId)',
      ],
    },
    {
      id: 'R2 TabBar 激活标签',
      file: 'src/renderer/components/tabs/TabBar.tsx',
      snippets: ['const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)', 'setUnviewedCompleted((prev) => {', 'next.delete(tab.sessionId)'],
    },
    {
      id: 'R3 useCloseTab 关闭空闲标签',
      file: 'src/renderer/hooks/useCloseTab.tsx',
      snippets: [
        'const clearIdleAgentCompletionNotice = React.useCallback((sessionId: string) => {',
        "if (status === 'running' || status === 'blocked') return",
        "shouldAutoClearUnreadOnView(manualReadConfirmEnabled ? 'manual' : 'auto')",
        'window.electronAPI.clearAgentCompletionState(sessionId)',
      ],
    },
    {
      id: 'R4 TabSwitcher 切换器激活',
      file: 'src/renderer/components/tabs/TabSwitcher.tsx',
      snippets: ['setUnviewedCompleted((prev) => {', 'next.delete(candidate.id)'],
    },
    {
      id: 'R5 useSyncActiveTabSideEffects 新激活副作用',
      file: 'src/renderer/hooks/useSyncActiveTabSideEffects.ts',
      snippets: ['setUnviewedCompleted((prev) => {', 'next.delete(newActiveTab.sessionId)'],
    },
    {
      id: 'R6 DockBadgeInitializer 挂载 / focus / visibilitychange',
      file: 'src/renderer/main.tsx',
      snippets: [
        'function DockBadgeInitializer(): null {',
        'const clearCurrentSessionBadge = (): void => {',
        "window.addEventListener('focus', clearCurrentSessionBadge)",
        "document.addEventListener('visibilitychange', clearCurrentSessionBadge)",
      ],
    },
    {
      id: 'R7 会话首次进入 running',
      file: 'src/renderer/hooks/useGlobalAgentListeners.ts',
      snippets: ['store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => {'],
    },
    {
      id: 'R8 external_run_started',
      file: 'src/renderer/hooks/useGlobalAgentListeners.ts',
      snippets: ['store.set(unviewedCompletedSessionIdsAtom, (prev) => {'],
    },
    {
      id: 'R9 侧边栏点击会话 / 探索分支',
      file: 'src/renderer/components/app-shell/left-sidebar/use-left-sidebar.ts',
      snippets: ['setUnviewedCompleted((previous) => {', 'next.delete(id)'],
    },
    {
      id: 'R10 团队工作区切换会话',
      file: 'src/renderer/components/agent/TeamWorkspaceView.tsx',
      snippets: ['setUnviewedCompleted((prev) => {', 'next.delete(sessionId)'],
    },
  ]

  for (const point of points) {
    test(`Given 关闭态保真 When 检查 ${point.id} Then 调用点仍在`, async () => {
      expectContains(await readSource(point.file), point.snippets)
    })
  }
})

describe('启动恢复与手动标记（S1/S2）保留', () => {
  test('Given 启动回填 When 检查侧边栏 Then 持久化未读仍会补进内存集合', async () => {
    expectContains(await readSource('src/renderer/components/app-shell/left-sidebar/use-left-sidebar.ts'), [
      "window.electronAPI.listAgentSessions(includeArchived).then((sessions) => {",
      'const persistedUnreadIds = sessions.filter((s) => s.completedButUnconfirmed).map((s) => s.id)',
    ])
  })

  test('Given 菜单状态切换 When 检查侧边栏 handler Then 两向都走主进程唯一写入口', async () => {
    expectContains(await readSource('src/renderer/components/app-shell/left-sidebar/use-left-sidebar.ts'), [
      'const handleToggleSessionUnread = React.useCallback((id: string, nextUnread: boolean): void => {',
      'window.electronAPI.setAgentCompletionState(id)',
      'window.electronAPI.clearAgentCompletionState(id)',
      // 关闭态内存集合仍是显示权威 ⇒ handler 必须双向维护内存集合。
      'setUnviewedCompleted((prev: Set<string>) => {',
    ])
  })
})

describe('主进程持久化字段的写/清（M1–M6）保留', () => {
  test('Given 主进程未读写入 When 检查唯一写入口 Then 所有路径都经 setAgentSessionUnread', async () => {
    expectContains(await readSource('src/main/lib/agent-session-ui-projection-publisher.ts'), [
      'export function setAgentSessionUnread(',
      'completedButUnconfirmed: unread',
    ])
  })

  test('Given run 启动清未读与终态写未读 When 检查 agent-service Then 模式入参化但两侧分支都在', async () => {
    expectContains(await readSource('src/main/lib/agent-service.ts'), [
      'applyRunStartUnreadPolicy(input.sessionId, initiator)',
      'applyRunStartUnreadPolicy(runInput.sessionId, initiator)',
      'applyCompletionUnreadPolicy({',
      'started: runStarted',
    ])
  })

  test('Given 归档与移动端命令 When 检查落点 Then 共用纯策略函数、mock_session_read 保留显式门', async () => {
    expectContains(await readSource('src/main/ipc.ts'), ['buildArchiveToggleUpdates({', 'setAgentSessionUnread(id, false'])
    expectContains(await readSource('src/main/lib/remote-service.ts'), [
      "case 'mark_session_read': {",
      "if (getAgentUnreadPolicyMode() === 'manual' && parsed.explicit !== true) {",
      "case 'mark_session_unread': {",
      'setAgentSessionUnread(sessionId, true)',
      "case 'toggle_session_archive': {",
    ])
  })
})

describe('验收缺陷修复后的关闭态保真守卫（F-1…F-4 + D-2）', () => {
  test('Given D-2 When 检查 runAgent Then 入口清未读在 sendMessage 之前、且关闭态才生效', async () => {
    const source = await readSource('src/main/lib/agent-service.ts')
    expectContains(source, [
      'function clearSessionUnreadOnRequestEntry(sessionId: string): void {',
      "if (getAgentUnreadPolicyMode() !== 'auto') return",
      'clearSessionUnreadOnRequestEntry(input.sessionId)',
      // onRunStarted 落点在关闭态直接返回（避免重复写盘）
      "if (mode === 'auto') return",
    ])
    expect(source.indexOf('clearSessionUnreadOnRequestEntry(input.sessionId)'))
      .toBeLessThan(source.indexOf('await orchestrator.sendMessage(input, {'))
  })

  test('Given F-3 When 检查唯一写入口 Then 归档保持只在开启态生效（关闭态恢复自动解归档）', async () => {
    expectContains(await readSource('src/main/lib/agent-session-ui-projection-publisher.ts'), [
      "const keepArchived = existing.archived === true && getAgentUnreadPolicyMode() === 'manual'",
    ])
  })

  test('Given F-1/F-2 When 检查渲染层 Then 开 → 关会剔除已确认已读、菜单判据含内存集合', async () => {
    expectContains(await readSource('src/renderer/lib/agent-unread-gate.ts'), [
      'clearMemoryUnreadIds',
      'confirmedReadIds',
    ])
    expectContains(await readSource('src/renderer/lib/session-unread-menu.ts'), [
      'export function isSessionVisiblyUnread(',
      'input.completedButUnconfirmed === true || input.memoryUnread === true',
    ])
  })
})

describe('本包不得引入任何插件侧依赖', () => {
  const touchedFiles = [
    'src/renderer/lib/confirm-read-button.ts',
    'src/renderer/lib/session-unread-menu.ts',
    'src/renderer/lib/agent-unread-gate.ts',
    'src/renderer/lib/agent-unread-derive.ts',
    'src/renderer/lib/agent-unread-transition.ts',
    'src/renderer/components/agent/ConfirmReadButton.tsx',
    'src/main/lib/agent-unread-policy.ts',
    'src/main/lib/agent-unread-mode.ts',
  ]

  for (const file of touchedFiles) {
    test(`Given 核心实现 When 检查 ${file} Then 不 import 插件模块`, async () => {
      const source = await readSource(file)
      expect(source).not.toContain('@profer/plugin-api')
      expect(source).not.toContain('plugin-')
    })
  }
})
