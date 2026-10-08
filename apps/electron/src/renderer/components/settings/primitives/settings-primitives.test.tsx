import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsInput } from './SettingsInput'
import { SettingsTextarea } from './SettingsTextarea'
import { SettingsToggle } from './SettingsToggle'
import { SettingsSelect } from './SettingsSelect'
import { SettingsSecretInput } from './SettingsSecretInput'
import { SettingsSegmentedControl } from './SettingsSegmentedControl'
import { SettingsSection } from './SettingsSection'

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1]
}

function expectLabelAssociation(html: string, controlPattern: RegExp): string {
  const control = html.match(controlPattern)?.[0] ?? ''
  const label = html.match(/<label[^>]*>/)?.[0] ?? ''
  const id = attribute(control, 'id')
  expect(id).toBeTruthy()
  expect(attribute(label, 'for')).toBe(id)
  return control
}

describe('设置基础控件真实 React 渲染语义', () => {
  test('Given 输入错误 When 渲染 Then 标签、说明和错误关联实际输入', () => {
    const html = renderToStaticMarkup(<SettingsInput label="地址" description="服务地址" value="bad" onChange={() => {}} error="地址无效" />)
    const control = expectLabelAssociation(html, /<input[^>]*>/)
    expect(attribute(control, 'aria-invalid')).toBe('true')
    const references = attribute(control, 'aria-describedby')?.split(' ') ?? []
    expect(references).toHaveLength(2)
    for (const id of references) expect(html).toContain(`id="${id}"`)
    expect(html).toContain('role="alert"')
  })

  test('Given 多行输入无说明无错误 When 渲染 Then 不生成悬空描述引用', () => {
    const html = renderToStaticMarkup(<SettingsTextarea label="提示词" value="" onChange={() => {}} />)
    const control = expectLabelAssociation(html, /<textarea[^>]*>/)
    expect(attribute(control, 'aria-describedby')).toBeUndefined()
    expect(attribute(control, 'aria-invalid')).toBe('false')
  })

  test('Given 开关与下拉 When 渲染 Then 可见标签关联 switch/combobox', () => {
    const toggle = renderToStaticMarkup(<SettingsToggle label="通知" checked onCheckedChange={() => {}} />)
    expectLabelAssociation(toggle, /<button[^>]*role="switch"[^>]*>/)
    const select = renderToStaticMarkup(<SettingsSelect label="主题" value="dark" options={[{ value: 'dark', label: '深色' }]} onValueChange={() => {}} />)
    expectLabelAssociation(select, /<button[^>]*role="combobox"[^>]*>/)
  })

  test('Given 禁用凭据 When 渲染 Then 输入与显隐按钮同时禁用且按钮可命名', () => {
    const html = renderToStaticMarkup(<SettingsSecretInput label="API Key" value="" disabled onChange={() => {}} />)
    expectLabelAssociation(html, /<input[^>]*>/)
    const button = html.match(/<button[^>]*>/)?.[0] ?? ''
    expect(button).toContain('disabled=""')
    expect(attribute(button, 'aria-label')).toBe('显示API Key')
    expect(attribute(button, 'aria-pressed')).toBe('false')
    expect(attribute(button, 'tabindex')).toBeUndefined()
  })

  test('Given 分段值 When 渲染 Then 组选项具有唯一选中语义', () => {
    const html = renderToStaticMarkup(<SettingsSegmentedControl label="模式" value="dark" options={[{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }]} onValueChange={() => {}} />)
    expect(html).toContain('role="group"')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1)
  })

  test('Given 多个相同标签控件 When 渲染 Then React 分配不同 ID', () => {
    const html = renderToStaticMarkup(<><SettingsInput label="名称" value="" onChange={() => {}} /><SettingsInput label="名称" value="" onChange={() => {}} /></>)
    const controls = html.match(/<input[^>]*>/g) ?? []
    expect(controls).toHaveLength(2)
    expect(attribute(controls[0]!, 'id')).not.toBe(attribute(controls[1]!, 'id'))
  })

  test('Given 设置区块 When 渲染 Then 使用 section 和连续标题层级', () => {
    const html = renderToStaticMarkup(<SettingsSection title="输入" action={<button>保存</button>}><div>字段</div></SettingsSection>)
    expect(html).toContain('<section')
    expect(html).toContain('<h3')
    expect(html).toContain('flex-wrap')
  })
})
