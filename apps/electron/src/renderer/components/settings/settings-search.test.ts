import { describe, expect, test } from 'bun:test'
import { matchesSettingsSearch } from './settings-search'

describe('matchesSettingsSearch', () => {
  const channels = {
    label: '模型配置',
    searchTerms: ['渠道', 'API Key', '密钥', 'Base URL', 'OpenAI'],
  }

  test('页面内具体配置名称可以命中设置页', () => {
    expect(matchesSettingsSearch(channels, '模型与能力', 'API Key')).toBe(true)
    expect(matchesSettingsSearch(channels, '模型与能力', 'base url')).toBe(true)
    expect(matchesSettingsSearch({ label: '远程连接', searchTerms: ['默认工作区'] }, '连接', '默认 工作区')).toBe(true)
    expect(matchesSettingsSearch({ label: '外观设置', searchTerms: ['皮肤'] }, '体验', '皮肤')).toBe(true)
  })

  test('查询会匹配分组标题并忽略大小写与全角差异', () => {
    expect(matchesSettingsSearch({ label: '订阅方案' }, '账户', '账户')).toBe(true)
    expect(matchesSettingsSearch(channels, '模型与能力', 'openai')).toBe(true)
    expect(matchesSettingsSearch({ label: 'Chat 工具' }, '模型与能力', 'CHAT　工具')).toBe(true)
  })

  test('多个查询词需要全部命中，避免返回无关设置页', () => {
    expect(matchesSettingsSearch(channels, '模型与能力', '模型 密钥')).toBe(true)
    expect(matchesSettingsSearch(channels, '模型与能力', '模型 代理')).toBe(false)
    expect(matchesSettingsSearch(channels, '模型与能力', '不存在')).toBe(false)
  })

  test('空查询显示所有设置页', () => {
    expect(matchesSettingsSearch(channels, '模型与能力', '')).toBe(true)
    expect(matchesSettingsSearch(channels, '模型与能力', '   ')).toBe(true)
  })
})
