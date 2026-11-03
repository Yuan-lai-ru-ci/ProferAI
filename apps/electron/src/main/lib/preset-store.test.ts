/**
 * PresetStore（P1-B）单测
 *
 * 覆盖规格 §2.4 / §2.5 与审计 §6–§8 的核心契约：
 * 1. project 模式按目录读写（`_config.json` + `<presetId>.json`），剥离运行时派生字段；
 * 2. managed 模式仍是单文件 `agent-presets.json`（零回归）；
 * 3. 目录不存在时读旧单文件，首次写入拆分且旧文件字节不变；
 * 4. 未知 schema 主版本只读：可列出、可选用，保存抛 `PRESET_WRITE_FAILED`；
 * 5. 单个文件损坏跳过 + `invalid-file` 诊断，文件不被删除；
 * 6. 默认引用 / 禁用清单持久化，删除默认预设回退 standard 并留诊断；
 * 7. 引用一致性诊断（missing-skill / missing-mcp / unavailable-mcp）只读；
 * 8. manager 的 CRUD 全部经 PresetStore（project 模式端到端）；
 * 9. 写锁（P2-B）：project 写事务互斥、重试后抛锁错误、陈旧锁清理规则、异常释放、managed 无锁。
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentPreset, AgentPresetConfig } from '@profer/shared'
import { AgentPresetError, BUILTIN_AGENT_PRESETS, DEFAULT_PRESET_ID } from '@profer/shared'

const sandbox = mkdtempSync(join(tmpdir(), 'profer-preset-store-'))
const configRoot = join(sandbox, 'config')
// config-root 每次调用都读环境变量，import 顺序不影响隔离。
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  presetStore,
  getPresetStorageMode,
  getPresetStoreDir,
  invalidatePresetStoreCache,
  PresetStoreLockedError,
  __setPresetStoreBaseDirForTest,
  __resetPresetStoreBaseDirForTest,
  __setPresetWriteLockObserverForTest,
} = await import('./preset-store')
const { invalidateWorkspaceLocation, WorkspaceRootMissingError } = await import('./workspace-locator')
const {
  createAgentPreset,
  updateAgentPreset,
  deleteAgentPreset,
  listAgentPresets,
  listAgentPresetDiagnostics,
  setDefaultPresetReference,
  getDefaultPresetId,
  __resetAgentPresetsBaseDirForTest,
} = await import('./agent-preset-manager')

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

interface WorkspaceEntry {
  id: string
  name: string
  slug: string
  createdAt: number
  updatedAt: number
  type: string
  storageMode: string
  rootPath?: string
}

let entries: WorkspaceEntry[] = []
let counter = 0

function writeWorkspacesIndex(): void {
  const indexPath = join(configRoot, 'agent-workspaces.json')
  mkdirSync(configRoot, { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces: entries }), 'utf-8')
  invalidateWorkspaceLocation()
  invalidatePresetStoreCache()
}

function addProject(): { slug: string; root: string } {
  const root = realpathSync(mkdtempSync(join(sandbox, 'proj-')))
  const slug = `proj-${++counter}`
  entries = [...entries, {
    id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1,
    type: 'personal', storageMode: 'project', rootPath: root,
  }]
  writeWorkspacesIndex()
  return { slug, root }
}

function addManaged(): { slug: string; configDir: string } {
  const slug = `managed-${++counter}`
  entries = [...entries, {
    id: `id-${slug}`, name: slug, slug, createdAt: 1, updatedAt: 1,
    type: 'personal', storageMode: 'managed',
  }]
  writeWorkspacesIndex()
  return { slug, configDir: join(configRoot, 'agent-workspaces', slug) }
}

function makePreset(overrides: Partial<AgentPreset> & { id: string }): AgentPreset {
  return {
    name: overrides.id,
    description: '',
    isBuiltin: false,
    version: '1.0.0',
    createdAt: 1762000000000,
    updatedAt: 1762000000000,
    ...overrides,
  }
}

function emptyConfig(presets: AgentPreset[] = [], patch: Partial<AgentPresetConfig> = {}): AgentPresetConfig {
  return {
    presets,
    defaultPresetId: DEFAULT_PRESET_ID,
    disabledGlobalPresetIds: [],
    disabledWorkspacePresetIds: [],
    ...patch,
  }
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
}

function catchError(fn: () => void): unknown {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

beforeEach(() => {
  entries = []
  writeWorkspacesIndex()
  rmSync(join(configRoot, 'agent-presets.json'), { force: true })
  rmSync(join(configRoot, 'agent-workspaces'), { recursive: true, force: true })
  __resetPresetStoreBaseDirForTest()
  __resetAgentPresetsBaseDirForTest()
  __setPresetWriteLockObserverForTest(null)
})

describe('project 模式：目录读写', () => {
  test('writeConfig 生成 presets/_config.json + <presetId>.json，且剥离运行时派生字段', () => {
    const { slug, root } = addProject()
    const preset = makePreset({
      id: 'preset-a',
      name: '代码审查',
      description: '只读审查',
      promptSections: ['你是代码审查岗位'],
      skillSlugs: ['code-review'],
      mcpServerNames: ['github'],
      // 运行时派生字段：不允许落盘
      scope: 'workspace',
      workspaceSlug: 'stale-machine-slug',
      enabledInWorkspace: true,
    })

    expect(getPresetStorageMode(slug)).toBe('project')
    expect(getPresetStoreDir(slug)).toBe(join(root, '.profer', 'presets'))

    presetStore.writeConfig(slug, emptyConfig([preset], {
      defaultPresetId: preset.id,
      defaultPresetReference: { presetId: preset.id, presetScope: 'workspace', workspaceSlug: slug },
      disabledGlobalPresetIds: ['global-release'],
    }))

    const presetsDir = join(root, '.profer', 'presets')
    expect(existsSync(join(presetsDir, '_config.json'))).toBe(true)
    const presetFile = readJson(join(presetsDir, 'preset-a.json'))
    expect(presetFile.schema).toBe('profer.preset/1')
    expect(presetFile.id).toBe('preset-a')
    expect(presetFile.name).toBe('代码审查')
    expect(presetFile.skillSlugs).toEqual(['code-review'])
    expect(presetFile.mcpServerNames).toEqual(['github'])
    expect(presetFile.scope).toBeUndefined()
    expect(presetFile.workspaceSlug).toBeUndefined()
    expect(presetFile.enabledInWorkspace).toBeUndefined()

    const configFile = readJson(join(presetsDir, '_config.json'))
    expect(configFile.schema).toBe('profer.presets/1')
    // workspace 引用落盘省略 workspaceSlug（设计 §5.4 规则 3：项目可 clone 到别的机器）
    expect(configFile.defaultPresetReference).toEqual({ presetId: 'preset-a', presetScope: 'workspace' })
    expect(configFile.disabledGlobalPresetIds).toEqual(['global-release'])
    // presets 数组的唯一真相是目录里的文件
    expect(configFile.presets).toBeUndefined()

    // 读回：作用域按当前工作区补齐
    const readBack = presetStore.readConfig(slug)
    expect(readBack.presets.map((item) => item.id)).toEqual(['preset-a'])
    expect(readBack.presets[0]?.scope).toBe('workspace')
    expect(readBack.presets[0]?.workspaceSlug).toBe(slug)
    expect(readBack.defaultPresetReference?.presetId).toBe('preset-a')
  })

  test('内置预设不落盘；非法 presetId 拒绝写入（防路径穿越）', () => {
    const { slug, root } = addProject()
    presetStore.writeConfig(slug, emptyConfig([...BUILTIN_AGENT_PRESETS]))

    const presetsDir = join(root, '.profer', 'presets')
    for (const builtin of BUILTIN_AGENT_PRESETS) {
      expect(existsSync(join(presetsDir, `${builtin.id}.json`))).toBe(false)
    }

    expect(() => presetStore.writePreset(slug, makePreset({ id: '../evil' }))).toThrow()
  })

  test('未知字段 round-trip 保留（_config.json 与单预设文件）', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    writeFileSync(join(presetsDir, '_config.json'), JSON.stringify({
      schema: 'profer.presets/1',
      disabledGlobalPresetIds: [],
      disabledWorkspacePresetIds: [],
      futureWorkspaceFlag: { keep: true },
    }), 'utf-8')
    writeFileSync(join(presetsDir, 'preset-x.json'), JSON.stringify({
      schema: 'profer.preset/1',
      id: 'preset-x',
      name: 'X',
      description: '',
      isBuiltin: false,
      createdAt: 1,
      updatedAt: 1,
      futureField: 'keep-me',
    }), 'utf-8')

    const read = presetStore.readConfig(slug)
    expect(read.presets[0]?.id).toBe('preset-x')
    presetStore.writeConfig(slug, { ...read, disabledGlobalPresetIds: ['global-a'] })

    expect(readJson(join(presetsDir, '_config.json')).futureWorkspaceFlag).toEqual({ keep: true })
    expect(readJson(join(presetsDir, 'preset-x.json')).futureField).toBe('keep-me')
  })
})

describe('managed 模式：单文件零回归', () => {
  test('仍写 agent-presets.json，不生成 presets 目录', () => {
    const { slug, configDir } = addManaged()
    // manager 读出的预设会带 scope/workspaceSlug；managed 单文件保持原样落盘
    const preset = makePreset({ id: 'managed-preset', name: 'Managed', scope: 'workspace', workspaceSlug: slug })

    presetStore.writeConfig(slug, emptyConfig([preset]))

    const filePath = join(configDir, 'agent-presets.json')
    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(join(configDir, 'presets'))).toBe(false)
    expect(getPresetStoreDir(slug)).toBeNull()
    expect(getPresetStorageMode(slug)).toBe('managed')

    const raw = readJson(filePath)
    const written = (raw.presets as AgentPreset[])[0]
    expect(written?.id).toBe('managed-preset')
    // managed 保持改造前行为：运行时字段照旧落盘
    expect(written?.workspaceSlug).toBe(slug)

    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['managed-preset'])
  })

  test('测试基础目录覆盖把 project 条目强制按 managed 解析（老测试替身语义）', () => {
    const { slug } = addProject()
    const baseDir = mkdtempSync(join(sandbox, 'override-'))
    __setPresetStoreBaseDirForTest(baseDir)
    try {
      expect(getPresetStorageMode(slug)).toBe('managed')
      presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'override-preset' })]))
      expect(existsSync(join(baseDir, slug, 'agent-presets.json'))).toBe(true)
    } finally {
      __resetPresetStoreBaseDirForTest()
    }
  })
})

describe('旧单文件兼容', () => {
  test('目录不存在时读旧单文件；首次写入拆分，旧文件字节不变', () => {
    const { slug, root } = addProject()
    const legacyPath = join(root, '.profer', 'agent-presets.json')
    mkdirSync(join(root, '.profer'), { recursive: true })
    writeFileSync(legacyPath, JSON.stringify({
      presets: [{ id: 'legacy-1', name: '旧岗位', description: '', isBuiltin: false, createdAt: 1, updatedAt: 1 }],
      defaultPresetId: 'legacy-1',
      disabledGlobalPresetIds: ['global-x'],
    }, null, 2), 'utf-8')
    const before = readFileSync(legacyPath, 'utf-8')

    const read = presetStore.readConfig(slug)
    expect(read.presets.map((item) => item.id)).toEqual(['legacy-1'])
    expect(read.defaultPresetId).toBe('legacy-1')

    // manager 读取后会传入「解析后的配置」；这里模拟同样的写入
    presetStore.writeConfig(slug, read)

    expect(readFileSync(legacyPath, 'utf-8')).toBe(before)
    const presetsDir = join(root, '.profer', 'presets')
    expect(existsSync(join(presetsDir, 'legacy-1.json'))).toBe(true)
    const configFile = readJson(join(presetsDir, '_config.json'))
    expect(configFile.legacySource).toMatchObject({ file: 'agent-presets.json' })
    expect(configFile.disabledGlobalPresetIds).toEqual(['global-x'])

    // 目录已生效：旧文件被忽略，只留诊断
    const kinds = presetStore.listDiagnostics(slug).map((item) => item.kind)
    expect(kinds).toContain('legacy-preset-file-ignored')
  })

  test('旧文件损坏：返回空配置 + invalid-file，不创建空目录覆盖', () => {
    const { slug, root } = addProject()
    const legacyPath = join(root, '.profer', 'agent-presets.json')
    mkdirSync(join(root, '.profer'), { recursive: true })
    writeFileSync(legacyPath, '{ broken json', 'utf-8')

    expect(presetStore.readConfig(slug).presets).toEqual([])
    expect(presetStore.listDiagnostics(slug).map((item) => item.kind)).toContain('invalid-file')
    expect(existsSync(join(root, '.profer', 'presets'))).toBe(false)
  })
})

/** 写一份旧单文件（`.profer/agent-presets.json`），返回其路径。 */
function writeLegacyPresets(root: string, presets: Array<{ id: string; name: string }>): string {
  const legacyPath = join(root, '.profer', 'agent-presets.json')
  mkdirSync(join(root, '.profer'), { recursive: true })
  writeFileSync(legacyPath, JSON.stringify({
    presets: presets.map((preset) => ({
      id: preset.id, name: preset.name, description: '', isBuiltin: false, createdAt: 1, updatedAt: 1,
    })),
    defaultPresetId: presets[0]?.id ?? DEFAULT_PRESET_ID,
    disabledGlobalPresetIds: [],
    disabledWorkspacePresetIds: [],
  }, null, 2), 'utf-8')
  return legacyPath
}

