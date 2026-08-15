/**
 * skill 运行时加载链路冒烟测试（Claude + Pi 两种 runtime 视角）
 *
 * 无头验证：同步到工作区的元 skill 副本，最终落在两种 runtime 都会读取的
 * 同一个物理目录 `{workspace}/skills/`：
 *   - Claude：plugins:[{type:'local', path: getAgentWorkspacePath(ws)}]，
 *     SDK 通过 `.claude-plugin/plugin.json` 发现插件，skills 位于插件根 `skills/`。
 *   - Pi：additionalSkillPaths:[getWorkspaceSkillsDir(ws)] = `{ws}/skills/`。
 *
 * 本测试在临时根目录用真实同步函数落盘，再按两种 entry 的目录约定断言
 * 哨兵文件存在，从而证明「同步产物能被两种 runtime 入口发现」。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setSkillMasterRoots,
  __resetSkillMasterRoots,
  syncMasterSkillToWorkspace,
  listMasterSkillSlugs,
} from './skill-master-manager'

const tempRoots: string[] = []

function makeTemp(): { master: string; workspaces: string } {
  const base = mkdtempSync(join(tmpdir(), 'profer-runtime-smoke-'))
  tempRoots.push(base)
  return { master: join(base, 'default-skills'), workspaces: join(base, 'workspaces') }
}

function writeFile(path: string, content = 'x'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  __resetSkillMasterRoots()
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()!
    rmSync(root, { recursive: true, force: true })
  }
})

describe('skill 运行时加载链路冒烟（Claude + Pi）', () => {
  test('Given 元库含 skill 且同步到工作区 Then Claude 插件入口能发现 SKILL.md', () => {
    const roots = makeTemp()
    writeFile(join(roots.master, 'demo', 'SKILL.md'), '---\nname: 演示\nversion: 1.0.0\n---\n\n# 演示\n')
    __setSkillMasterRoots(roots.master, roots.workspaces)

    // 模拟 orchestrator ensurePluginManifest 落在工作区根 .claude-plugin/
    // （工作区根 = skills 目录的上一级，与 skills/ 平级）
    const wsRoot = join(roots.workspaces, 'ws-a')
    writeFile(join(wsRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'profer-workspace-ws-a', version: '1.0.0' }))
    // 真实同步：把元 skill 写入 {wsRoot}/skills/{slug}
    const result = syncMasterSkillToWorkspace('demo', 'ws-a')
    expect(result.success).toBe(true)

    // Claude 入口：{wsRoot}/skills/{slug}/SKILL.md（plugin 根下 skills/ 子目录）
    expect(existsSync(join(wsRoot, '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(existsSync(join(wsRoot, 'skills', 'demo', 'SKILL.md'))).toBe(true)

    // 清理被同步时 workspaceSkillsDirOf 自动创建的目录（不影响断言）
    rmSync(join(roots.workspaces, 'ws-a'), { recursive: true, force: true })
  })

  test('Given 同步一个 skill Then Pi additionalSkillPaths 指向的目录包含该 skill', () => {
    const roots = makeTemp()
    writeFile(join(roots.master, 'demo', 'SKILL.md'), '---\nname: 演示\nversion: 1.0.0\n---\n\n# 演示\n')
    __setSkillMasterRoots(roots.master, roots.workspaces)

    const result = syncMasterSkillToWorkspace('demo', 'ws-pi')
    expect(result.success).toBe(true)

    // Pi 入口：additionalSkillPaths = getWorkspaceSkillsDir(ws) = {ws}/skills
    const piSkillDir = join(roots.workspaces, 'ws-pi', 'skills', 'demo')
    expect(existsSync(join(piSkillDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(piSkillDir, '.source.json'))).toBe(true) // 来源标记随副本下发

    rmSync(join(roots.workspaces, 'ws-pi'), { recursive: true, force: true })
  })

  test('Given 元库可列出 Then 说明同步前提（master 可读）成立，两 runtime 都能拿到注入源', () => {
    const roots = makeTemp()
    writeFile(join(roots.master, 'demo', 'SKILL.md'), '---\nname: 演示\nversion: 1.0.0\n---\n\n# 演示\n')
    __setSkillMasterRoots(roots.master, roots.workspaces)
    expect(listMasterSkillSlugs()).toContain('demo')
  })

  test('Given 元库可列出 Then 说明同步前提（master 可读）成立，两 runtime 都能拿到注入源', () => {
    const roots = makeTemp()
    writeFile(join(roots.master, 'demo', 'SKILL.md'), '---\nname: 演示\nversion: 1.0.0\n---\n\n# 演示\n')
    __setSkillMasterRoots(roots.master, roots.workspaces)
    expect(listMasterSkillSlugs()).toContain('demo')
  })
})
