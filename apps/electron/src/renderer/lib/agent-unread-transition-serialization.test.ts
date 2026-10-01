import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createStore } from 'jotai/vanilla'
import type { AgentSessionMeta } from '@profer/shared'
import {
  agentSessionsAtom,
  memoryUnviewedCompletedSessionIdsAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { manualReadConfirmEnabledAtom } from '@/atoms/agent-unread-settings'
import { applyUnreadModeTransition, noteExplicitUnreadRead } from './agent-unread-transition'
import { applySessionUnreadToMemoryIds, resolveSessionUnreadMenuItem } from './session-unread-menu'

/**
 * 复验残余项 R-1 / B-2 的回归（开关迁移串行化 + 未确认补写保护）。
 *
 * 复验给出的复现口径（`reports/quality-report.md` §16.3.1）：
 * - **R-1（逻辑级已复现）**：第一次「关 → 开」的补写仍在途时，第二次「开 → 关」按**不含该补写**
 *   的会话列表快照做判据 ⇒ 把该 id 当成「已确认已读」从内存剔除，随后补写才落 `true`
 *   ⇒ 终态「关闭态绿标不亮、持久化却是未读（菜单显示「标记已读」）」。
 * - **B-2（推断）**：「关 → 开」补写失败后继续；若随后切回关闭态，该 id 被当已读剔除 ⇒ 未读静默丢失。
 *
 * 本文件按复验探针的方式构造「在途挂起的补写」，断言**任何切换顺序结束后绿标、持久化字段、
 * 菜单判据三者一致**（三源采样一律走真实 atom 与真实纯函数，不自造判据）。
 */

const previousWindow = (globalThis as { window?: unknown }).window
const originalConsoleError = console.error

/** 补写替身的调用记录与可控行为（挂起 / 失败）。 */
const attemptedWrites: string[] = []
let hangingIds = new Set<string>()
let failingIds = new Set<string>()
let pendingReleases: Array<() => void> = []

function session(id: string, completedButUnconfirmed?: boolean): AgentSessionMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...(completedButUnconfirmed === undefined ? {} : { completedButUnconfirmed }),
  } as AgentSessionMeta
}

function stubElectronApi(): void {
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      setAgentCompletionState: async (id: string): Promise<AgentSessionMeta> => {
        attemptedWrites.push(id)
        if (failingIds.has(id)) throw new Error(`mock ipc failure: ${id}`)
        if (hangingIds.has(id)) {
          await new Promise<void>((resolve) => {
            pendingReleases.push(resolve)
          })
        }
        return session(id, true)
      },
    },
  }
}

/** 让挂起的补写落地（模拟 IPC 往返完成）。 */
function releasePendingWrites(): void {
  const releases = pendingReleases
  pendingReleases = []
  for (const release of releases) release()
}

/** 推进微任务，让排队中的迁移跑到它的第一个 await（补写）。 */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

beforeEach(() => {
  attemptedWrites.length = 0
  hangingIds = new Set<string>()
  failingIds = new Set<string>()
  pendingReleases = []
  // 补写失败路径会打 console.error（预期行为），这里静音避免污染测试输出。
  console.error = () => {}
  stubElectronApi()
})

afterEach(() => {
  console.error = originalConsoleError
  ;(globalThis as { window?: unknown }).window = previousWindow
})

/** 三源采样：绿标（真实公共 atom）、持久化字段、侧边栏菜单文案。 */
function sampleThreeSources(store: ReturnType<typeof createStore>, sessionId: string): {
  persisted: boolean
  memory: boolean
  greenMark: boolean
  menuLabel: string
} {
  const sessions = store.get(agentSessionsAtom)
  const meta = sessions.find((item) => item.id === sessionId)
  const memory = store.get(memoryUnviewedCompletedSessionIdsAtom).has(sessionId)
  const menu = resolveSessionUnreadMenuItem({
    completedButUnconfirmed: meta?.completedButUnconfirmed,
    memoryUnread: memory,
    hasToggleHandler: true,
  })
  return {
    persisted: meta?.completedButUnconfirmed === true,
    memory,
    // 绿标看的是公共 atom：关闭态＝内存集合，开启态＝持久化字段派生。
    greenMark: store.get(unviewedCompletedSessionIdsAtom).has(sessionId),
    menuLabel: menu.label,
  }
}

