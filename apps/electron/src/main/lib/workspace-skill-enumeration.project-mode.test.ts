/**
 * 技能枚举的工作区来源：索引 ∪ 目录（A3-3a）
 *
 * project 工作区的配置目录在项目内的 `.profer/`，不在 `agent-workspaces/` 下。
 * 只扫目录会让项目工作区从全局技能影响面、元 Skill 同步统计里整体消失，
 * 因此两个 manager 的枚举都必须以索引补齐（审计 §7.3）。
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configRoot = mkdtempSync(join(tmpdir(), 'profer-skill-enum-'))
process.env.PROFER_CONFIG_DIR = configRoot

const { __listWorkspaceSlugsForTest } = await import('./global-skill-manager')
const { countMasterSyncedAll } = await import('./skill-master-manager')

const projectRoot = join(configRoot, 'project-root')
const indexPath = join(configRoot, 'agent-workspaces.json')

afterAll(() => {
  delete process.env.PROFER_CONFIG_DIR
  rmSync(configRoot, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(indexPath, { force: true })
  rmSync(join(configRoot, 'agent-workspaces'), { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
})

function writeIndex(workspaces: Array<Record<string, unknown>>): void {
  mkdirSync(configRoot, { recursive: true })
  writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces }), 'utf-8')
}

function projectEntry(slug: string, rootPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${slug}`,
    name: slug,
    slug,
    createdAt: 1,
    updatedAt: 1,
    type: 'personal',
    storageMode: 'project',
    rootPath,
    ...extra,
  }
}

/** 写一个带 .source.json 的 skill 副本，供元 Skill 同步统计扫描。 */
function writeSyncedSkill(skillsRoot: string, skillSlug: string, masterSlug: string): void {
  const dir = join(skillsRoot, skillSlug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${skillSlug}\nversion: 1.0.0\n---\n\n# ${skillSlug}\n`, 'utf-8')
  writeFileSync(
    join(dir, '.source.json'),
    JSON.stringify({ sourceKind: 'master', masterSlug, sourceWorkspaceSlug: 'master', baselineVersion: '1.0.0' }),
    'utf-8',
  )
}

describe('技能枚举：索引里的工作区 ∪ 目录', () => {
  test('Given 一个 managed 目录 + 一个 project 工作区 When 枚举 Then 两者都在结果里', () => {
    mkdirSync(join(configRoot, 'agent-workspaces', 'managed-ws', 'skills'), { recursive: true })
    mkdirSync(projectRoot, { recursive: true })
    writeIndex([projectEntry('project-ws', projectRoot)])

    expect(__listWorkspaceSlugsForTest()).toEqual(['managed-ws', 'project-ws'])
  })

  test('Given 索引缺失 When 枚举 Then 退化为目录扫描，不抛错', () => {
    mkdirSync(join(configRoot, 'agent-workspaces', 'only-dir-ws', 'skills'), { recursive: true })

    expect(__listWorkspaceSlugsForTest()).toEqual(['only-dir-ws'])
  })

  test('Given 索引含软删除/损坏条目 When 枚举 Then 只保留可用工作区', () => {
    mkdirSync(projectRoot, { recursive: true })
    writeIndex([
      projectEntry('project-ws', projectRoot),
      projectEntry('deleted-ws', projectRoot, { isDeleted: true }),
      projectEntry('../escape', projectRoot),
    ])

    expect(__listWorkspaceSlugsForTest()).toEqual(['project-ws'])
  })

  test('Given 项目目录已不存在 When 枚举 Then 跳过该 project 工作区', () => {
    writeIndex([projectEntry('gone-ws', join(configRoot, 'missing-project-root'))])

    expect(__listWorkspaceSlugsForTest()).toEqual([])
    expect(countMasterSyncedAll().size).toBe(0)
  })

  test('Given project 工作区的 skills 含 .source.json When 统计元 Skill 同步 Then 计入该项目工作区', () => {
    writeSyncedSkill(join(configRoot, 'agent-workspaces', 'managed-ws', 'skills'), 'managed-checker', 'checker')
    writeSyncedSkill(join(projectRoot, '.profer', 'skills'), 'project-checker', 'checker')
    writeIndex([projectEntry('project-ws', projectRoot)])

    expect(countMasterSyncedAll().get('checker')).toBe(2)
  })

  test('Given project 工作区的 skills-inactive 含 .source.json When 统计 Then 一并计入', () => {
    writeSyncedSkill(join(projectRoot, '.profer', 'skills-inactive'), 'project-retired', 'checker')
    writeIndex([projectEntry('project-ws', projectRoot)])

    expect(countMasterSyncedAll().get('checker')).toBe(1)
  })
})
