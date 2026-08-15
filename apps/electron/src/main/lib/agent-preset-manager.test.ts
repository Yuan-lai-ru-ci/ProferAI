/**
 * agent-preset-manager 单元测试（工作区级）
 *
 * 覆盖：内置预设加载、未知 ID 回退、默认预设读写、会话预设规范化、
 * 工作区隔离、无工作区行为。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentPreset } from '@profer/shared'
import {
  listAgentPresets,
  getAgentPreset,
  getDefaultPresetId,
  setDefaultPresetId,
  normalizeSessionPresetId,
  createAgentPreset,
  copyAgentPreset,
  updateAgentPreset,
  deleteAgentPreset,
  __setAgentPresetsBaseDirForTest,
  __resetAgentPresetsBaseDirForTest,
} from './agent-preset-manager'
import {
  BUILTIN_PRESET_STANDARD,
  BUILTIN_PRESET_CODE,
  BUILTIN_PRESET_MINIMAL,
  DEFAULT_PRESET_ID,
} from '@profer/shared'

const WS_A = 'ws-a'
const WS_B = 'ws-b'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agent-preset-test-'))
  __setAgentPresetsBaseDirForTest(tmpDir)
})

afterEach(() => {
  __resetAgentPresetsBaseDirForTest()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('listAgentPresets', () => {
  test('极简内置预设声明禁用产品工具组与 suppress 段落（提示词与工具一致）', () => {
    const presets = listAgentPresets(WS_A)
    const minimal = presets.find((p) => p.id === 'minimal')
    expect(minimal).toBeDefined()
    expect(minimal!.disabledToolGroups).toEqual(['task-graph', 'memory', 'collaboration'])
    expect(minimal!.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph'])
  })

  test('无配置时返回三个内置预设', () => {
    const presets = listAgentPresets(WS_A)
    expect(presets.length).toBe(3)
    const ids = presets.map((p) => p.id)
    expect(ids).toContain(BUILTIN_PRESET_STANDARD)
    expect(ids).toContain(BUILTIN_PRESET_CODE)
    expect(ids).toContain(BUILTIN_PRESET_MINIMAL)
  })

  test('内置预设均标记 isBuiltin，且 standard 无提示词段（行为与默认一致）', () => {
    const presets = listAgentPresets(WS_A)
    for (const preset of presets) {
      expect(preset.isBuiltin).toBe(true)
    }
    const standard = presets.find((p) => p.id === BUILTIN_PRESET_STANDARD)!
    expect(standard.promptSections).toBeUndefined()
    const minimal = presets.find((p) => p.id === BUILTIN_PRESET_MINIMAL)!
    expect(minimal.promptSections?.length).toBeGreaterThan(0)
  })

  test('无工作区时仅返回内置三预设', () => {
    expect(listAgentPresets(undefined).length).toBe(3)
    expect(listAgentPresets(undefined).every((p) => p.isBuiltin)).toBe(true)
  })
})

describe('getAgentPreset', () => {
  test('未知/缺失 ID 回退 standard', () => {
    expect(getAgentPreset(WS_A, undefined).id).toBe(BUILTIN_PRESET_STANDARD)
    expect(getAgentPreset(WS_A, 'nonexistent').id).toBe(BUILTIN_PRESET_STANDARD)
  })

  test('按 ID 返回对应预设', () => {
    expect(getAgentPreset(WS_A, BUILTIN_PRESET_MINIMAL).id).toBe(BUILTIN_PRESET_MINIMAL)
  })
})

describe('默认预设', () => {
  test('无配置时默认 standard', () => {
    expect(getDefaultPresetId(WS_A)).toBe(DEFAULT_PRESET_ID)
    expect(getDefaultPresetId(undefined)).toBe(DEFAULT_PRESET_ID)
  })

  test('setDefaultPresetId 持久化并规范化未知 ID', () => {
    expect(setDefaultPresetId(WS_A, BUILTIN_PRESET_CODE)).toBe(BUILTIN_PRESET_CODE)
    expect(getDefaultPresetId(WS_A)).toBe(BUILTIN_PRESET_CODE)
    // 坏 ID 回退 standard 且落盘
    expect(setDefaultPresetId(WS_A, 'bad-id')).toBe(DEFAULT_PRESET_ID)
    expect(getDefaultPresetId(WS_A)).toBe(DEFAULT_PRESET_ID)
    // 配置文件存在且内容正确
    expect(existsSync(join(tmpDir, WS_A, 'agent-presets.json'))).toBe(true)
    const raw = JSON.parse(readFileSync(join(tmpDir, WS_A, 'agent-presets.json'), 'utf-8'))
    expect(raw.defaultPresetId).toBe(DEFAULT_PRESET_ID)
  })
})

describe('normalizeSessionPresetId', () => {
  test('历史会话缺省回退 standard', () => {
    expect(normalizeSessionPresetId(WS_A, undefined)).toBe(DEFAULT_PRESET_ID)
  })

  test('已知内置 ID 原样返回', () => {
    expect(normalizeSessionPresetId(WS_A, BUILTIN_PRESET_MINIMAL)).toBe(BUILTIN_PRESET_MINIMAL)
  })

  test('未知 ID 回退 standard', () => {
    expect(normalizeSessionPresetId(WS_A, 'legacy-custom')).toBe(DEFAULT_PRESET_ID)
  })

  test('已知自定义预设 ID 原样保留（不被误回退 standard）', () => {
    const created = createAgentPreset(WS_A, { name: '岗位A', description: '' })
    expect(normalizeSessionPresetId(WS_A, created.id)).toBe(created.id)
    // 重读配置后仍保留
    expect(normalizeSessionPresetId(WS_A, created.id)).toBe(created.id)
  })

  test('其他工作区的自定义 ID 在本工作区回退 standard（隔离）', () => {
    const other = createAgentPreset(WS_B, { name: 'B区岗位', description: '' })
    expect(normalizeSessionPresetId(WS_A, other.id)).toBe(DEFAULT_PRESET_ID)
    expect(normalizeSessionPresetId(WS_B, other.id)).toBe(other.id)
  })
})

describe('自定义预设 CRUD', () => {
  test('createAgentPreset 新建并持久化，list 可见', () => {
    const created = createAgentPreset(WS_A, {
      name: '研究模式',
      description: '只读调研',
      skillSlugs: ['web-search'],
      effort: 'high',
    })
    expect(created.id).toBeTruthy()
    expect(created.isBuiltin).toBe(false)

    const presets = listAgentPresets(WS_A)
    expect(presets.length).toBe(4)
    expect(presets.find((p) => p.id === created.id)?.name).toBe('研究模式')
    expect(getAgentPreset(WS_A, created.id).id).toBe(created.id)
  })

  test('名称为空拒绝创建', () => {
    expect(() => createAgentPreset(WS_A, { name: '  ', description: '' })).toThrow('预设名称不能为空')
  })

  test('工作区隔离：A 区自定义预设对 B 区不可见', () => {
    createAgentPreset(WS_A, { name: 'A区专属', description: '' })
    expect(listAgentPresets(WS_A).length).toBe(4)
    expect(listAgentPresets(WS_B).length).toBe(3)
  })

  test('无工作区创建自定义预设被拒绝', () => {
    expect(() => createAgentPreset(undefined, { name: '无区预设', description: '' })).toThrow()
  })

  test('copyAgentPreset 复制内置并保留配置字段', () => {
    const copy = copyAgentPreset(WS_A, BUILTIN_PRESET_MINIMAL, '我的极简')
    expect(copy.name).toBe('我的极简')
    expect(copy.id).not.toBe(BUILTIN_PRESET_MINIMAL)
    expect(copy.isBuiltin).toBe(false)
    expect(copy.promptSections).toEqual(getAgentPreset(WS_A, BUILTIN_PRESET_MINIMAL).promptSections)
    expect(listAgentPresets(WS_A).some((p) => p.id === copy.id)).toBe(true)
  })

  test('复制极简预设保留 suppressPromptSections 与 disabledToolGroups（三层一致）', () => {
    const copy = copyAgentPreset(WS_A, BUILTIN_PRESET_MINIMAL, '极简副本')
    expect(copy.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph'])
    expect(copy.disabledToolGroups).toEqual(['task-graph', 'memory', 'collaboration'])
  })

  test('创建自定义预设支持 suppressPromptSections 与 disabledToolGroups', () => {
    const created = createAgentPreset(WS_A, {
      name: '轻量',
      description: '只保留核心能力',
      suppressPromptSections: ['subagents', 'memory', 'task-graph'],
      disabledToolGroups: ['task-graph', 'memory', 'collaboration'],
    })
    expect(created.suppressPromptSections).toEqual(['subagents', 'memory', 'task-graph'])
    expect(created.disabledToolGroups).toEqual(['task-graph', 'memory', 'collaboration'])
  })

  test('创建预设拒绝非法 suppress key 与工具组（含具体非法项）', () => {
    expect(() => createAgentPreset(WS_A, {
      name: '脏数据',
      description: '',
      suppressPromptSections: ['memory', 'bad-key'] as unknown as AgentPreset['suppressPromptSections'],
    })).toThrow(/非法的提示词段 key: bad-key/)
    expect(() => createAgentPreset(WS_A, {
      name: '脏数据2',
      description: '',
      disabledToolGroups: ['memory', 'bad-group'] as unknown as AgentPreset['disabledToolGroups'],
    })).toThrow(/非法的工具组: bad-group/)
    // 拒绝后不残留任何记录
    expect(listAgentPresets(WS_A).some((p) => p.name === '脏数据' || p.name === '脏数据2')).toBe(false)
  })

  test('更新预设拒绝非法 suppress key（传 null 清除不受影响）', () => {
    const created = createAgentPreset(WS_A, { name: '校验目标', description: '' })
    expect(() => updateAgentPreset(WS_A, created.id, {
      suppressPromptSections: ['automation', 'ghost'] as unknown as AgentPreset['suppressPromptSections'],
    })).toThrow(/非法的提示词段 key: ghost/)
    // null 清除路径不受校验影响
    const cleared = updateAgentPreset(WS_A, created.id, { suppressPromptSections: null })
    expect(cleared.suppressPromptSections).toBeUndefined()
  })

  test('读取配置时过滤历史脏数据中的非法 suppress key 与工具组', () => {
    const dir = join(tmpDir, WS_A)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent-presets.json'), JSON.stringify({
      defaultPresetId: 'standard',
      presets: [{
        id: 'dirty-preset',
        name: '历史脏数据',
        description: '',
        isBuiltin: false,
        createdAt: 0,
        updatedAt: 0,
        suppressPromptSections: ['memory', 'bogus-key'],
        disabledToolGroups: ['task-graph', 'bogus-group'],
      }],
    }))
    const presets = listAgentPresets(WS_A)
    const dirty = presets.find((p) => p.id === 'dirty-preset')
    expect(dirty).toBeDefined()
    expect(dirty?.suppressPromptSections).toEqual(['memory'])
    expect(dirty?.disabledToolGroups).toEqual(['task-graph'])
  })

  test('updateAgentPreset 更新字段；空数组清空可选字段', () => {
    const created = createAgentPreset(WS_A, { name: '原始', description: 'd', skillSlugs: ['a'] })
    const updated = updateAgentPreset(WS_A, created.id, {
      name: '改名',
      skillSlugs: [],
      effort: 'low',
    })
    expect(updated.name).toBe('改名')
    expect(updated.skillSlugs).toBeUndefined()
    expect(updated.effort).toBe('low')
    expect(listAgentPresets(WS_A).find((p) => p.id === created.id)?.name).toBe('改名')
  })

  test('updateAgentPreset 传 null 清除 effort/permissionMode/allowSubagents 与工具组', () => {
    const created = createAgentPreset(WS_A, {
      name: '全配置',
      description: 'd',
      effort: 'high',
      permissionMode: 'plan',
      allowSubagents: false,
      disabledToolGroups: ['task-graph', 'memory'],
      suppressPromptSections: ['memory'],
      promptSections: ['## 段1'],
    })
    const updated = updateAgentPreset(WS_A, created.id, {
      effort: null,
      permissionMode: null,
      allowSubagents: null,
      disabledToolGroups: null,
      suppressPromptSections: null,
      promptSections: null,
    })
    expect(updated.effort).toBeUndefined()
    expect(updated.permissionMode).toBeUndefined()
    expect(updated.allowSubagents).toBeUndefined()
    expect(updated.disabledToolGroups).toBeUndefined()
    expect(updated.suppressPromptSections).toBeUndefined()
    expect(updated.promptSections).toBeUndefined()
  })

  test('内置预设拒绝更新与删除', () => {
    expect(() => updateAgentPreset(WS_A, BUILTIN_PRESET_CODE, { name: 'x' })).toThrow('内置预设不可修改或删除')
    expect(() => deleteAgentPreset(WS_A, BUILTIN_PRESET_CODE)).toThrow('内置预设不可修改或删除')
  })

  test('删除自定义预设；默认引用回退 standard', () => {
    const created = createAgentPreset(WS_A, { name: '临时', description: '' })
    setDefaultPresetId(WS_A, created.id)
    expect(getDefaultPresetId(WS_A)).toBe(created.id)

    deleteAgentPreset(WS_A, created.id)
    expect(listAgentPresets(WS_A).some((p) => p.id === created.id)).toBe(false)
    expect(getDefaultPresetId(WS_A)).toBe(DEFAULT_PRESET_ID)
  })

  test('自定义预设可设为默认并在重读后保持', () => {
    const created = createAgentPreset(WS_A, { name: '默认候选', description: '' })
    expect(setDefaultPresetId(WS_A, created.id)).toBe(created.id)
    // 重新读配置（模拟重启）后仍是自定义默认
    expect(getDefaultPresetId(WS_A)).toBe(created.id)
  })

  test('不存在预设的更新/删除抛错', () => {
    expect(() => updateAgentPreset(WS_A, 'no-such-id', { name: 'x' })).toThrow('预设不存在')
    expect(() => deleteAgentPreset(WS_A, 'no-such-id')).toThrow('预设不存在')
  })

  test('跨工作区更新/删除被拒绝（预设不存在）', () => {
    const created = createAgentPreset(WS_A, { name: 'A区', description: '' })
    expect(() => updateAgentPreset(WS_B, created.id, { name: 'x' })).toThrow('预设不存在')
    expect(() => deleteAgentPreset(WS_B, created.id)).toThrow('预设不存在')
  })
})
