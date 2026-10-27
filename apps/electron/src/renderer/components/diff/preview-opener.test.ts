/**
 * preview-opener 测试：预览打开方式（独立标签页 / 与对话分屏）。
 *
 * 只覆盖纯状态行为（jotai store + tab atoms），不涉及渲染。
 */

import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { previewOpenModeAtom } from '@/atoms/ui-preferences'
import { activeTabIdAtom, createPreviewTabId, tabsAtom } from '@/atoms/tab-atoms'
import { tabGroupsAtom } from '@/atoms/tab-group-atoms'
import { previewFilesByTabAtom } from '@/atoms/preview-atoms'
import { agentSessionPathMapAtom } from '@/atoms/agent-atoms'
import { openFilePreviewTab } from './preview-opener'

/** preview-opener 的 store 形参类型取自 React useStore，测试里用 vanilla store 桥接 */
type OpenerStore = Parameters<typeof openFilePreviewTab>[0]

function setup(mode: 'tab' | 'split'): { store: ReturnType<typeof createStore>; openerStore: OpenerStore } {
  const store = createStore()
  store.set(previewOpenModeAtom, mode)
  return { store, openerStore: store as unknown as OpenerStore }
}

const file = (filePath: string) => ({ filePath })

test('独立标签页模式：不同文件各开一个预览 Tab，重复打开只聚焦', () => {
  const { store, openerStore } = setup('tab')
  const first = openFilePreviewTab(openerStore, 's1', file('/w/a.ts'))
  const second = openFilePreviewTab(openerStore, 's1', file('/w/b.ts'))
  expect(first).toBe(createPreviewTabId('s1', '/w/a.ts'))
  expect(second).not.toBe(first)
  expect(store.get(tabsAtom).filter((t) => t.type === 'preview')).toHaveLength(2)
  // 独立标签页模式不组合，预览不与会话并排
  expect(store.get(tabGroupsAtom)).toEqual([])

  const again = openFilePreviewTab(openerStore, 's1', file('/w/a.ts'))
  expect(again).toBe(first)
  expect(store.get(tabsAtom).filter((t) => t.type === 'preview')).toHaveLength(2)
})

test('分屏模式：主动打开预览时与所属会话左右并排，焦点给预览', () => {
  const { store, openerStore } = setup('split')
  const tabId = openFilePreviewTab(openerStore, 's1', file('/w/a.ts'))

  expect(store.get(tabGroupsAtom)).toEqual([{ leftTabId: 's1', rightTabId: tabId, focusedTabId: tabId }])
  expect(store.get(activeTabIdAtom)).toBe(tabId)
  // 预览仍是普通标签页（每文件一个），只是被编进了组合
  expect(store.get(tabsAtom).map((t) => t.id)).toEqual(['__scratch-pad__', 's1', tabId])
})

test('分屏模式：已有「会话 + 同会话预览」组合时，右栏换成最新文件', () => {
  const { store, openerStore } = setup('split')
  const first = openFilePreviewTab(openerStore, 's1', file('/w/a.ts'))
  const second = openFilePreviewTab(openerStore, 's1', file('/w/b.ts'))

  expect(second).not.toBe(first)
  expect(store.get(tabGroupsAtom)).toEqual([{ leftTabId: 's1', rightTabId: second, focusedTabId: second }])
})

test('分屏模式：对侧是别的标签时不抢用户布局', () => {
  const { store, openerStore } = setup('split')
  store.set(tabsAtom, [
    { id: '__scratch-pad__', type: 'scratch', sessionId: '__scratch-pad__', title: 'Scratch Pad' },
    { id: 's1', type: 'agent', sessionId: 's1', title: 's1' },
    { id: 's2', type: 'agent', sessionId: 's2', title: 's2' },
  ])
  store.set(tabGroupsAtom, [{ leftTabId: 's1', rightTabId: 's2', focusedTabId: 's1' }])

  openFilePreviewTab(openerStore, 's1', file('/w/a.ts'))

  // 用户自己摆的「会话 + 会话」组合保持原样，只把预览开成标签页并聚焦
  expect(store.get(tabGroupsAtom)).toEqual([{ leftTabId: 's1', rightTabId: 's2', focusedTabId: 's1' }])
  expect(store.get(activeTabIdAtom)).toBe(createPreviewTabId('s1', '/w/a.ts'))
})

test('分屏模式：自动预览（activate:false）不抢视图，仅后台开 Tab', () => {
  const { store, openerStore } = setup('split')
  const tabId = openFilePreviewTab(openerStore, 's1', file('/w/a.ts'), { activate: false })

  expect(tabId).toBe(createPreviewTabId('s1', '/w/a.ts'))
  expect(store.get(tabGroupsAtom)).toEqual([])
  expect(store.get(activeTabIdAtom)).toBeNull()
})

test('相对父级路径先折叠再落 Tab：路径不再带 /../，同一文件两种写法共享一个 Tab', () => {
  const { store, openerStore } = setup('tab')
  store.set(agentSessionPathMapAtom, new Map([['s1', 'C:\\ws\\5714\\8333efcc']]))

  const relativeTabId = openFilePreviewTab(openerStore, 's1', file('../合并_20261027_时间轴.txt'))
  expect(store.get(previewFilesByTabAtom).get(relativeTabId)?.filePath).toBe('C:/ws/5714/合并_20261027_时间轴.txt')

  // 同一文件的绝对写法聚焦同一个 Tab，而不是再开一个
  const absoluteTabId = openFilePreviewTab(openerStore, 's1', file('C:/ws/5714/合并_20261027_时间轴.txt'))
  expect(absoluteTabId).toBe(relativeTabId)
  expect(store.get(tabsAtom).filter((t) => t.type === 'preview')).toHaveLength(1)
})
