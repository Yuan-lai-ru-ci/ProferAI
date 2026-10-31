import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResourceLoader, Skill } from '@earendil-works/pi-coding-agent'
import { createProferSkillsOverride, preparePromptForPiSkillQueue, preparePromptWithProferSkills } from './pi-skill-resources'

const roots: string[] = []
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'profer-pi-skill-security-'))
  roots.push(path)
  return path
}
function writeSkill(path: string, slug: string, label = slug): Skill {
  const baseDir = join(path, slug)
  mkdirSync(baseDir, { recursive: true })
  const filePath = join(baseDir, 'SKILL.md')
  writeFileSync(filePath, `---\nname: ${label}\ndescription: 允许描述\n---\n正文 ${slug}`)
  return { name: label, baseDir, filePath, description: '允许描述', disableModelInvocation: false,
    sourceInfo: { path: baseDir, source: 'test', scope: 'temporary', origin: 'top-level' } }
}
async function loader(path: string, slugs?: string[]) {
  const sdk = await import('@earendil-works/pi-coding-agent')
  return new sdk.DefaultResourceLoader({ cwd: path, agentDir: join(path, '.agent'),
    settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true,
    noContextFiles: true, noThemes: true, noPromptTemplates: true, appendSystemPrompt: [],
    additionalSkillPaths: [], skillsOverride: createProferSkillsOverride([path], slugs, sdk.loadSkillsFromDir) })
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Pi Skill 安全边界', () => {
  test('真实 loader 不读取白名单外损坏文件，也不泄露 SDK collision 路径', async () => {
    const path = root()
    writeSkill(path, 'allowed', '重复名字')
    const blocked = writeSkill(path, 'blocked', '重复名字')
    writeFileSync(blocked.filePath, '---\nname: [损坏内容\n---\n秘密内容')
    const resource = await loader(path, ['allowed'])
    await resource.reload()
    expect(resource.getSkills().skills.map((skill) => skill.name)).toEqual(['allowed'])
    expect(resource.getSkills().diagnostics.length).toBeGreaterThan(0)
    expect(JSON.stringify(resource.getSkills().diagnostics)).not.toContain(path)
  })

  test('realpath 守卫禁止目录与 SKILL.md symlink 逃逸，循环 symlink 不挂起', async () => {
    const path = root()
    const external = root()
    const secret = writeSkill(external, 'secret')
    symlinkSync(secret.baseDir, join(path, 'escaped-directory'))
    symlinkSync(path, join(path, 'loop'))
    mkdirSync(join(path, 'escaped-file'))
    symlinkSync(secret.filePath, join(path, 'escaped-file', 'SKILL.md'))
    const resource = await loader(path)
    await resource.reload()
    expect(resource.getSkills().skills).toEqual([])
    expect(JSON.stringify(resource.getSkills().diagnostics)).not.toContain(external)
    expect(JSON.stringify(resource.getSkills().diagnostics)).not.toContain('secret')
  })

  test('缺失/不可读根目录返回无路径诊断，不抛异常', () => {
    const path = root()
    const result = createProferSkillsOverride([join(path, 'missing')])({ skills: [], diagnostics: [] })
    expect(result.skills).toEqual([])
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(JSON.stringify(result.diagnostics)).not.toContain(path)
  })

  test('允许的文件不可读时不保留 SDK stale metadata，普通任务继续', async () => {
    const path = root()
    const skill = writeSkill(path, 'unreadable')
    chmodSync(skill.filePath, 0)
    try {
      // 实测权限，保证本用例确实覆盖读取失败。
      expect(() => readFileSync(skill.filePath)).toThrow()
      const resource = await loader(path, ['unreadable'])
      await resource.reload()
      expect(resource.getSkills().skills).toEqual([])
      expect(resource.getSkills().diagnostics.length).toBeGreaterThan(0)
      expect(await preparePromptWithProferSkills(resource, '继续普通任务', ['unreadable']))
        .toContain('继续普通任务')
    } finally {
      chmodSync(skill.filePath, 0o600)
    }
  })

  test('允许目录的相同 label alias 歧义 fail closed，canonical slug 优先', async () => {
    const path = root()
    writeSkill(path, 'alpha', 'common')
    writeSkill(path, 'beta', 'common')
    writeSkill(path, 'common', 'another-label')
    const resource = await loader(path)
    const canonical = await preparePromptWithProferSkills(resource, '任务', ['common'])
    expect(canonical).toContain('正文 common')
    expect(canonical).not.toContain('正文 alpha')
    const ambiguous = await preparePromptWithProferSkills(await loader(path, ['alpha', 'beta']), '任务', ['common'])
    expect(ambiguous).toContain('多个匹配项')
    expect(ambiguous).not.toContain('<skill name=')
    expect(ambiguous).not.toContain(path)
  })

  test('单一 name alias direct 调用保持兼容，旧 slug 指向规范目录', async () => {
    const path = root()
    writeSkill(path, 'profer-coach', '教练')
    const resource = await loader(path, ['proma-coach'])
    expect(await preparePromptWithProferSkills(resource, '任务', ['教练'])).toContain('<skill name="profer-coach"')
    expect(await preparePromptWithProferSkills(resource, '任务', ['proma-coach'])).toContain('正文 profer-coach')
  })

  test('同目录 slug 跨根冲突不任意选赢家', async () => {
    const { loadSkillsFromDir } = await import('@earendil-works/pi-coding-agent')
    const first = root()
    const second = root()
    writeSkill(first, 'same')
    writeSkill(second, 'same')
    const result = createProferSkillsOverride([first, second], undefined, loadSkillsFromDir)({ skills: [], diagnostics: [] })
    expect(result.skills).toEqual([])
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(JSON.stringify(result.diagnostics)).not.toContain(first)
  })

  test('真实 SDK steer/followUp 原生展开被受管 queue 转换抑制，不请求模型', async () => {
    const path = root()
    writeSkill(path, 'alpha')
    const resource = await loader(path, ['alpha'])
    await resource.reload()
    const sdk = await import('@earendil-works/pi-coding-agent')
    const { Agent } = await import('@earendil-works/pi-agent-core')
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(path, 'auth.json'), modelsPath: null,
      modelsStorePath: join(path, 'models-cache'), refreshOnCreate: false, allowModelNetwork: false,
    })
    const session = new sdk.AgentSession({
      agent: new Agent({ streamFn: () => { throw new Error('本测试禁止模型请求') } }),
      sessionManager: sdk.SessionManager.inMemory(),
      settingsManager: sdk.SettingsManager.inMemory(), cwd: path,
      resourceLoader: resource, modelRuntime, initialActiveToolNames: [],
    })
    try {
      const original = '/skill:alpha 当前用户文本'
      // 证明 SDK 原始 queue 确实会读取展开，而受管 queue 保留文本。
      await session.steer(original)
      expect(session.getSteeringMessages()[0]).toContain('正文 alpha')
      session.clearQueue()
      const prepared = await preparePromptWithProferSkills(resource, original, [])
      await session.steer(preparePromptForPiSkillQueue(prepared))
      await session.followUp(preparePromptForPiSkillQueue(prepared))
      expect(session.getSteeringMessages()[0]).toBe(`\n${original}`)
      expect(session.getFollowUpMessages()[0]).toBe(`\n${original}`)
      expect(session.getSteeringMessages()[0]).not.toContain('<skill name=')
    } finally {
      session.dispose()
    }
  })

  test('direct adapter 的中英文标点结束引用，不吞入后续文字', async () => {
    const path = root()
    writeSkill(path, 'alpha')
    const resource = await loader(path, ['alpha'])
    for (const punctuation of ['，', '。', '；', '！', '？', '、', ',', ';', '!', '?', ')', ']', '”', '’']) {
      const prompt = `/skill:alpha${punctuation}继续`
      expect(await preparePromptWithProferSkills(resource, prompt)).toContain('正文 alpha')
      expect(await preparePromptWithProferSkills(resource, prompt, [])).toBe(prompt)
    }
  })

  test('direct adapter 的 qualified 引用不截断为其他 slug', async () => {
    const path = root()
    writeSkill(path, 'alpha')
    const resource = await loader(path, ['alpha'])
    const result = await preparePromptWithProferSkills(resource, '/skill:alpha:daily')
    expect(result).toContain('Skill 引用诊断')
    expect(result).not.toContain('正文 alpha')
  })

  test('explicitSkillNames=[] 不 reload/扫描，reload 失败也给诊断保留任务', async () => {
    const sdk = await import('@earendil-works/pi-coding-agent')
    const resource: ResourceLoader = new sdk.DefaultResourceLoader({
      cwd: root(), agentDir: root(), settingsManager: sdk.SettingsManager.inMemory(),
      noSkills: true, noExtensions: true, noContextFiles: true,
    })
    resource.reload = async () => { throw new Error('私有路径 /secret/path') }
    const prompt = '任务含 /skill:secret'
    expect(await preparePromptWithProferSkills(resource, prompt, [])).toBe(prompt)
    const result = await preparePromptWithProferSkills(resource, prompt, ['secret'])
    expect(result).toContain('Skill 引用诊断')
    expect(result).toContain(prompt)
    expect(result).not.toContain('/secret/path')
  })
})
