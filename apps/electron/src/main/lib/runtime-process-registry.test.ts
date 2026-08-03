import { describe, expect, test } from 'bun:test'
import { isLongRunningServiceCommand, resolveServiceWorkingDirectory } from './runtime-process-registry'

describe('runtime process registry classification', () => {
  test('只将持续服务命令登记为 owned 候选', () => {
    expect(isLongRunningServiceCommand('cd D:/project/app && astro dev --port 5177')).toBe(true)
    expect(isLongRunningServiceCommand('npm run dev')).toBe(true)
    expect(isLongRunningServiceCommand('docker compose up')).toBe(true)
    expect(isLongRunningServiceCommand('git status')).toBe(false)
    expect(isLongRunningServiceCommand('bun test')).toBe(false)
  })

  test('优先使用命令显式 cd 的外部项目目录，而非会话临时 cwd', () => {
    expect(resolveServiceWorkingDirectory(
      'cd "D:/project/astroship-eval" && astro dev --port 5177',
      'C:/Users/me/.profer-dev/agent-workspaces/profer/session-a',
    )).toBe('D:/project/astroship-eval')
  })

  test('无显式 cd 时保持 Pi 实际 cwd', () => {
    expect(resolveServiceWorkingDirectory('npm run dev', 'D:/project/app')).toBe('D:/project/app')
  })
})
