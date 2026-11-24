import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mirrorProjectSessionIndexes } from './project-session-index'
import type { AgentWorkspace } from '@profer/shared'

test('项目镜像创建子目录期间根被删除，不递归重建项目', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'profer-project-mirror-'))
  const root = join(temporary, 'project')
  mkdirSync(root)
  let reads = 0
  const workspace = { id: 'project', storageMode: 'project', get rootPath() {
    // usable 校验后、实际镜像前模拟用户移除项目。
    if (++reads === 4) rmSync(root, { recursive: true })
    return root
  } } as AgentWorkspace
  try {
    expect(() => mirrorProjectSessionIndexes({ version: 1, sessions: [] }, [workspace])).toThrow()
    expect(existsSync(root)).toBe(false)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})