describe('P1-4 目录权威只认 presets/_config.json', () => {
  test('只有空 presets/ + 旧单文件 When 读取 Then 读到旧岗位 + legacy-fallback 诊断', () => {
    const { slug, root } = addProject()
    writeLegacyPresets(root, [{ id: 'legacy-1', name: '旧岗位' }])
    // 首次拆分失败 / 目录被手工创建：目录在，但从没提交过 _config.json
    mkdirSync(join(root, '.profer', 'presets'), { recursive: true })

    const read = presetStore.readConfig(slug)
    expect(read.presets.map((item) => item.id)).toEqual(['legacy-1'])
    expect(read.defaultPresetId).toBe('legacy-1')
    const kinds = presetStore.listDiagnostics(slug).map((item) => item.kind)
    expect(kinds).toContain('legacy-fallback')
    // 旧文件不是「被忽略」：它正在被读取
    expect(kinds).not.toContain('legacy-preset-file-ignored')
  })

  test('首次拆分中途失败 When 再次读取 Then 旧岗位仍在、目录不是权威', () => {
    const { slug, root } = addProject()
    const legacyPath = writeLegacyPresets(root, [{ id: 'legacy-1', name: '旧岗位' }])
    const legacyBefore = readFileSync(legacyPath, 'utf-8')
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(join(presetsDir, 'blocked.json'), { recursive: true })

    let thrown: unknown
    try {
      // legacy-1.json 会先写出，blocked.json 写入失败 → 回滚 legacy-1.json，_config.json 从未写入
      presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'legacy-1' }), makePreset({ id: 'blocked' })]))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentPresetError)
    expect(existsSync(join(presetsDir, '_config.json'))).toBe(false)
    expect(readFileSync(legacyPath, 'utf-8')).toBe(legacyBefore)

    // 失败后用户重新打开岗位页：旧单文件里的岗位必须还在
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['legacy-1'])
    expect(presetStore.listDiagnostics(slug).map((item) => item.kind)).toContain('legacy-fallback')

    // 下一次成功写入仍然是「首次拆分」：补 legacySource 且先写预设文件、最后写 _config.json
    const after = presetStore.readConfig(slug)
    presetStore.writeConfig(slug, after)
    const configFile = readJson(join(presetsDir, '_config.json'))
    expect(configFile.legacySource).toMatchObject({ file: 'agent-presets.json' })
    expect(existsSync(join(presetsDir, 'legacy-1.json'))).toBe(true)
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['legacy-1'])
  })

  test('有 _config.json When 读取 Then 目录权威，旧单文件只留诊断', () => {
    const { slug, root } = addProject()
    writeLegacyPresets(root, [{ id: 'legacy-1', name: '旧岗位' }])
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    writeFileSync(join(presetsDir, '_config.json'), JSON.stringify({
      schema: 'profer.presets/1', disabledGlobalPresetIds: [], disabledWorkspacePresetIds: [],
    }), 'utf-8')
    writeFileSync(join(presetsDir, 'dir-1.json'), JSON.stringify({
      schema: 'profer.preset/1', id: 'dir-1', name: '目录岗位', description: '', isBuiltin: false, createdAt: 1, updatedAt: 1,
    }), 'utf-8')

    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['dir-1'])
    const kinds = presetStore.listDiagnostics(slug).map((item) => item.kind)
    expect(kinds).toContain('legacy-preset-file-ignored')
    expect(kinds).not.toContain('legacy-fallback')
  })

  test('managed 单文件 When 读取 Then 不受影响，无 legacy-fallback 诊断', () => {
    const { slug, configDir } = addManaged()
    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'managed-1' })]))

    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['managed-1'])
    expect(presetStore.listDiagnostics(slug).map((item) => item.kind)).not.toContain('legacy-fallback')
    expect(existsSync(join(configDir, 'presets'))).toBe(false)
  })
})

