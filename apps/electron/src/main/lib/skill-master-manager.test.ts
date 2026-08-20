import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setSkillMasterRoots,
  __resetSkillMasterRoots,
  listMasterSkillSlugs,
  listMasterSkills,
  readMasterSkillContent,
  saveMasterSkill,
  renameMasterSkillMeta,
  listMasterSkillHistory,
  rollbackMasterSkill,
  syncMasterSkillToWorkspace,
  detectSkillConflict,
  batchSyncMasterSkill,
} from './skill-master-manager'

interface TestRoots {
  master: string   // 元 skill 库：.../default-skills
  workspaces: string // 工作区根：.../workspaces（{slug}/skills/...）
}

const tempRoots: string[] = []

function makeTempRoots(): TestRoots {
  const base = mkdtempSync(join(tmpdir(), 'profer-master-'))
  tempRoots.push(base)
  return {
    master: join(base, 'default-skills'),
    workspaces: join(base, 'workspaces'),
  }
}

function writeFile(path: string, content = 'x'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function setupSkill(version = '1.0.0'): TestRoots {
  const roots = makeTempRoots()
  writeFile(
    join(roots.master, 'test-skill', 'SKILL.md'),
    `---\nname: 测试技能\nversion: ${version}\n---\n\n# 测试技能\n\n正文。\n`,
  )
  __setSkillMasterRoots(roots.master, roots.workspaces)
  return roots
}

function skillCopyPath(roots: TestRoots, ws: string): string {
  return join(roots.workspaces, ws, 'skills', 'test-skill', 'SKILL.md')
}

afterEach(() => {
  __resetSkillMasterRoots()
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!
    rmSync(root, { recursive: true, force: true })
  }
})

