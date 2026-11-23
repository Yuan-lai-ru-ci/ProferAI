import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BotHubSettings } from './BotHubSettings'

describe('远程连接导航', () => {
  test('按设备、消息平台、偏好分组，默认进入移动端连接', () => {
    const html = renderToStaticMarkup(<BotHubSettings />)
    expect(html).toContain('设备与内核')
    expect(html).toContain('消息平台')
    expect(html).toContain('连接偏好')
    expect(html).toContain('移动端连接')
    expect(html).toContain('内核连接')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('aria-controls="bot-settings-panel-pocket"')
    expect(html).toContain('aria-labelledby="bot-settings-tab-pocket"')
    expect(html).not.toContain('aria-live="polite"')
    expect(html).not.toContain('overflow-x-auto')
    expect(html).not.toContain('手机与平板访问本机')
    expect(html).not.toContain('切换任务运行的机器')
    expect(html).not.toContain('168px_minmax')
  })
})