describe('schema 与损坏文件', () => {
  test('未知 schema 主版本：可读不可写，文件不被改写', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    const configPath = join(presetsDir, '_config.json')
    const presetPath = join(presetsDir, 'p1.json')
    writeFileSync(configPath, JSON.stringify({
      schema: 'profer.presets/2',
      disabledGlobalPresetIds: [],
      disabledWorkspacePresetIds: [],
    }), 'utf-8')
    writeFileSync(presetPath, JSON.stringify({
      schema: 'profer.preset/1', id: 'p1', name: 'P1', description: '', isBuiltin: false, createdAt: 1, updatedAt: 1,
    }), 'utf-8')
    const configBefore = readFileSync(configPath, 'utf-8')

    const read = presetStore.readConfig(slug)
    expect(read.presets.map((item) => item.id)).toEqual(['p1'])
    expect(presetStore.listDiagnostics(slug).some((item) => item.kind === 'unknown-schema')).toBe(true)

    let thrown: unknown
    try {
      presetStore.writeConfig(slug, { ...read, disabledGlobalPresetIds: ['x'] })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentPresetError)
    expect((thrown as AgentPresetError).code).toBe('PRESET_WRITE_FAILED')
    expect(readFileSync(configPath, 'utf-8')).toBe(configBefore)
  })

  test('单预设文件 schema 未知：可读；不改时允许保存，改写时拒绝且文件不变', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    writeFileSync(join(presetsDir, '_config.json'), JSON.stringify({
      schema: 'profer.presets/1', disabledGlobalPresetIds: [], disabledWorkspacePresetIds: [],
    }), 'utf-8')
    const presetPath = join(presetsDir, 'future.json')
    writeFileSync(presetPath, JSON.stringify({
      schema: 'profer.preset/2', id: 'future', name: '未来版本岗位', description: '', isBuiltin: false, createdAt: 1, updatedAt: 1,
    }), 'utf-8')
    const before = readFileSync(presetPath, 'utf-8')

    const read = presetStore.readConfig(slug)
    expect(read.presets.map((item) => item.id)).toEqual(['future'])
    expect(presetStore.listDiagnostics(slug)).toContainEqual(expect.objectContaining({ kind: 'unknown-schema', ref: 'future.json' }))

    // 未改动该预设 → 允许保存其他字段
    expect(() => presetStore.writeConfig(slug, { ...read, disabledGlobalPresetIds: ['g'] })).not.toThrow()
    expect(readFileSync(presetPath, 'utf-8')).toBe(before)

    // 试图改写它 → 拒绝（不静默丢弃编辑）
    let thrown: unknown
    try {
      presetStore.writeConfig(slug, { ...read, presets: [{ ...read.presets[0]!, name: '改名' }] })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentPresetError)
    expect((thrown as AgentPresetError).code).toBe('PRESET_WRITE_FAILED')
    expect(readFileSync(presetPath, 'utf-8')).toBe(before)
  })

  test('单个文件损坏：跳过 + invalid-file，其他预设正常，坏文件不被删除', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    writeFileSync(join(presetsDir, '_config.json'), JSON.stringify({
      schema: 'profer.presets/1', disabledGlobalPresetIds: [], disabledWorkspacePresetIds: [],
    }), 'utf-8')
    writeFileSync(join(presetsDir, 'ok-1.json'), JSON.stringify({
      schema: 'profer.preset/1', id: 'ok-1', name: 'OK 1', description: '', isBuiltin: false, createdAt: 1, updatedAt: 1,
    }), 'utf-8')
    writeFileSync(join(presetsDir, 'broken.json'), '{ not json', 'utf-8')

    const read = presetStore.readConfig(slug)
    expect(read.presets.map((item) => item.id)).toEqual(['ok-1'])
    const diagnostics = presetStore.listDiagnostics(slug)
    expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'invalid-file', ref: 'broken.json' }))

    // 编辑另一个预设不会误删坏文件（保留人工修复机会）
    presetStore.writeConfig(slug, { ...read, disabledGlobalPresetIds: ['g1'] })
    expect(existsSync(join(presetsDir, 'broken.json'))).toBe(true)
  })
})

