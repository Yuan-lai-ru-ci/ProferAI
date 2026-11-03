/**
 * 「会话文件」必须绑定到会话私有目录（storageDir），不是 UI 根。
 *
 * project 下 `sessionPath` 是项目根（相对路径基准）。若拿它当会话文件根：
 * - 所有会话看到同一批文件（互通）
 * - 用户上传到会话目录（storageDir）的文件看不到
 *
 * 这是一个源码守卫：SidePanel 的会话 Tab 必须用 `sessionFileRoot`（storageDir 优先）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(import.meta.dir, '..', '..', 'renderer', 'components', 'agent', 'SidePanel.tsx'),
  'utf-8',
)

describe('SidePanel 会话文件根', () => {
  test('会话文件根优先取 storageDir，sessionPath 只作兜底', () => {
    expect(source).toContain('getAgentSessionStoragePath')
    expect(source).toContain('const sessionFileRoot = sessionStoragePath ?? sessionPath')
  })

  test('会话 Tab 的文件浏览器与搜索都用 sessionFileRoot', () => {
    expect(source).toContain('<FileBrowser rootPath={sessionFileRoot}')
    expect(source).toContain('sessionPath={sessionFileRoot}')
  })

  test('会话 Tab 不再直接拿 sessionPath 当文件根', () => {
    expect(source).not.toContain('<FileBrowser rootPath={sessionPath}')
  })

  test('面包屑跟随会话文件根', () => {
    expect(source).toContain('getLastPathSegments(sessionFileRoot ?? sessionPath')
  })
})
