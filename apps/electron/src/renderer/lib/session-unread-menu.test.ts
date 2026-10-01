import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { join } from 'node:path'
import type { AgentSessionMeta, PermissionRequest } from '@profer/shared'
import {
  agentSessionIndicatorMapAtom,
  agentSessionsAtom,
  agentStreamingStatesAtom,
  allPendingPermissionRequestsAtom,
  type AgentStreamState,
} from '@/atoms/agent-atoms'
import { manualReadConfirmEnabledAtom } from '@/atoms/agent-unread-settings'
import {
  applySessionUnreadToMemoryIds,
  getSessionCompletionStateEntry,
  resolveSessionUnreadMenuItem,
} from './session-unread-menu'

/**
 * 侧边栏会话菜单「未读状态切换」（`requirements.md` §3.4 / `design.md` §10 单测第 6 组）。
 *
 * 关键约束：
 * - 文案与图标**同判据**（不得出现「文案切了图标没切」）；
 * - 判据是未读事实源 `completedButUnconfirmed`，与侧边栏投影 `indicatorStatus` **解耦**
 *   （投影优先级 blocked > running > completed，会漏掉「运行中且未读」的会话）；
 * - 菜单**不受「手动确认已读」开关控制**，关闭态也生效；
 * - 单条切换、不提供批量入口。
 */

const APP_ROOT = join(import.meta.dir, '..', '..', '..')

function session(id: string, completedButUnconfirmed?: boolean): AgentSessionMeta {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...(completedButUnconfirmed === undefined ? {} : { completedButUnconfirmed }),
  } as AgentSessionMeta
}

describe('文案与图标同判据', () => {
  test('Given 会话未读 When 解析菜单项 Then 文案「标记已读」+ 打开的信封，目标状态为已读', () => {
    expect(resolveSessionUnreadMenuItem({ completedButUnconfirmed: true, hasToggleHandler: true }))
      .toEqual({ show: true, label: '标记已读', icon: 'mail-open', nextUnread: false })
  })

  test('Given 会话已读 When 解析菜单项 Then 文案「标记未读」+ 信封，目标状态为未读', () => {
    expect(resolveSessionUnreadMenuItem({ completedButUnconfirmed: false, hasToggleHandler: true }))
      .toEqual({ show: true, label: '标记未读', icon: 'mail', nextUnread: true })
  })

  test('Given 未读字段缺失（旧会话记录）When 解析菜单项 Then 按已读处理（fail-closed）', () => {
    expect(resolveSessionUnreadMenuItem({ completedButUnconfirmed: undefined, hasToggleHandler: true }))
      .toEqual({ show: true, label: '标记未读', icon: 'mail', nextUnread: true })
  })

  test('Given 任意未读状态 When 解析菜单项 Then 文案与图标永远同向（不会有第三种组合）', () => {
    for (const completedButUnconfirmed of [true, false, undefined]) {
      const item = resolveSessionUnreadMenuItem({ completedButUnconfirmed, hasToggleHandler: true })
      expect(item.icon).toBe(item.label === '标记已读' ? 'mail-open' : 'mail')
    }
  })
})

describe('显示条件只看回调，不看 canMove', () => {
  test('Given 没有切换回调 When 解析菜单项 Then 不渲染（其余字段仍可用）', () => {
    const item = resolveSessionUnreadMenuItem({ completedButUnconfirmed: true, hasToggleHandler: false })
    expect(item.show).toBe(false)
    expect(item.label).toBe('标记已读')
  })
})