describe('写入失败与回滚', () => {
  test('中途失败只回滚本次新建文件，既有文件与失败目标原样保留', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'keep' })]))
    const keepBefore = readFileSync(join(presetsDir, 'keep.json'), 'utf-8')

    // 目标路径被目录占位：`blocked.json` 写入必失败；前一个 `new-good.json` 则应被回滚删除
    mkdirSync(join(presetsDir, 'blocked.json'))

    let thrown: unknown
    try {
      presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'keep' }), makePreset({ id: 'new-good' }), makePreset({ id: 'blocked' })]))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AgentPresetError)
    expect((thrown as AgentPresetError).code).toBe('PRESET_WRITE_FAILED')
    expect(existsSync(join(presetsDir, 'new-good.json'))).toBe(false)
    expect(readFileSync(join(presetsDir, 'keep.json'), 'utf-8')).toBe(keepBefore)
    expect(existsSync(join(presetsDir, 'blocked.json'))).toBe(true)
  })
})

describe('默认引用与禁用清单', () => {
  test('默认引用 / 禁用清单持久化；删除默认预设回退 standard 并留诊断', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    presetStore.writeConfig(slug, emptyConfig([
      makePreset({ id: 'p1', name: 'P1' }),
      makePreset({ id: 'p2', name: 'P2' }),
    ], {
      defaultPresetId: 'p1',
      defaultPresetReference: { presetId: 'p1', presetScope: 'workspace', workspaceSlug: slug },
      disabledGlobalPresetIds: ['global-a'],
      disabledWorkspacePresetIds: ['p2'],
    }))

    let configFile = readJson(join(presetsDir, '_config.json'))
    expect(configFile.defaultPresetReference).toMatchObject({ presetId: 'p1' })
    expect(configFile.disabledWorkspacePresetIds).toEqual(['p2'])

    // 不存在的 id 在读取时被裁掉（与 managed 现有逻辑一致）
    presetStore.writeConfig(slug, { ...presetStore.readConfig(slug), disabledWorkspacePresetIds: ['p1', 'ghost'] })
    configFile = readJson(join(presetsDir, '_config.json'))
    expect(configFile.disabledWorkspacePresetIds).toEqual(['p1'])

    presetStore.deletePreset(slug, 'p1')
    expect(existsSync(join(presetsDir, 'p1.json'))).toBe(false)
    configFile = readJson(join(presetsDir, '_config.json'))
    expect(configFile.defaultPresetReference).toEqual({ presetId: DEFAULT_PRESET_ID, presetScope: 'builtin-meta' })
    expect(configFile.defaultPresetId).toBe(DEFAULT_PRESET_ID)
    expect(configFile.migrationDiagnostics).toContainEqual(expect.objectContaining({ presetId: 'p1', status: 'default-missing' }))
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['p2'])
  })

  test('writePreset / readPreset / deletePreset 与配置级字段保持一致', () => {
    const { slug } = addProject()
    presetStore.writePreset(slug, makePreset({ id: 'only', name: 'Only' }))
    expect(presetStore.readPreset(slug, 'only')?.name).toBe('Only')

    presetStore.writePreset(slug, makePreset({ id: 'only', name: 'Only 2', updatedAt: 5 }))
    expect(presetStore.readPreset(slug, 'only')?.name).toBe('Only 2')
    expect(presetStore.readConfig(slug).presets).toHaveLength(1)

    presetStore.deletePreset(slug, 'only')
    expect(presetStore.readPreset(slug, 'only')).toBeNull()
    expect(presetStore.readConfig(slug).presets).toEqual([])
  })
})