describe('skill-master-manager', () => {
  test('Given 元库含一个 skill When 列出并读取 Then 拿到元数据与内容', () => {
    setupSkill()
    expect(listMasterSkillSlugs()).toContain('test-skill')
    expect(readMasterSkillContent('test-skill')).toContain('# 测试技能')
    expect(readMasterSkillContent('test-skill')).toContain('version: 1.0.0')
  })

  test('Given 保存元 skill 覆盖内容 When 写入 Then 版本自动 patch+1 且生成历史快照', () => {
    const roots = setupSkill('1.2.0')
    const version = saveMasterSkill('test-skill', '---\nname: 测试技能\nversion: 1.2.0\n---\n\n# 测试技能 v2\n\n新增内容。\n')
    expect(version.version).toBe('1.2.1')
    expect(version.snapshotId).toBe('v1')
    expect(listMasterSkillHistory('test-skill').length).toBe(1)
    expect(listMasterSkillHistory('test-skill')[0]!.version).toBe('1.2.1')
    expect(existsSync(join(roots.master, '..', 'default-skills-history', 'test-skill', 'v1', 'SKILL.md'))).toBe(true)
  })

  test('Given 修改元数据 When renameMasterSkillMeta Then 只更新 frontmatter 名称，body 不变', () => {
    setupSkill()
    renameMasterSkillMeta('test-skill', { name: '改名技能' })
    const content = readMasterSkillContent('test-skill')
    expect(content).toContain('name: 改名技能')
    expect(content).toContain('正文')
  })

  test('Given 有历史快照 When 回退 Then 当前内容切回快照并追加新快照', () => {
    setupSkill('1.0.0')
    saveMasterSkill('test-skill', '---\nname: 测试技能\nversion: 1.0.0\n---\n\n# 测试技能 v2\n\n改动。\n')
    rollbackMasterSkill('test-skill', 'v1')
    expect(readMasterSkillContent('test-skill')).toContain('# 测试技能 v2')
    const history = listMasterSkillHistory('test-skill')
    expect(history.length).toBe(2)
    expect(history[1]!.snapshotId).toBe('v2')
    expect(history[1]!.note).toContain('回退自 v1')
  })

  test('Given 元 skill 同步到工作区 When 原样再次同步 Then 无冲突', () => {
    const roots = setupSkill()
    const result = syncMasterSkillToWorkspace('test-skill', 'ws-a')
    expect(result.success).toBe(true)
    expect(result.version).toBe('1.0.0')
    expect(existsSync(skillCopyPath(roots, 'ws-a'))).toBe(true)
    expect(detectSkillConflict('ws-a', 'test-skill').hasConflict).toBe(false)
  })

  test('Given 同步后用户改副本 When 非 force 再同步 Then 检测冲突并拒绝覆盖', () => {
    const roots = setupSkill()
    syncMasterSkillToWorkspace('test-skill', 'ws-a')
    writeFile(skillCopyPath(roots, 'ws-a'), '---\nname: 本地改\nversion: 1.0.0\n---\n\n本地改。\n')
    const conflict = detectSkillConflict('ws-a', 'test-skill')
    expect(conflict.hasConflict).toBe(true)
    expect(conflict.changedFiles.length).toBeGreaterThan(0)
    const result = syncMasterSkillToWorkspace('test-skill', 'ws-a')
    expect(result.success).toBe(false)
    expect(readFileSync(skillCopyPath(roots, 'ws-a'), 'utf-8')).toContain('本地改')
  })

  test('Given 有冲突 When force 覆盖同步 Then 副本被元 skill 覆盖', () => {
    const roots = setupSkill()
    syncMasterSkillToWorkspace('test-skill', 'ws-a')
    writeFile(skillCopyPath(roots, 'ws-a'), '---\nname: 本地改\n---\n\n本地改。\n')
    const result = syncMasterSkillToWorkspace('test-skill', 'ws-a', { force: true })
    expect(result.success).toBe(true)
    expect(readFileSync(skillCopyPath(roots, 'ws-a'), 'utf-8')).toContain('# 测试技能')
  })

  test('Given 批量同步到多工作区 When 其中一工作区本地改且未标注 Then 冲突的保留，其余覆盖', () => {
    const roots = setupSkill()
    syncMasterSkillToWorkspace('test-skill', 'ws-a')
    syncMasterSkillToWorkspace('test-skill', 'ws-b')
    writeFile(skillCopyPath(roots, 'ws-a'), '---\nname: 本地A\n---\n\nA。\n')
    const results = batchSyncMasterSkill('test-skill', ['ws-a', 'ws-b', 'ws-c'])
    expect(results.find((r) => r.workspaceSlug === 'ws-a')!.success).toBe(false)
    expect(results.find((r) => r.workspaceSlug === 'ws-b')!.success).toBe(true)
    expect(results.find((r) => r.workspaceSlug === 'ws-c')!.success).toBe(true)
  })

  test('Given 同步到多个工作区 When 列出元 skill Then syncedWorkspaceCount 正确统计（一次扫描，非逐 skill 重扫）', () => {
    setupSkill()
    syncMasterSkillToWorkspace('test-skill', 'ws-a')
    syncMasterSkillToWorkspace('test-skill', 'ws-b')
    const list = listMasterSkills()
    const skill = list.find((s) => s.slug === 'test-skill')
    expect(skill).toBeDefined()
    expect(skill!.syncedWorkspaceCount).toBe(2)
  })

  test('Given 历史 Coach slug When 同步 Then 写入当前 slug 与规范 Master 来源', () => {
    const roots = makeTempRoots()
    writeFile(
      join(roots.master, 'profer-coach', 'SKILL.md'),
      '---\nname: profer-coach\nversion: 1.0.3\n---\n\n# Profer Coach\n',
    )
    __setSkillMasterRoots(roots.master, roots.workspaces)

    const result = syncMasterSkillToWorkspace('proma-coach', 'ws-a')
    const source = JSON.parse(readFileSync(join(roots.workspaces, 'ws-a', 'skills', 'profer-coach', '.source.json'), 'utf-8'))

    expect(result.success).toBe(true)
    expect(existsSync(join(roots.workspaces, 'ws-a', 'skills', 'profer-coach', 'SKILL.md'))).toBe(true)
    expect(source.masterSlug).toBe('profer-coach')
  })
})
