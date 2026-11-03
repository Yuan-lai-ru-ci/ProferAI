import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXPORTED_PI_STATE_ENTRY,
  mergePiStatesForImport,
  pickPiStatesForExport,
  readExportedPiState,
  splitInlinePiState,
} from './session-index-pi-state-export'

let root = ''
let indexPath = ''
let piStatePath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'profer-pi-state-export-'))
  indexPath = join(root, 'agent-sessions.json')
  piStatePath = join(root, 'agent-sessions-pi-state.json')
  writeFileSync(indexPath, JSON.stringify({ version: 1, sessions: [] }), 'utf-8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writePiState(states: Record<string, unknown>): void {
  writeFileSync(piStatePath, JSON.stringify({ version: 1, states }), 'utf-8')
}

describe('备份导出/导入 Pi 状态', () => {
  test('Given 本机有 Pi 状态 When 只导出部分会话 Then 只带这些会话的条目', () => {
    writePiState({
      s1: { piFileCheckpoints: { e1: '/cp/s1/e1' } },
      s2: { piEntryBindings: { m1: 'e1' } },
    })

    const picked = pickPiStatesForExport(indexPath, ['s1'])
    expect(picked?.states).toEqual({ s1: { piFileCheckpoints: { e1: '/cp/s1/e1' } } })
  })

  test('Given 本机没有 Pi 状态文件 When 导出 Then 返回 null 不写空文件', () => {
    expect(pickPiStatesForExport(indexPath, ['s1'])).toBeNull()
  })

  test('Given 备份带旁路 Pi 状态 When 导入新会话 Then 合并进本机且不覆盖已有条目', () => {
    writePiState({ s1: { piEntryBindings: { local: 'keep' } } })
    const sidecar = { version: 1, states: { s1: { piEntryBindings: { remote: 'drop' } }, s2: { piEntryBindings: { remote: 'take' } } } }

    const changed = mergePiStatesForImport(indexPath, ['s1', 's2'], [sidecar])
    expect(changed).toBe(true)

    const merged = JSON.parse(readFileSync(piStatePath, 'utf-8')) as { states: Record<string, unknown> }
    expect(merged.states.s1).toEqual({ piEntryBindings: { local: 'keep' } })
    expect(merged.states.s2).toEqual({ piEntryBindings: { remote: 'take' } })
  })

  test('Given 旧备份把 Pi 字段内联在索引里 When 导入 Then 内联状态同样被合并', () => {
    const inline = { version: 1, states: { s9: { piFileCheckpoints: { e9: '/cp/s9/e9' } } } }

    const changed = mergePiStatesForImport(indexPath, ['s9'], [inline])
    expect(changed).toBe(true)
    const merged = JSON.parse(readFileSync(piStatePath, 'utf-8')) as { states: Record<string, unknown> }
    expect(merged.states.s9).toEqual({ piFileCheckpoints: { e9: '/cp/s9/e9' } })
  })

  test('Given 没有可合并的来源 When 导入 Then 不写盘', () => {
    expect(mergePiStatesForImport(indexPath, ['s1'], [null, undefined])).toBe(false)
    expect(mergePiStatesForImport(indexPath, [], [{ version: 1, states: { s1: {} } }])).toBe(false)
  })

  test('Given 旧备份索引条目带 Pi 大字段 When 拆分 Then 索引侧不再包含它们', () => {
    const { inline, rest } = splitInlinePiState({
      id: 's1',
      title: 'old backup',
      piEntryBindings: { m1: 'e1' },
      piFileCheckpoints: { e1: '/cp/s1/e1' },
    })

    expect(inline).toEqual({ piEntryBindings: { m1: 'e1' }, piFileCheckpoints: { e1: '/cp/s1/e1' } })
    expect(rest).toEqual({ id: 's1', title: 'old backup' })
  })

  test('Given 备份目录里有旁路文件 When 读取 Then 返回解析结果，损坏时返回 null', () => {
    const tempDir = join(root, 'backup')
    mkdirSync(join(tempDir, 'sessions'), { recursive: true })
    writeFileSync(
      join(tempDir, EXPORTED_PI_STATE_ENTRY),
      JSON.stringify({ version: 1, states: { s1: { piEntryBindings: { m: 'e' } } } }),
      'utf-8',
    )
    expect(readExportedPiState(tempDir)?.states.s1).toEqual({ piEntryBindings: { m: 'e' } })

    writeFileSync(join(tempDir, EXPORTED_PI_STATE_ENTRY), 'broken', 'utf-8')
    expect(readExportedPiState(tempDir)).toBeNull()
  })
})