describe('引用一致性诊断（只读）', () => {
  test('missing-skill / missing-mcp / unavailable-mcp 在 listDiagnostics 返回，且不改文件', () => {
    const { slug, root } = addProject()
    const proferDir = join(root, '.profer')
    mkdirSync(proferDir, { recursive: true })
    writeFileSync(join(proferDir, 'mcp.json'), JSON.stringify({
      servers: {
        github: { type: 'stdio', command: 'gh', enabled: true },
        'off-server': { type: 'stdio', command: 'off', enabled: false },
      },
    }), 'utf-8')

    presetStore.writeConfig(slug, emptyConfig([
      makePreset({ id: 'p1', name: 'P1', skillSlugs: ['ghost-skill'], mcpServerNames: ['github', 'ghost-mcp', 'off-server'] }),
    ]))
    const presetPath = join(proferDir, 'presets', 'p1.json')
    const before = readFileSync(presetPath, 'utf-8')

    const diagnostics = presetStore.listDiagnostics(slug)
    expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'missing-skill', ref: 'ghost-skill', presetId: 'p1' }))
    expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'missing-mcp', ref: 'ghost-mcp', presetId: 'p1' }))
    expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'unavailable-mcp', ref: 'off-server', presetId: 'p1' }))
    expect(diagnostics.some((item) => item.kind === 'missing-mcp' && item.ref === 'github')).toBe(false)

    // 诊断不得改写预设文件（A14：白名单原样保留，保存后字节不变）
    expect(readFileSync(presetPath, 'utf-8')).toBe(before)
  })
})