describe('R-1：迁移串行化，快速连续切换后三源一致', () => {
  test('Given 第一次补写仍在途 When 立刻切回关闭态 Then 后一次排队，终态绿标亮且菜单为「标记已读」', async () => {
    const store = createStore()
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['x']))
    store.set(agentSessionsAtom, [session('x', false)])
    hangingIds = new Set(['x'])

    // ① 关 → 开：补写在途（挂起）
    store.set(manualReadConfirmEnabledAtom, true)
    const toManual = applyUnreadModeTransition({ from: 'auto', to: 'manual', get: store.get, set: store.set })
    await flushMicrotasks()
    expect(attemptedWrites).toEqual(['x'])

    // ② 同一次 IPC 窗口内立刻「开 → 关」
    store.set(manualReadConfirmEnabledAtom, false)
    const toAuto = applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })
    await flushMicrotasks()

    // 排队证据：第一次补写没落地前，第二次迁移不产生任何副作用。
    expect(attemptedWrites).toEqual(['x'])
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual(['x'])

    releasePendingWrites()
    const manualPlan = await toManual
    const autoPlan = await toAuto

    expect(manualPlan.persistUnreadIds).toEqual(['x'])
    // 第二次迁移读到的是**已含补写结果**的快照 ⇒ 不把 x 当作「已确认已读」
    expect(autoPlan.clearMemoryUnreadIds).toEqual([])
    expect(autoPlan.seedMemoryUnreadIds).toEqual([])

    const sample = sampleThreeSources(store, 'x')
    expect(sample.persisted).toBe(true)
    expect(sample.greenMark).toBe(true)
    expect(sample.menuLabel).toBe('标记已读')
    expect(sample.memory).toBe(true)
  })

  test('Given 连续三次快速切换（开 → 关 → 开）When 在途补写落地 Then 终态三源一致', async () => {
    const store = createStore()
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['w']))
    store.set(agentSessionsAtom, [session('w', false)])
    hangingIds = new Set(['w'])

    store.set(manualReadConfirmEnabledAtom, true)
    const toManual = applyUnreadModeTransition({ from: 'auto', to: 'manual', get: store.get, set: store.set })
    await flushMicrotasks()

    store.set(manualReadConfirmEnabledAtom, false)
    const toAuto = applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })
    store.set(manualReadConfirmEnabledAtom, true)
    const toManualAgain = applyUnreadModeTransition({ from: 'auto', to: 'manual', get: store.get, set: store.set })
    await flushMicrotasks()

    releasePendingWrites()
    await toManual
    await toAuto
    await toManualAgain

    // 终态＝开启态：绿标＝持久化派生，菜单＝未读 ⇒ 一致。
    const sample = sampleThreeSources(store, 'w')
    expect(sample.persisted).toBe(true)
    expect(sample.greenMark).toBe(true)
    expect(sample.menuLabel).toBe('标记已读')
    // 未读一个没丢：切回关闭态也还能看到它。
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual(['w'])
  })
})

