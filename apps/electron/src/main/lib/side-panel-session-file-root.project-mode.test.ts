/** 会话文件必须绑定私有根：Core 工作台或 legacy storageDir，不是项目 UI 根。 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(import.meta.dir, '..', '..', 'renderer', 'components', 'agent', 'SidePanel.tsx'),
  'utf-8',
)

describe('SidePanel 会话文件根', () => {
  test('Core 使用工作台，legacy 优先 storageDir 而不是项目 UI 根', () => {
    expect(source).toContain('getAgentSessionStoragePath')
    expect(source).toContain('const sessionFileRoot = hasCoreFiles ? (coreFileRoots?.workbench ?? null) : (sessionStoragePath ?? effectiveSessionPath)')
  })

  test('会话 Tab 的文件浏览器与搜索都用 sessionFileRoot', () => {
    expect(source).toMatch(/<FileBrowser\s+rootPath=\{sessionFileRoot\}/)
    expect(source).toContain('sessionPath={sessionFileRoot}')
  })

  test('会话 Tab 不再直接拿 sessionPath 当文件根', () => {
    expect(source).not.toContain('<FileBrowser rootPath={sessionPath}')
  })

  test('本机 Core 不按远程标志误走旧目录；根失败可见且切会话清空旧树', () => {
    expect(source).toContain('const hasCoreFiles = ownsCoreResources(target)')
    expect(source).toContain('key={`${target.currentId}:${target.generation}:${props.sessionId}`}')
    expect(source).toContain('{...(hasCoreFiles ? { loadDirectory: loadCoreDirectory, fileOps: coreFileOps } : {})}')
    expect(source).toContain("role={fileRootsError ? 'alert' : undefined}")
    expect(source).toContain('effectiveSessionPath, sessionFileRoot, workspaceFilesPath')
  })

  test('面包屑跟随会话文件根', () => {
    expect(source).toContain('getLastPathSegments(sessionFileRoot ?? sessionPath')
  })
})