describe('manager 集成：CRUD 全部经 PresetStore', () => {
  test('project 模式创建 / 更新 / 删除预设落到 presets/ 目录，不生成旧单文件', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')

    const created = createAgentPreset(slug, {
      name: '项目岗位',
      skillSlugs: ['code-review'],
    } as Parameters<typeof createAgentPreset>[1])
    expect(existsSync(join(presetsDir, `${created.id}.json`))).toBe(true)
    expect(existsSync(join(root, '.profer', 'agent-presets.json'))).toBe(false)

    // 默认引用：文件里不含 workspaceSlug，读回时按当前工作区注入（A13 可 clone）
    setDefaultPresetReference(slug, { presetId: created.id, presetScope: 'workspace' })
    const writtenReference = readJson(join(presetsDir, '_config.json')).defaultPresetReference as Record<string, unknown>
    expect(writtenReference).toEqual({ presetId: created.id, presetScope: 'workspace' })
    expect(getDefaultPresetId(slug)).toBe(created.id)

    const renamed = updateAgentPreset(slug, created.id, { name: '项目岗位 2' })
    expect(renamed.name).toBe('项目岗位 2')
    // 重命名只改文件内容，不移动文件（文件名 = 稳定 id）
    expect(existsSync(join(presetsDir, `${created.id}.json`))).toBe(true)
    expect(listAgentPresets(slug).some((preset) => preset.id === created.id)).toBe(true)

    deleteAgentPreset(slug, created.id)
    expect(existsSync(join(presetsDir, `${created.id}.json`))).toBe(false)
    expect(listAgentPresets(slug).some((preset) => preset.id === created.id)).toBe(false)
    // 诊断入口经 manager 透传（只读，不抛错）
    expect(Array.isArray(listAgentPresetDiagnostics(slug))).toBe(true)
  })

  test('project 模式默认配置读取与 managed 一致（standard 默认）', () => {
    const { slug } = addProject()
    const presets = listAgentPresets(slug)
    expect(presets.filter((preset) => preset.isBuiltin).map((preset) => preset.id)).toEqual(BUILTIN_AGENT_PRESETS.map((preset) => preset.id))
    expect(presetStore.readConfig(slug).presets).toEqual([])
  })
})

