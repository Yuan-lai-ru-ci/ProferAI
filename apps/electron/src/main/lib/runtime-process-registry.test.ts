import { describe, expect, test } from 'bun:test'
import {
  isLongRunningServiceCommand,
  matchRecordAgainstSnapshot,
  resolveServiceWorkingDirectory,
  type RuntimeProcessRecord,
} from './runtime-process-registry'

function makeRecord(overrides: Partial<RuntimeProcessRecord> = {}): RuntimeProcessRecord {
  return {
    id: 'rec-1', sessionId: 'sess-1', runtime: 'pi', source: 'pi-owned', launcher: 'bash',
    likelyService: true, command: 'npm run dev', cwd: 'D:/project/app', ports: [],
    launchedAt: 1_750_000_000_000, lastObservedAt: 1_750_000_000_000, status: 'pending',
    ...overrides,
  }
}

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

describe('matchRecordAgainstSnapshot（复用共享快照，避免逐记录全表扫描）', () => {
  const rec = (overrides: Partial<RuntimeProcessRecord>) => makeRecord(overrides)

  test('显式端口命中监听者（即使 cwd 不含项目路径）', () => {
    const record = rec({ command: 'astro dev --port 5177', cwd: 'D:/project/app' })
    const portPids = new Map([[5177, [1234]]])
    // node 子进程的命令行不含项目路径，但端口是硬证据
    const processes = new Map([[1234, { name: 'node.exe', cmd: 'node D:/tools/astro/bin/astro dev', startTime: 1_750_000_000_500 }]])
    expect(matchRecordAgainstSnapshot(record, portPids, processes)).toEqual({
      pid: 1234, startTime: 1_750_000_000_500, ports: [5177],
    })
  })

  test('无显式端口时按 cwd 内的命令关键字匹配', () => {
    const record = rec({ command: 'npm run dev', cwd: 'D:/project/app' })
    const portPids = new Map<number, number[]>()
    const processes = new Map([
      [9001, { name: 'node.exe', cmd: 'node D:/project/app/node_modules/vite/bin/vite.js dev', startTime: 1_750_000_000_800 }],
      [42, { name: 'notepad.exe', cmd: 'C:\\Windows\\notepad.exe', startTime: 1_750_000_000_999 }],
    ])
    const found = matchRecordAgainstSnapshot(record, portPids, processes)
    expect(found?.pid).toBe(9001)
  })

  test('启动时间早于记录太多视为不兼容（防 PID 转世）', () => {
    const record = rec({ command: 'npm run dev', cwd: 'D:/project/app', launchedAt: 1_750_000_000_000 })
    const portPids = new Map<number, number[]>()
    // 该进程 1 分钟前就启动了（远早于记录），不可能属于本记录
    const staleStart = 1_750_000_000_000 - 60_000
    const processes = new Map([
      [7001, { name: 'node.exe', cmd: 'node D:/project/app/index.js', startTime: staleStart }],
    ])
    expect(matchRecordAgainstSnapshot(record, portPids, processes)).toBeUndefined()
  })

  test('排除 SDK 自身进程，避免把 Agent 主进程当作服务', () => {
    const record = rec({ command: 'npm run dev', cwd: 'D:/project/app' })
    const portPids = new Map<number, number[]>()
    const processes = new Map([
      [31, { name: 'node.exe', cmd: 'node C:/tools/claude-agent-sdk/bin.js D:/project/app', startTime: 1_750_000_000_900 }],
    ])
    expect(matchRecordAgainstSnapshot(record, portPids, processes)).toBeUndefined()
  })
})