describe('与侧边栏投影 indicatorStatus 解耦', () => {
  test('Given 会话运行中且未读 When 看投影与菜单 Then 投影为 running 但菜单仍显示「标记已读」', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [session('running-unread', true)])
    store.set(agentStreamingStatesAtom, new Map([['running-unread', { running: true } as AgentStreamState]]))

    expect(store.get(agentSessionIndicatorMapAtom).get('running-unread')).toBe('running')
    expect(resolveSessionUnreadMenuItem({ completedButUnconfirmed: true, hasToggleHandler: true }).label)
      .toBe('标记已读')
  })

  test('Given 会话等待权限且未读 When 看投影与菜单 Then 投影为 blocked 但菜单仍显示「标记已读」', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [session('blocked-unread', true)])
    store.set(agentStreamingStatesAtom, new Map([['blocked-unread', { running: true } as AgentStreamState]]))
    store.set(allPendingPermissionRequestsAtom, new Map([
      ['blocked-unread', [{ requestId: 'req-1' } as PermissionRequest]],
    ]))

    expect(store.get(agentSessionIndicatorMapAtom).get('blocked-unread')).toBe('blocked')
    expect(resolveSessionUnreadMenuItem({ completedButUnconfirmed: true, hasToggleHandler: true }).label)
      .toBe('标记已读')
  })

  test('Given 关闭态 When 只看持久化字段 Then 投影不反映它（内存集合才是关闭态显示权威）', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [session('persisted-only', true)])
    expect(store.get(agentSessionIndicatorMapAtom).get('persisted-only')).toBeUndefined()
  })

  test('Given 开启态 When 会话未读 Then 投影为 completed（未读事实源与投影同源）', () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(agentSessionsAtom, [session('completed-unread', true)])

    expect(store.get(agentSessionIndicatorMapAtom).get('completed-unread')).toBe('completed')
  })
})

describe('不受开关控制，始终生效', () => {
  test('Given 关闭态（默认开关值）When 解析菜单项 Then 切换项照常可用', () => {
    const store = createStore()
    expect(store.get(manualReadConfirmEnabledAtom)).toBe(false)
    expect(resolveSessionUnreadMenuItem({ completedButUnconfirmed: true, hasToggleHandler: true }).show).toBe(true)
    expect(resolveSessionUnreadMenuItem({ completedButUnconfirmed: false, hasToggleHandler: true }).show).toBe(true)
  })

  test('Given 关闭态 When 看菜单纯函数签名 Then 不接收开关（结构上无法被开关控制）', () => {
    // 传入多余字段不影响结果：解析结果只由未读事实源与回调存在性决定。
    const item = resolveSessionUnreadMenuItem({
      completedButUnconfirmed: false,
      hasToggleHandler: true,
      // @ts-expect-error 刻意传入无关字段，证明未被消费
      manualReadConfirmEnabled: true,
    })
    expect(item).toEqual({ show: true, label: '标记未读', icon: 'mail', nextUnread: true })
  })
})

describe('方向 → 宿主入口一一对应', () => {
  test('Given 目标未读状态 When 取 preload 入口 Then 与既有 IPC 一一对应（不新增 IPC）', () => {
    expect(getSessionCompletionStateEntry(true)).toBe('setAgentCompletionState')
    expect(getSessionCompletionStateEntry(false)).toBe('clearAgentCompletionState')
  })
})

describe('handler 双向维护内存集合（本包与旧分支的关键差异）', () => {
  test('Given 内存集合没有该 id When 标记未读 Then 加 id', () => {
    expect([...applySessionUnreadToMemoryIds(new Set(['other']), 'a', true)].sort()).toEqual(['a', 'other'])
  })

  test('Given 内存集合有该 id When 标记已读 Then 删 id', () => {
    expect([...applySessionUnreadToMemoryIds(new Set(['a', 'other']), 'a', false)]).toEqual(['other'])
  })

  test('Given 状态未变化 When 应用切换 Then 返回原引用（避免多余重渲染）', () => {
    const previous = new Set(['a'])
    expect(applySessionUnreadToMemoryIds(previous, 'a', true)).toBe(previous)
    expect(applySessionUnreadToMemoryIds(previous, 'b', false)).toBe(previous)
  })
})

describe('无批量入口', () => {
  test('Given 侧边栏菜单渲染 When 检查文案 Then 没有批量「全部标为已读」类入口', async () => {
    const source = (await Bun.file(join(APP_ROOT, 'src/renderer/components/app-shell/left-sidebar/session-items.tsx')).text())
      .replace(/\r\n/g, '\n')
    expect(source).not.toContain('全部标为已读')
    expect(source).not.toContain('全部标记')
    expect(source).not.toContain('全部标为未读')
  })
})