describe('写锁（P2-B：同一项目的多实例互斥）', () => {
  function lockPathOf(root: string): string {
    return join(root, '.profer', 'presets', '.lock')
  }

  /** 模拟「另一个 Profer 实例正持有锁」（等效于 `openSync(path, 'wx')` 成功后的状态）。 */
  function holdLock(root: string, holder: { pid: number; createdAt: number; operation: string }): string {
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    const lockPath = lockPathOf(root)
    writeFileSync(lockPath, JSON.stringify(holder), 'utf-8')
    return lockPath
  }

  /** 已退出进程的 pid（`process.kill(pid, 0)` 必返回 ESRCH），用于陈旧锁用例。 */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = child.pid
    if (typeof pid !== 'number' || pid <= 0) throw new Error('无法取得已退出进程的 pid')
    return pid
  }

  test('写事务内持有 presets/.lock（pid / createdAt / operation），结束后释放', () => {
    const { slug, root } = addProject()
    const lockPath = lockPathOf(root)
    const observed: Array<{ pid: number; createdAt: number; operation: string; exists: boolean }> = []

    __setPresetWriteLockObserverForTest((path) => {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as { pid: number; createdAt: number; operation: string }
      observed.push({ ...raw, exists: existsSync(path) })
    })
    try {
      presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })]))
      presetStore.writePreset(slug, makePreset({ id: 'p2' }))
      presetStore.deletePreset(slug, 'p2')
    } finally {
      __setPresetWriteLockObserverForTest(null)
    }

    // 三个写入口各自带上自己的 operation 标签
    expect(observed.map((item) => item.operation)).toEqual(['writeConfig', 'writePreset', 'deletePreset'])
    expect(observed.every((item) => item.exists)).toBe(true)
    expect(observed.every((item) => item.pid === process.pid)).toBe(true)
    expect(observed.every((item) => Number.isFinite(item.createdAt) && Date.now() - item.createdAt < 10_000)).toBe(true)

    // 事务结束即释放；读路径既不阻塞也不创建锁
    expect(existsSync(lockPath)).toBe(false)
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['p1'])
    expect(existsSync(lockPath)).toBe(false)
  })

  test('锁被占用：重试 3 次后抛 PresetStoreLockedError（约 150ms），不写任何文件、不删别人的锁', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'before' })]))
    const before = readFileSync(join(presetsDir, 'before.json'), 'utf-8')
    const lockPath = holdLock(root, { pid: process.pid, createdAt: Date.now(), operation: 'writeConfig' })

    const startedAt = Date.now()
    const error = catchError(() => presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'after' })])))
    const elapsedMs = Date.now() - startedAt

    expect(error).toBeInstanceOf(PresetStoreLockedError)
    expect(error).toBeInstanceOf(AgentPresetError)
    const locked = error as InstanceType<typeof PresetStoreLockedError>
    expect(locked.code).toBe('PRESET_CONCURRENT_UPDATE')
    expect(locked.lockPath).toBe(lockPath)
    expect(locked.holder).toEqual({ pid: process.pid, createdAt: expect.any(Number), operation: 'writeConfig' })
    expect(locked.attempts).toBe(4)
    // 3 次重试 × 50ms（放宽到 140ms，避免调度抖动误报）
    expect(elapsedMs).toBeGreaterThanOrEqual(140)

    // 被挡住的写没有产生任何副作用
    expect(existsSync(join(presetsDir, 'after.json'))).toBe(false)
    expect(readFileSync(join(presetsDir, 'before.json'), 'utf-8')).toBe(before)
    // 别人的锁不能被我方失败路径删掉
    expect(existsSync(lockPath)).toBe(true)
  })

  test('锁释放后（文件被移除）写入恢复', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    const lockPath = holdLock(root, { pid: process.pid, createdAt: Date.now(), operation: 'writeConfig' })

    expect(catchError(() => presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })]))))
      .toBeInstanceOf(PresetStoreLockedError)

    unlinkSync(lockPath)
    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })]))
    expect(existsSync(join(presetsDir, 'p1.json'))).toBe(true)
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['p1'])
    expect(existsSync(lockPath)).toBe(false)
  })

  test('陈旧锁：createdAt 超过 30 秒且 pid 已不存在 → 清理后写入成功', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    const lockPath = holdLock(root, { pid: deadPid(), createdAt: Date.now() - 60_000, operation: 'writePreset' })

    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })]))

    expect(existsSync(join(presetsDir, 'p1.json'))).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  test('陈旧但 pid 存活（60 秒前的锁）→ 绝不抢锁', () => {
    const { slug, root } = addProject()
    const lockPath = holdLock(root, { pid: process.pid, createdAt: Date.now() - 60_000, operation: 'writeConfig' })

    const error = catchError(() => presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })])))

    expect(error).toBeInstanceOf(PresetStoreLockedError)
    expect((error as InstanceType<typeof PresetStoreLockedError>).holder?.pid).toBe(process.pid)
    expect(existsSync(lockPath)).toBe(true)
  })

  test('pid 已不存在但锁未超时 → 不清理（可能刚拿到锁还没写完内容）', () => {
    const { slug, root } = addProject()
    const lockPath = holdLock(root, { pid: deadPid(), createdAt: Date.now(), operation: 'writeConfig' })

    expect(catchError(() => presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })]))))
      .toBeInstanceOf(PresetStoreLockedError)
    expect(existsSync(lockPath)).toBe(true)
  })

  test('锁内容不可读（空文件）→ 持有者未知，不抢锁、不静默删除', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    const lockPath = join(presetsDir, '.lock')
    writeFileSync(lockPath, '', 'utf-8')

    const error = catchError(() => presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })])))

    expect(error).toBeInstanceOf(PresetStoreLockedError)
    expect((error as InstanceType<typeof PresetStoreLockedError>).holder).toBeNull()
    expect(existsSync(lockPath)).toBe(true)
  })

  test('写事务内部异常（目标被目录占位）时锁仍被释放，紧接着的写入可成功', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'keep' })]))
    mkdirSync(join(presetsDir, 'blocked.json'))

    const error = catchError(() => presetStore.writeConfig(
      slug,
      emptyConfig([makePreset({ id: 'keep' }), makePreset({ id: 'blocked' })]),
    ))
    expect(error).toBeInstanceOf(AgentPresetError)
    expect((error as AgentPresetError).code).toBe('PRESET_WRITE_FAILED')
    expect(existsSync(join(presetsDir, '.lock'))).toBe(false)

    // 失败不会把自己的锁留下：下一次写入不该被锁挡住
    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'keep' })]))
    expect(existsSync(join(presetsDir, '.lock'))).toBe(false)
  })

  test('managed 后端不加锁：不创建 presets/ 与 .lock，写入照常', () => {
    const { slug, configDir } = addManaged()

    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'm1' })]))

    expect(existsSync(join(configDir, 'agent-presets.json'))).toBe(true)
    expect(existsSync(join(configDir, 'presets'))).toBe(false)
    expect(existsSync(join(configDir, 'presets', '.lock'))).toBe(false)
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['m1'])
  })

  test('真实第二个进程持锁：存活 pid 不抢锁；进程退出后陈旧锁被清理', async () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    const lockPath = lockPathOf(root)

    // 子进程模拟另一个 Profer 实例：写下 60 秒前的锁（age 已超阈值，但 pid 活着）
    const script = [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60000, operation: 'writeConfig' }))`,
      "console.log('ready')",
      'setTimeout(() => process.exit(0), 600)',
    ].join('\n')
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })

    // 握手：子进程写完锁才继续，避免测试跑在锁创建之前
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ''
    while (!output.includes('ready')) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value)
    }
    expect(output).toContain('ready')

    const lockedError = catchError(() => presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })])))
    expect(lockedError).toBeInstanceOf(PresetStoreLockedError)
    expect((lockedError as InstanceType<typeof PresetStoreLockedError>).holder?.pid).toBe(child.pid)
    // 持有进程存活 → 即使锁已 60 秒也不清理
    expect(existsSync(lockPath)).toBe(true)

    await child.exited
    // 进程退出后同一把锁变成陈旧锁：清理后写入成功
    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p1' })]))
    expect(existsSync(join(presetsDir, 'p1.json'))).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe('P0-1 删除路径穿越防护', () => {
  test('内容 id 非法（../../package）的文件不采纳，删除不会删到项目 package.json', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    writeFileSync(join(presetsDir, '_config.json'), JSON.stringify({
      schema: 'profer.presets/1', disabledGlobalPresetIds: [], disabledWorkspacePresetIds: [],
    }), 'utf-8')
    writeFileSync(join(presetsDir, 'x.json'), JSON.stringify({
      schema: 'profer.preset/1', id: '../../package', name: 'X', description: '', isBuiltin: false, createdAt: 1, updatedAt: 1,
    }), 'utf-8')
    const packagePath = join(root, 'package.json')
    writeFileSync(packagePath, '{"name":"project"}', 'utf-8')

    // 不通过白名单的 id 必须整文件剔除，不能只记诊断继续采纳
    expect(presetStore.readConfig(slug).presets).toEqual([])
    expect(presetStore.listDiagnostics(slug)).toContainEqual(
      expect.objectContaining({ kind: 'invalid-file', ref: 'x.json', presetId: '../../package', detail: 'invalid-id' }),
    )

    // 删除该 id 不会进入任何写事务，更不会 unlink 到项目根
    const error = catchError(() => presetStore.deletePreset(slug, '../../package'))
    expect(error).toBeInstanceOf(AgentPresetError)
    expect((error as AgentPresetError).code).toBe('PRESET_NOT_FOUND')
    expect(existsSync(packagePath)).toBe(true)
    expect(readFileSync(packagePath, 'utf-8')).toBe('{"name":"project"}')
    // 非法文件本身也不被删除（留给人工修复）
    expect(existsSync(join(presetsDir, 'x.json'))).toBe(true)
    expect(existsSync(join(presetsDir, '.lock'))).toBe(false)
  })

  test('正常预设删除仍然成功', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    presetStore.writeConfig(slug, emptyConfig([
      makePreset({ id: 'keep', name: 'KEEP' }),
      makePreset({ id: 'drop', name: 'DROP' }),
    ]))

    presetStore.deletePreset(slug, 'drop')

    expect(existsSync(join(presetsDir, 'drop.json'))).toBe(false)
    expect(existsSync(join(presetsDir, 'keep.json'))).toBe(true)
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['keep'])
    expect(existsSync(join(presetsDir, '.lock'))).toBe(false)
  })

  test('文件名与 id 不一致的合法文件：按真实文件名删除，不误删、不生成同名新文件', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')
    mkdirSync(presetsDir, { recursive: true })
    writeFileSync(join(presetsDir, '_config.json'), JSON.stringify({
      schema: 'profer.presets/1',
      disabledGlobalPresetIds: [],
      disabledWorkspacePresetIds: ['p1'],
    }), 'utf-8')
    writeFileSync(join(presetsDir, 'custom-name.json'), JSON.stringify({
      schema: 'profer.preset/1', id: 'p1', name: 'P1', description: '', isBuiltin: false, createdAt: 1, updatedAt: 1,
    }), 'utf-8')
    writeFileSync(join(presetsDir, 'other.json'), JSON.stringify({
      schema: 'profer.preset/1', id: 'other', name: 'OTHER', description: '', isBuiltin: false, createdAt: 1, updatedAt: 1,
    }), 'utf-8')

    // 合法 id + 文件名不一致：仍然采纳（只留诊断），删除要回到真实文件名
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['p1', 'other'])
    expect(presetStore.listDiagnostics(slug)).toContainEqual(
      expect.objectContaining({ kind: 'invalid-file', ref: 'custom-name.json', presetId: 'p1', detail: 'filename-mismatch' }),
    )

    presetStore.deletePreset(slug, 'p1')

    expect(existsSync(join(presetsDir, 'custom-name.json'))).toBe(false)
    expect(existsSync(join(presetsDir, 'p1.json'))).toBe(false)
    expect(existsSync(join(presetsDir, 'other.json'))).toBe(true)
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['other'])
  })
})

describe('P0-2 rootPath 缺失时写入不重建项目目录', () => {
  test('project root 被移走：保存抛 WorkspaceRootMissingError，root 与父链都不被重建', () => {
    const { slug, root } = addProject()
    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'kept', name: 'KEPT' })]))
    expect(existsSync(join(root, '.profer', 'presets', 'kept.json'))).toBe(true)

    // 模拟项目被移动 / 外接盘未挂载
    rmSync(root, { recursive: true, force: true })
    expect(existsSync(root)).toBe(false)

    const writeError = catchError(() => presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'ghost' })])))
    expect(writeError).toBeInstanceOf(WorkspaceRootMissingError)
    expect((writeError as InstanceType<typeof WorkspaceRootMissingError>).rootPath).toBe(root)

    const presetError = catchError(() => presetStore.writePreset(slug, makePreset({ id: 'ghost-2' })))
    expect(presetError).toBeInstanceOf(WorkspaceRootMissingError)

    // 关键回归：root 绝不被 mkdir 重建（否则会遮蔽挂载点 / 让项目凭空变空）
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(root, '.profer'))).toBe(false)
    expect(existsSync(join(root, '.profer', 'presets'))).toBe(false)
  })

  test('root 存在时正常写入仍成功（含首次创建 presets/ 与锁释放）', () => {
    const { slug, root } = addProject()
    const presetsDir = join(root, '.profer', 'presets')

    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'p-live', name: 'LIVE' })]))

    expect(existsSync(join(presetsDir, 'p-live.json'))).toBe(true)
    expect(existsSync(join(presetsDir, '_config.json'))).toBe(true)
    expect(existsSync(join(presetsDir, '.lock'))).toBe(false)
    expect(presetStore.readConfig(slug).presets.map((item) => item.id)).toEqual(['p-live'])
  })

  test('managed 写入行为不变：configDir 不存在时仍自动创建单文件', () => {
    const { slug, configDir } = addManaged()
    rmSync(configDir, { recursive: true, force: true })

    presetStore.writeConfig(slug, emptyConfig([makePreset({ id: 'm-live' })]))

    expect(existsSync(join(configDir, 'agent-presets.json'))).toBe(true)
    expect(existsSync(join(configDir, 'presets'))).toBe(false)
  })
})
