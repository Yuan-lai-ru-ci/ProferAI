/**
 * 全局 Skill 新运行时加载链路冒烟测试（Claude + Pi）。
 * 两种 runtime 只消费同一个 prepareRuntimeSkills() 投影，不能再直接扫描旧 master。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@earendil-works/pi-coding-agent'
import { createProferSkillsOverride } from './adapters/pi-agent-adapter'
import {
  __resetGlobalSkillRoots,
  __setGlobalSkillRoots,
  copyGlobalSkillToWorkspace,
  prepareRuntimeSkills,
  resolveEffectiveSkills,
  seedBuiltinGlobalSkills,
  setGlobalSkillEnabled,
  listGlobalSkills,
  getRuntimeSkillsPath,
} from './global-skill-manager'

const tempRoots: string[] = []

function setup(): { global: string; workspaces: string; builtin: string } {
  const base = mkdtempSync(join(tmpdir(), 'profer-runtime-smoke-'))
  tempRoots.push(base)
  const global = join(base, 'global-skills')
  const workspaces = join(base, 'workspaces')
  const builtin = join(base, 'bundle')
  mkdirSync(join(builtin, 'demo'), { recursive: true })
  writeFileSync(join(builtin, 'demo', 'SKILL.md'), '---\nname: 演示\nversion: 1.0.0\n---\n\n# 演示\n')
  __setGlobalSkillRoots(global, workspaces)
  seedBuiltinGlobalSkills(builtin)
  return { global, workspaces, builtin }
}

function makePiSkill(root: string, slug: string): Skill {
  const baseDir = join(root, slug)
  return {
    name: slug,
    description: slug,
    filePath: join(baseDir, 'SKILL.md'),
    baseDir,
    sourceInfo: { path: baseDir, source: 'runtime-projection', scope: 'temporary', origin: 'top-level' },
    disableModelInvocation: false,
  }
}

afterEach(() => {
  __resetGlobalSkillRoots()
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('全局 Skill 运行时加载链路冒烟（Claude + Pi）', () => {
  test('同一个 projection 同时满足 Claude plugin root 与 Pi additionalSkillPaths', () => {
    setup()
    const projection = prepareRuntimeSkills('ws-a')
    const piRoot = getRuntimeSkillsPath(projection)
    const skill = makePiSkill(piRoot, 'demo')
    const result = createProferSkillsOverride([piRoot], undefined)({ skills: [skill], diagnostics: [] })

    expect(existsSync(join(projection.path, '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(piRoot, 'demo', 'SKILL.md'))).toBe(true)
    // 旧会话/工具使用的扁平路径也必须持续可读，并指向当前 fingerprint 投影。
    const compatibilityAlias = join(projection.path, '..', 'demo')
    expect(lstatSync(compatibilityAlias).isSymbolicLink()).toBe(true)
    expect(readlinkSync(compatibilityAlias)).toBe(join(projection.path, 'skills', 'demo'))
    expect(existsSync(join(compatibilityAlias, 'SKILL.md'))).toBe(true)
    expect(result.skills.map((item) => item.name)).toEqual(['demo'])
  })

  test('兼容路径会随 projection 更新并在 Skill 禁用后回收', () => {
    const paths = setup()
    const first = prepareRuntimeSkills('ws-a')
    const alias = join(first.path, '..', 'demo')
    expect(lstatSync(alias).isSymbolicLink()).toBe(true)
    expect(readlinkSync(alias)).toBe(join(first.path, 'skills', 'demo'))

    writeFileSync(join(paths.builtin, 'demo', 'SKILL.md'), '---\nname: 演示\nversion: 1.0.1\n---\n\n# 演示更新\n')
    seedBuiltinGlobalSkills(paths.builtin)
    const second = prepareRuntimeSkills('ws-a')
    expect(second.path).not.toBe(first.path)
    expect(readlinkSync(alias)).toBe(join(second.path, 'skills', 'demo'))
    expect(existsSync(join(alias, 'SKILL.md'))).toBe(true)

    const builtin = listGlobalSkills()[0]!
    setGlobalSkillEnabled('ws-a', builtin.skillId, false)
    prepareRuntimeSkills('ws-a')
    expect(existsSync(alias)).toBe(false)
  })

  test('两个 workspace 分别默认启用、禁用和替换时，projection 永远不重复加载', () => {
    setup()
    const builtin = listGlobalSkills()[0]!
    copyGlobalSkillToWorkspace(builtin.skillId, 'ws-replaced')
    setGlobalSkillEnabled('ws-disabled', builtin.skillId, false)

    expect(prepareRuntimeSkills('ws-default').skills.filter((item) => item.slug === 'demo')).toHaveLength(1)
    expect(prepareRuntimeSkills('ws-disabled').skills.filter((item) => item.slug === 'demo')).toHaveLength(0)
    expect(prepareRuntimeSkills('ws-replaced').skills.filter((item) => item.slug === 'demo')).toHaveLength(1)
    expect(resolveEffectiveSkills('ws-replaced').filter((item) => item.slug === 'demo')).toHaveLength(1)
  })

  test('Pi skillSlugs=[] 在有效 projection 上得到 0 个 skill', () => {
    setup()
    const projection = prepareRuntimeSkills('ws-empty')
    const piRoot = getRuntimeSkillsPath(projection)
    const skill = makePiSkill(piRoot, 'demo')
    const result = createProferSkillsOverride([piRoot], [])({ skills: [skill], diagnostics: [] })
    expect(result.skills).toEqual([])
  })
})
