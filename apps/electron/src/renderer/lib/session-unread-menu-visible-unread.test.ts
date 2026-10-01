import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai/vanilla'
import { join } from 'node:path'
import {
  memoryUnviewedCompletedSessionIdsAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { manualReadConfirmEnabledAtom } from '@/atoms/agent-unread-settings'
import {
  applySessionUnreadToMemoryIds,
  isSessionVisiblyUnread,
  resolveSessionUnreadMenuItem,
} from './session-unread-menu'

/**
 * F-2 回归（验收缺陷修复）：菜单判据必须与绿标**同源**。
 *
 * 缺陷是：关闭态下绿标/角标看渲染层未读集合，菜单却只看持久化字段 `completedButUnconfirmed`；
 * 而关闭态的完成类未读**不写**持久化字段 ⇒ 绿标亮着、菜单却写「标记未读」，点它清不掉绿标。
 *
 * 覆盖点（自写用例）：
 * 1. 判据＝「持久化字段 ∪ 渲染层未读集合」的四种组合真值表；
 * 2. 关闭态复现用例（持久化 false + 内存未读）⇒ 菜单必须显示「标记已读」；
 * 3. 点击动作双向生效：marker 两个方向都同时改内存集合与持久化字段，点完菜单文案随之翻转；
 * 4. 开启态下内存集合的写入被模式守卫丢弃 ⇒ 并集判据退化为持久化字段（不会出现第三种口径）；
 * 5. 结构守卫：`session-items.tsx` 确实把渲染层未读集合传进了菜单判据。
 */

const APP_ROOT = join(import.meta.dir, '..', '..', '..')

describe('判据＝持久化字段 ∪ 渲染层未读集合', () => {
  test('Given 关闭态完成类未读（持久化 false + 内存未读）When 解析菜单项 Then 显示「标记已读」（F-2 复现用例）', () => {
    expect(isSessionVisiblyUnread({ completedButUnconfirmed: false, memoryUnread: true })).toBe(true)
    expect(resolveSessionUnreadMenuItem({
      completedButUnconfirmed: false,
      memoryUnread: true,
      hasToggleHandler: true,
    })).toEqual({ show: true, label: '标记已读', icon: 'mail-open', nextUnread: false })
  })

  test('Given 持久化未读但内存集合没有该 id When 解析菜单项 Then 同样显示「标记已读」', () => {
    expect(resolveSessionUnreadMenuItem({
      completedButUnconfirmed: true,
      memoryUnread: false,
      hasToggleHandler: true,
    }).label).toBe('标记已读')
  })

  test('Given 两处都判为已读 When 解析菜单项 Then 显示「标记未读」', () => {
    expect(resolveSessionUnreadMenuItem({
      completedButUnconfirmed: false,
      memoryUnread: false,
      hasToggleHandler: true,
    })).toEqual({ show: true, label: '标记未读', icon: 'mail', nextUnread: true })
  })

  test('Given 字段缺失（旧会话记录）When 解析菜单项 Then 按已读处理（fail-closed）', () => {
    expect(resolveSessionUnreadMenuItem({ hasToggleHandler: true })).toEqual({
      show: true,
      label: '标记未读',
      icon: 'mail',
      nextUnread: true,
    })
  })

  test('Given 任意未读组合 When 解析菜单项 Then 文案与图标永远同向', () => {
    for (const completedButUnconfirmed of [true, false, undefined]) {
      for (const memoryUnread of [true, false, undefined]) {
        const item = resolveSessionUnreadMenuItem({ completedButUnconfirmed, memoryUnread, hasToggleHandler: true })
        expect(item.icon).toBe(item.label === '标记已读' ? 'mail-open' : 'mail')
      }
    }
  })

  test('Given 没有切换回调 When 解析菜单项 Then 不渲染（判据仍按并集算）', () => {
    const item = resolveSessionUnreadMenuItem({
      completedButUnconfirmed: false,
      memoryUnread: true,
      hasToggleHandler: false,
    })
    expect(item.show).toBe(false)
    expect(item.label).toBe('标记已读')
  })
})

describe('点击动作双向生效：点完绿标真的会灭', () => {
  test('Given 关闭态完成类未读 When 点「标记已读」 Then 内存集合与持久化字段同时清、菜单翻为「标记未读」', () => {
    // 关闭态的两个事实源：内存集合（显示权威）与持久化字段（唯一写入口的返回值）。
    let memory: ReadonlySet<string> = new Set(['a', 'other'])
    let persistedUnread: boolean | undefined = false

    const nextUnread = resolveSessionUnreadMenuItem({
      completedButUnconfirmed: persistedUnread,
      memoryUnread: memory.has('a'),
      hasToggleHandler: true,
    }).nextUnread
    expect(nextUnread).toBe(false)

    // handler：IPC 写持久化字段 + 内存集合双向维护（见 use-left-sidebar.handleToggleSessionUnread），
    // 两个方向的写入都等于「目标状态」本身。
    persistedUnread = nextUnread
    memory = applySessionUnreadToMemoryIds(memory, 'a', nextUnread)

    expect(persistedUnread).toBe(false)
    expect([...memory].sort()).toEqual(['other'])
    // 绿标（内存集合）已灭，菜单随之变成「标记未读」——即用户可以再点回来
    expect(resolveSessionUnreadMenuItem({
      completedButUnconfirmed: persistedUnread,
      memoryUnread: memory.has('a'),
      hasToggleHandler: true,
    }).label).toBe('标记未读')
  })

  test('Given 已读会话 When 点「标记未读」 Then 内存集合加 id、持久化置 true、菜单翻为「标记已读」', () => {
    let memory: ReadonlySet<string> = new Set(['other'])
    let persistedUnread: boolean | undefined = false

    const nextUnread = resolveSessionUnreadMenuItem({
      completedButUnconfirmed: persistedUnread,
      memoryUnread: memory.has('a'),
      hasToggleHandler: true,
    }).nextUnread
    expect(nextUnread).toBe(true)

    persistedUnread = nextUnread
    memory = applySessionUnreadToMemoryIds(memory, 'a', nextUnread)

    expect(persistedUnread).toBe(true)
    expect([...memory].sort()).toEqual(['a', 'other'])
    expect(resolveSessionUnreadMenuItem({
      completedButUnconfirmed: persistedUnread,
      memoryUnread: memory.has('a'),
      hasToggleHandler: true,
    }).label).toBe('标记已读')
  })
})

describe('开启态：并集判据退化为持久化字段（不会出现第三种口径）', () => {
  test('Given 开启态 When 写渲染层未读集合 Then 写入被模式守卫丢弃，判据只剩持久化字段', () => {
    const store = createStore()
    store.set(manualReadConfirmEnabledAtom, true)
    store.set(unviewedCompletedSessionIdsAtom, new Set(['a']))
    expect([...store.get(memoryUnviewedCompletedSessionIdsAtom)]).toEqual([])
  })
})

describe('结构守卫：菜单判据确实接了渲染层未读集合', () => {
  test('Given 侧边栏会话行 When 检查菜单判据 Then 内存集合与持久化字段都参与', async () => {
    const source = (await Bun.file(join(APP_ROOT, 'src/renderer/components/app-shell/left-sidebar/session-items.tsx')).text())
      .replace(/\r\n/g, '\n')
    // main 侧在同一个 import 语句里并入了 currentAgentSessionIdAtom，因此断言放宽为「语句内含该 atom」，
    // 仍锁死「从 agent-atoms 引入 + 接到 memoryUnread 判据」两点语义。
    expect(source).toMatch(/import \{[^}]*\bunviewedCompletedSessionIdsAtom\b[^}]*\} from '@\/atoms\/agent-atoms'/)
    expect(source).toContain('const unviewedSessionIds = useAtomValue(unviewedCompletedSessionIdsAtom)')
    expect(source).toContain('memoryUnread: unviewedSessionIds.has(session.id),')
  })
})
