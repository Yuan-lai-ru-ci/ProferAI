/**
 * 工作区技能路由卡片（SKILL.json）写入链路的契约。
 *
 * 这条链路是「用户在技能详情里填触发词与依赖」的实际落地点：UI → IPC → 工作区技能目录。
 * 盯三件事：写入后读取能拿到、清空后文件真的消失（回到回退路径）、非法输入不落盘。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetGlobalSkillRoots, __setGlobalSkillRoots } from './global-skill-manager'
import { createWorkspaceSkill, readWorkspaceSkillCard, writeWorkspaceSkillCard } from './agent-workspace-manager'

// 工作区技能目录来自 config-paths（而不是 global-skill-manager 的测试替身），必须显式隔离配置根目录，
// 否则会在真实的 ~/.profer-dev/agent-workspaces/ 里留下测试技能。
const isolatedConfigRoot = mkdtempSync(join(tmpdir(), 'profer-workspace-skill-card-config-'))
process.env.PROFER_CONFIG_DIR = isolatedConfigRoot

const roots: string[] = [isolatedConfigRoot]
afterEach(() => {
  __resetGlobalSkillRoots()
  while (roots.length > 1) rmSync(roots.pop()!, { recursive: true, force: true })
})

let workspaceCounter = 0
/** 工作区技能目录由 config-paths 决定（PROFER_CONFIG_DIR 下），与 global-skill-manager 的测试替身无关。 */
function cardFile(slug: string): string {
  return join(isolatedConfigRoot, 'agent-workspaces', slug, 'skills', 'carded', 'SKILL.json')
}

function setup(): { slug: string } {
  const base = mkdtempSync(join(tmpdir(), 'profer-workspace-skill-card-'))
  roots.push(base)
  const global = join(base, 'global-skills')
  const workspaces = join(base, 'workspaces')
  mkdirSync(global, { recursive: true })
  mkdirSync(workspaces, { recursive: true })
  __setGlobalSkillRoots(global, workspaces)
  // 每个用例用独立工作区 slug：隔离配置根目录在整个文件内共享，同名工作区会把上一用例的技能留下。
  const slug = `ws-${++workspaceCounter}`
  createWorkspaceSkill(slug, 'carded', '卡片技能', '用于把数据画成图表的演示技能，写入卡片后路由才会用到。', '# 卡片技能\n')
  return { slug }
}

describe('工作区技能卡片：读写链路', () => {
  test('没有卡片时读取为 present=false，且不报错', () => {
    const { slug } = setup()
    const state = readWorkspaceSkillCard(slug, 'carded')
    expect(state.present).toBe(false)
    expect(state.manifest).toBeUndefined()
    expect(state.issues).toEqual([])
  })

  test('写入触发词与依赖后能读回；没有工具清单时不瞎报依赖缺失', () => {
    const { slug } = setup()
    const written = writeWorkspaceSkillCard(slug, 'carded', {
      triggers: { keywords: ['柱状图', '折线图'] },
      dependencies: { toolGroups: ['preview'], tools: ['present_visualization'] },
    })
    expect(written.present).toBe(true)
    expect(written.manifest?.triggers?.keywords).toEqual(['柱状图', '折线图'])
    expect(written.manifest?.dependencies?.toolGroups).toEqual(['preview'])
    // 保存时没有运行时工具清单：医生不能凭空断言依赖可用或不可用（依赖门禁在路由时按真实清单判定）。
    expect(written.doctor.filter(issue => issue.severity === 'error')).toEqual([])
    expect(written.doctor.map(issue => issue.code)).not.toContain('dependency-tool-unavailable')

    const reread = readWorkspaceSkillCard(slug, 'carded')
    expect(reread.present).toBe(true)
    expect(reread.manifest?.dependencies?.tools).toEqual(['present_visualization'])
  })

  test('清空后卡片文件被删除，回到无卡片回退路径', () => {
    const { slug } = setup()
    writeWorkspaceSkillCard(slug, 'carded', { policy: { implicit: false } })
    const file = cardFile(slug)
    expect(existsSync(file)).toBe(true)

    const cleared = writeWorkspaceSkillCard(slug, 'carded', { policy: null })
    expect(cleared.present).toBe(false)
    expect(existsSync(file)).toBe(false)
  })

  test('非法输入报错且不落盘；不存在的技能直接拒绝', () => {
    const { slug } = setup()
    const file = cardFile(slug)
    expect(() => writeWorkspaceSkillCard(slug, 'carded', { triggers: { keywords: ['x'.repeat(200)] } })).toThrow(/校验未通过/)
    expect(existsSync(file)).toBe(false)
    expect(() => writeWorkspaceSkillCard(slug, 'missing', { triggers: { keywords: ['词'] } })).toThrow(/Skill 不存在/)
    expect(() => readWorkspaceSkillCard(slug, 'missing')).toThrow(/Skill 不存在/)
  })

  test('卡片保留未知字段，并把 frontmatter 里的名称/描述继续当作回退', () => {
    const { slug } = setup()
    writeWorkspaceSkillCard(slug, 'carded', { triggers: { keywords: ['柱状图'] } })
    // 手工往卡片里加一个未来字段，下一次保存不能把它冲掉。
    const file = cardFile(slug)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.futureField = { keep: true }
    writeFileSync(file, JSON.stringify(raw))

    const next = writeWorkspaceSkillCard(slug, 'carded', { triggers: { keywords: ['折线图'] } })
    expect(next.manifest?.triggers?.keywords).toEqual(['折线图'])
    expect(JSON.parse(readFileSync(file, 'utf8')).futureField).toEqual({ keep: true })
  })
})
