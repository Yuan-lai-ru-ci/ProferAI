import { describe, expect, test } from 'bun:test'
import type { SettingsTab } from '@/atoms/settings-tab'
import { filterSettingsGroups } from './settings-visibility'

/**
 * 设置导航可见性：开源版不得出现账号/额度/订阅入口。
 *
 * 这些入口漏出来的表现不是白屏，而是用户点进去看到「当前为开源版，不包含账号与官方模型服务」，
 * 所以用纯函数断言把规则钉住，而不是靠打包后目测。
 */

interface FixtureItem {
  id: SettingsTab
}

const groups = [
  { items: [{ id: 'general' }, { id: 'usage' }] as FixtureItem[] },
  { title: '账户', items: [{ id: 'account' }, { id: 'credits' }, { id: 'subscription' }] as FixtureItem[] },
  { title: '模型与能力', items: [{ id: 'channels' }] as FixtureItem[] },
]

const ids = (result: ReturnType<typeof filterSettingsGroups<FixtureItem>>): string[] =>
  result.flatMap((group) => group.items.map((item) => item.id))

describe('设置导航的发行版过滤', () => {
  test('Given 开源版且未登录 When 过滤 Then 账户整组消失，其余保留', () => {
    const result = filterSettingsGroups(groups, { isLoggedIn: false, commercial: false })
    expect(ids(result)).toEqual(['general', 'usage', 'channels'])
    expect(result.map((group) => group.title)).toEqual([undefined, '模型与能力'])
  })

  test('Given 开源版但登录态为真（脏配置） When 过滤 Then 仍不出现账户入口', () => {
    const result = filterSettingsGroups(groups, { isLoggedIn: true, commercial: false })
    expect(ids(result)).not.toContain('account')
    expect(ids(result)).not.toContain('credits')
    expect(ids(result)).not.toContain('subscription')
  })

  test('Given 商业版且已登录 When 过滤 Then 全部保留', () => {
    const result = filterSettingsGroups(groups, { isLoggedIn: true, commercial: true })
    expect(ids(result)).toEqual(['general', 'usage', 'account', 'credits', 'subscription', 'channels'])
  })

  test('Given 商业版未登录 When 过滤 Then 保留账户页作为登录入口，隐藏额度与订阅', () => {
    const result = filterSettingsGroups(groups, { isLoggedIn: false, commercial: true })
    expect(ids(result)).toEqual(['general', 'usage', 'account', 'channels'])
  })

  test('Given 某分组被过滤空 When 过滤 Then 移除空壳分组', () => {
    const onlyCommercial = [{ title: '账户', items: [{ id: 'credits' }] as FixtureItem[] }]
    expect(filterSettingsGroups(onlyCommercial, { isLoggedIn: true, commercial: false })).toEqual([])
  })
})