describe('B-2：补写失败不丢未读', () => {
  test('Given 关 → 开 的补写失败 When 随后切回关闭态 Then 未读不得被误剔除', async () => {
    const store = createStore()
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['y']))
    store.set(agentSessionsAtom, [session('y', false)])
    failingIds = new Set(['y'])

    store.set(manualReadConfirmEnabledAtom, true)
    const toManual = await applyUnreadModeTransition({ from: 'auto', to: 'manual', get: store.get, set: store.set })
    expect(toManual.persistUnreadIds).toEqual(['y'])
    expect(attemptedWrites).toEqual(['y'])

    store.set(manualReadConfirmEnabledAtom, false)
    const toAuto = await applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })

    // 列表里的 false 只是「补写没落地」，不是「用户确认过已读」⇒ 不得剔除。
    expect(toAuto.clearMemoryUnreadIds).toEqual([])
    expect(toAuto.seedMemoryUnreadIds).toEqual([])

    const sample = sampleThreeSources(store, 'y')
    expect(sample.memory).toBe(true)
    expect(sample.greenMark).toBe(true)
    expect(sample.menuLabel).toBe('标记已读')
  })

  test('Given 补写失败后用户显式确认已读 When 再切回关闭态 Then 陈旧副本按用户意图剔除', async () => {
    const store = createStore()
    store.set(memoryUnviewedCompletedSessionIdsAtom, new Set(['z']))
    store.set(agentSessionsAtom, [session('z', false)])
    failingIds = new Set(['z'])

    store.set(manualReadConfirmEnabledAtom, true)
    await applyUnreadModeTransition({ from: 'auto', to: 'manual', get: store.get, set: store.set })

    // 开启态里用户从侧边栏菜单点「标记已读」：与真实 handler 相同的语句序列
    //（撤销保护 + 内存集合维护；开启态下内存写入被模式守卫静默丢弃，陈旧副本仍在）。
    noteExplicitUnreadRead('z')
    store.set(unviewedCompletedSessionIdsAtom, (prev: Set<string>) => applySessionUnreadToMemoryIds(prev, 'z', false))
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual(['z'])

    store.set(manualReadConfirmEnabledAtom, false)
    const toAuto = await applyUnreadModeTransition({ from: 'manual', to: 'auto', get: store.get, set: store.set })

    expect(toAuto.clearMemoryUnreadIds).toEqual(['z'])
    const sample = sampleThreeSources(store, 'z')
    expect(sample.memory).toBe(false)
    expect(sample.greenMark).toBe(false)
    expect(sample.menuLabel).toBe('标记未读')
  })
})

describe('显式确认已读的宿主入口已接线（R-1/B-2 保护撤销）', () => {
  const APP_ROOT = join(import.meta.dir, '..', '..', '..')

  async function readSource(relativePath: string): Promise<string> {
    const file = Bun.file(join(APP_ROOT, relativePath))
    expect(await file.exists()).toBe(true)
    return (await file.text()).replace(/\r\n/g, '\n')
  }

  test('Given 最新一轮的「确认已读」按钮 When 点击处理 Then 撤销未确认补写保护', async () => {
    const source = await readSource('src/renderer/components/agent/ConfirmReadButton.tsx')
    expect(source).toContain("import { noteExplicitUnreadRead } from '@/lib/agent-unread-transition'")
    expect(source).toContain('noteExplicitUnreadRead(sessionId)')
  })

  test('Given 侧边栏菜单「标记已读」 When 处理切换 Then 撤销未确认补写保护', async () => {
    const source = await readSource('src/renderer/components/app-shell/left-sidebar/use-left-sidebar.ts')
    expect(source).toContain("import { noteExplicitUnreadRead } from '@/lib/agent-unread-transition'")
    expect(source).toContain('if (!nextUnread) noteExplicitUnreadRead(id)')
  })

  test('Given 迁移模块 When 检查实现 Then 串行化与未确认保护都在（本次修复的核心）', async () => {
    const source = await readSource('src/renderer/lib/agent-unread-transition.ts')
    expect(source).toContain('let transitionChain: Promise<void> = Promise.resolve()')
    expect(source).toContain('const run = transitionChain.then(() => runModeTransition(input))')
    expect(source).toContain('const unconfirmedUnreadPersistIds = new Set<string>()')
    expect(source).toContain('.filter((id) => !unconfirmedUnreadPersistIds.has(id))')
    expect(source).toContain('unconfirmedUnreadPersistIds.delete(id)')
  })
})
