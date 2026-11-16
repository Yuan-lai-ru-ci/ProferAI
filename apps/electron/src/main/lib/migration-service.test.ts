import { afterAll, beforeAll, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'

// migration-service 经工作区、渠道服务间接加载 Electron；本测试只覆盖本地迁移文件链路。
mock.module('electron', () => ({
  app: { getPath: () => '', getName: () => 'profer-dev', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => undefined },
  dialog: {},
  nativeImage: {},
  nativeTheme: {},
  Notification: class {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  net: {},
  protocol: {},
  session: {},
  systemPreferences: {},
  View: class {},
  WebContentsView: class {},
}))

const configRoot = join(tmpdir(), `profer-migration-v3-${Date.now()}`)
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  exportData,
  exportDataV2,
  parseImportFile,
  inspectImportFile,
  confirmImport,
  assertSafeMigrationArchiveEntry,
  assertSafeMigrationArchiveEntries,
} = await import('./migration-service')
const { getWorkspaceSkillOverridesPath, getWorkspaceSkillsDir } = await import('./config-paths')

const workspace = {
  id: 'workspace-a',
  name: '工作区 A',
  slug: 'workspace-a',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  type: 'personal' as const,
}

beforeAll(() => {
  mkdirSync(join(configRoot, 'agent-workspaces', workspace.slug, 'skills', 'local-demo'), { recursive: true })
  writeFileSync(join(getWorkspaceSkillsDir(workspace.slug), 'local-demo', 'SKILL.md'), '---\nname: local-demo\nversion: 1.0.0\n---\n\n# local\n')
  writeFileSync(getWorkspaceSkillOverridesPath(workspace.slug), JSON.stringify({
    schemaVersion: 1,
    globalSkills: {
      'builtin-demo': { enabled: false, disabledReason: 'user-disabled', updatedAt: new Date().toISOString() },
    },
  }))
  writeFileSync(join(configRoot, 'agent-workspaces.json'), JSON.stringify({ version: 3, workspaces: [workspace] }))
})

afterAll(() => {
  delete process.env.PROFER_CONFIG_DIR
  delete process.env.PROFER_DEV
  rmSync(configRoot, { recursive: true, force: true })
})

describe('迁移导入导出 v3 Skill override BDD', () => {
  test('归档条目同时拒绝 POSIX、Windows、反斜杠与点路径穿越', () => {
    const target = join(configRoot, 'archive-target')
    expect(() => assertSafeMigrationArchiveEntry('../escape.txt', target)).toThrow('非法路径')
    expect(() => assertSafeMigrationArchiveEntry('skills/../escape.txt', target)).toThrow('非法路径')
    expect(() => assertSafeMigrationArchiveEntry(String.raw`skills\..\escape.txt`, target)).toThrow('非法路径')
    expect(() => assertSafeMigrationArchiveEntry('/absolute.txt', target)).toThrow('非法路径')
    expect(() => assertSafeMigrationArchiveEntry(String.raw`C:\absolute.txt`, target)).toThrow('非法路径')
    expect(() => assertSafeMigrationArchiveEntry('skills/./demo/SKILL.md', target)).toThrow('非法路径')
    expect(() => assertSafeMigrationArchiveEntry('skills/demo/SKILL.md', target)).not.toThrow()
  })

  test('Given Windows 非法文件名 When 校验归档条目 Then 在解压前拒绝', () => {
    const target = join(configRoot, 'archive-target')
    const invalidEntries = [
      'skills/CON',
      'skills/nul.txt',
      'skills/COM1/readme.md',
      'skills/COM¹.log',
      'skills/CONOUT$',
      'skills/SKILL.md:evil',
      'skills/foo<bar',
      'skills/bad?name',
      'skills/trailing.',
      'skills/trailing /SKILL.md',
    ]

    for (const entryName of invalidEntries) {
      expect(() => assertSafeMigrationArchiveEntry(entryName, target)).toThrow('Windows')
    }
    expect(() => assertSafeMigrationArchiveEntry('skills/demo.v1/SKILL.md', target)).not.toThrow()
  })

  test('Given Windows 规范化后冲突的归档路径 When 批量校验 Then 拒绝覆盖且允许正常目录层级', () => {
    const target = join(configRoot, 'archive-target')
    expect(() => assertSafeMigrationArchiveEntries([
      { entryName: 'skills/', isDirectory: true },
      { entryName: 'skills/demo/', isDirectory: true },
      { entryName: 'skills/demo/SKILL.md', isDirectory: false },
    ], target)).not.toThrow()

    expect(() => assertSafeMigrationArchiveEntries([
      { entryName: 'A.txt', isDirectory: false },
      { entryName: 'a.txt', isDirectory: false },
    ], target)).toThrow('Windows 路径冲突')

    expect(() => assertSafeMigrationArchiveEntries([
      { entryName: String.raw`skills\demo\SKILL.md`, isDirectory: false },
      { entryName: 'SKILLS/demo/skill.md', isDirectory: false },
    ], target)).toThrow('Windows 路径冲突')
  })

  test('单工作区 v3 导出包含 workspace skill-overrides.json，导入后保留覆盖状态', async () => {
    const output = join(configRoot, 'single.zip')
    const result = await exportData({ mode: 'personal', workspaceId: workspace.id, components: ['skills'], outputPath: output })
    expect(result.success).toBe(true)

    const zip = new AdmZip(output)
    expect(zip.getEntry('manifest.json')).not.toBeNull()
    expect(zip.getEntry('skills/skill-overrides.json')).not.toBeNull()
    expect(JSON.parse(zip.readAsText(zip.getEntry('manifest.json')!)).version).toBe('3.0')

    const preview = await parseImportFile(output)
    expect(preview.manifest.version).toBe('3.0')
    expect(existsSync(join(preview.tempDir, 'skills/skill-overrides.json'))).toBe(true)
    await confirmImport({
      tempDir: preview.tempDir,
      manifest: preview.manifest,
      targetWorkspaceId: workspace.id,
      pathMappings: {},
      conflictResolution: 'skip',
    })
    expect(JSON.parse(readFileSync(getWorkspaceSkillOverridesPath(workspace.slug), 'utf8')).globalSkills['builtin-demo'].enabled).toBe(false)
  })

  test('多工作区 v3 导出按 workspace 保留各自 skill-overrides.json', async () => {
    const output = join(configRoot, 'multi.zip')
    const result = await exportDataV2({ mode: 'share', components: ['skills'], outputPath: output, workspaceSelections: [
      { workspaceId: workspace.id, skillSlugs: ['local-demo'] },
    ] })
    expect(result.success).toBe(true)

    const zip = new AdmZip(output)
    expect(zip.getEntry('workspaces/workspace-a/skills/skill-overrides.json')).not.toBeNull()
    expect(zip.getEntry('workspaces/workspace-a/skills/active/local-demo/SKILL.md')).not.toBeNull()
    expect(JSON.parse(zip.readAsText(zip.getEntry('manifest.json')!)).version).toBe('3.0')
  })
})

describe('personal 备份覆盖会话原文与用户自建数据', () => {
  const sessionId = 'session-blob-1'
  const blobContent = `${'A'.repeat(5000)}原文尾部`
  const hex = createHash('sha256').update(blobContent, 'utf-8').digest('hex')
  const blobHash = `sha256:${hex}`
  const blobPath = join(configRoot, 'blobs', hex.slice(0, 2), hex.slice(2, 4), hex)
  const workspaceFilesNote = join(configRoot, 'agent-workspaces', workspace.slug, 'workspace-files', '.context', 'note.md')
  const memoryNote = join(configRoot, 'agent-workspaces', workspace.slug, '.profer', 'memory', 'MEMORY.md')

  beforeAll(() => {
    mkdirSync(join(configRoot, 'agent-sessions'), { recursive: true })
    writeFileSync(join(configRoot, 'agent-sessions.json'), JSON.stringify({
      version: 1,
      sessions: [{ id: sessionId, workspaceId: workspace.id, title: '带外置原文的会话' }],
    }))
    writeFileSync(join(configRoot, 'agent-sessions', `${sessionId}.jsonl`), `${JSON.stringify({
      type: 'assistant',
      message: { content: 'truncated preview…' },
      _proferBlobs: [{ path: 'tool_use_result', hash: blobHash, chars: blobContent.length, bytes: Buffer.byteLength(blobContent) }],
    })}\n`)

    mkdirSync(join(configRoot, 'blobs', hex.slice(0, 2), hex.slice(2, 4)), { recursive: true })
    writeFileSync(blobPath, blobContent)

    writeFileSync(join(configRoot, 'automations.json'), JSON.stringify({ version: 1, automations: [{ id: 'auto-1', name: '每日简报' }] }))
    writeFileSync(join(configRoot, 'agent-presets.json'), JSON.stringify({ version: 1, presets: { custom: { id: 'custom' } } }))
    mkdirSync(join(configRoot, 'global-skills', 'user', 'demo-global'), { recursive: true })
    writeFileSync(join(configRoot, 'global-skills', 'user', 'demo-global', 'SKILL.md'), '---\nname: demo-global\n---\n')
    mkdirSync(dirname(workspaceFilesNote), { recursive: true })
    writeFileSync(workspaceFilesNote, '# 工作区笔记\n')
    mkdirSync(dirname(memoryNote), { recursive: true })
    writeFileSync(memoryNote, '# 记忆\n')
  })

  test('Given 会话引用了外置原文 When 导出个人备份并导入 Then 原文与自建数据都能恢复', async () => {
    const output = join(configRoot, 'personal-backup.profer-backup')
    const result = await exportDataV2({
      mode: 'personal',
      components: ['sessions', 'skills'],
      outputPath: output,
    })
    expect(result.success).toBe(true)
    expect(result.bytes).toBeGreaterThan(0)

    const zip = new AdmZip(output)
    const entryNames = zip.getEntries().map((entry) => entry.entryName)
    expect(entryNames).toContain(`personal/blobs/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`)
    expect(entryNames).toContain('personal/config/automations.json')
    expect(entryNames).toContain('personal/config/agent-presets.json')
    expect(entryNames).toContain('personal/config/global-skills/user/demo-global/SKILL.md')
    expect(entryNames).toContain(`workspaces/${workspace.slug}/workspace-files/.context/note.md`)
    expect(entryNames).toContain(`workspaces/${workspace.slug}/memory/MEMORY.md`)

    const manifest = JSON.parse(zip.readAsText(zip.getEntry('manifest.json')!))
    expect(manifest.personal.blobCount).toBe(1)
    expect(manifest.personal.blobBytes).toBeGreaterThanOrEqual(Buffer.byteLength(blobContent))
    expect(manifest.personal.sections).toContain('会话原文')
    expect(manifest.personal.sections).toContain('工作区文件')

    // 模拟换机：删掉原文与自建数据后，仅靠备份恢复
    rmSync(blobPath, { force: true })
    rmSync(join(configRoot, 'automations.json'), { force: true })
    rmSync(workspaceFilesNote, { force: true })
    rmSync(memoryNote, { force: true })

    const preview = await parseImportFile(output) as {
      manifest: { version: string }
      personal: { available: boolean; blobCount: number; sections: string[] }
      tempDir: string
      workspaces: unknown[]
    }
    expect(preview.personal.available).toBe(true)
    expect(preview.personal.blobCount).toBe(1)

    const importResult = await confirmImport({
      tempDir: preview.tempDir,
      manifest: preview.manifest as never,
      pathMappings: {},
      workspaceMappings: [{ sourceSlug: workspace.slug, action: 'merge', targetWorkspaceId: workspace.id }],
      conflictResolution: 'overwrite',
    })

    expect(importResult.success).toBe(true)
    expect(importResult.restored).toContain('会话原文')
    expect(readFileSync(blobPath, 'utf8')).toBe(blobContent)
    expect(readFileSync(join(configRoot, 'automations.json'), 'utf8')).toContain('每日简报')
    expect(readFileSync(workspaceFilesNote, 'utf8')).toBe('# 工作区笔记\n')
    expect(readFileSync(memoryNote, 'utf8')).toBe('# 记忆\n')
  })

  test('Given 会话引用的原文已丢失 When 导出 Then 备份照常完成并给出警告', async () => {
    rmSync(blobPath, { force: true })
    const output = join(configRoot, 'missing-blob.profer-backup')
    const result = await exportDataV2({ mode: 'personal', components: ['sessions'], outputPath: output })
    expect(result.success).toBe(true)
    expect(result.warnings?.some((warning) => warning.includes('会话原文'))).toBe(true)

    const zip = new AdmZip(output)
    const manifest = JSON.parse(zip.readAsText(zip.getEntry('manifest.json')!))
    expect(manifest.personal.missingBlobs).toBe(1)
  })
})

describe('旧格式兼容', () => {
  test('Given 旧版本（adm-zip）生成的备份 When 导入 Then 没有 personal 段也能恢复', async () => {
    const zipPath = join(configRoot, 'legacy-backup.profer-backup')
    const legacy = new AdmZip()
    legacy.addFile('manifest.json', Buffer.from(JSON.stringify({
      mode: 'personal',
      version: '3.0',
      components: ['sessions', 'skills'],
      exportedAt: Date.now(),
      sourcePlatform: process.platform,
      sourceArch: process.arch,
      sourceHomeDir: '/Users/old-machine',
      workspaces: [{
        workspaceId: 'legacy-ws-id',
        workspaceName: '旧工作区',
        workspaceSlug: 'legacy-ws',
        skillSlugs: 'all',
        mcpServerNames: 'all',
      }],
    })))
    legacy.addFile('workspaces/legacy-ws/skills/active/legacy-skill/SKILL.md', Buffer.from('---\nname: legacy-skill\n---\n'))
    legacy.writeZip(zipPath)

    const preview = await parseImportFile(zipPath) as unknown as {
      manifest: never
      personal: { available: boolean }
      tempDir: string
    }
    expect(preview.personal.available).toBe(false)

    const result = await confirmImport({
      tempDir: preview.tempDir,
      manifest: preview.manifest,
      pathMappings: {},
      workspaceMappings: [{ sourceSlug: 'legacy-ws', action: 'merge', targetWorkspaceId: workspace.id }],
      conflictResolution: 'overwrite',
    })
    expect(result.success).toBe(true)
    expect(result.restored).toBeUndefined()
    expect(existsSync(join(configRoot, 'agent-workspaces', workspace.slug, 'skills', 'legacy-skill', 'SKILL.md'))).toBe(true)
  })
})

describe('进度与口令加密', () => {
  test('Given 个人备份 When 观察进度 Then 阶段完整且百分比单调到 100', async () => {
    const output = join(configRoot, 'progress.profer-backup')
    const events: Array<{ phase: string; percent: number }> = []
    const result = await exportDataV2({
      mode: 'personal',
      components: ['sessions', 'skills'],
      outputPath: output,
      onProgress: (progress) => events.push({ phase: progress.phase, percent: progress.percent }),
    })

    expect(result.success).toBe(true)
    expect(events[0]?.phase).toBe('preparing')
    expect(events.some((event) => event.phase === 'packing')).toBe(true)
    expect(events[events.length - 1]).toEqual({ phase: 'finalizing', percent: 100 })

    const percents = events.filter((event) => event.phase === 'packing').map((event) => event.percent)
    for (let index = 1; index < percents.length; index++) {
      expect(percents[index]!).toBeGreaterThanOrEqual(percents[index - 1]!)
    }
  })

  test('Given 加密备份 When 口令缺失/错误/正确 Then 分别拒绝、拒绝、成功导入', async () => {
    const output = join(configRoot, 'encrypted.profer-backup')
    const exportResult = await exportDataV2({
      mode: 'personal',
      components: ['sessions', 'skills'],
      outputPath: output,
      passphrase: 'backup-passphrase-123',
    })
    expect(exportResult.success).toBe(true)
    expect(exportResult.encrypted).toBe(true)

    const info = await inspectImportFile(output)
    expect(info.encrypted).toBe(true)
    expect(info.bytes).toBeGreaterThan(0)

    await expect(parseImportFile(output)).rejects.toThrow('已加密')
    await expect(parseImportFile(output, 'wrong-passphrase')).rejects.toThrow('口令错误')

    const preview = await parseImportFile(output, 'backup-passphrase-123') as unknown as {
      manifest: never
      tempDir: string
      personal: { available: boolean }
    }
    expect(preview.personal.available).toBe(true)
    const imported = await confirmImport({
      tempDir: preview.tempDir,
      manifest: preview.manifest,
      pathMappings: {},
      workspaceMappings: [{ sourceSlug: workspace.slug, action: 'merge', targetWorkspaceId: workspace.id }],
      conflictResolution: 'skip',
    })
    expect(imported.success).toBe(true)
  }, 120_000)

  test('Given 团队分发 When 指定口令 Then 明确拒绝', async () => {
    await expect(exportDataV2({
      mode: 'share',
      components: ['skills'],
      outputPath: join(configRoot, 'share-with-pass.profer-share'),
      passphrase: 'should-not-work',
    })).rejects.toThrow('只有个人备份')
  })

  test('Given 打包期间取消 When 中止信号触发 Then 返回 cancelled 且不生成备份文件', async () => {
    const output = join(configRoot, 'cancelled.profer-backup')
    const controller = new AbortController()
    const result = await exportDataV2({
      mode: 'personal',
      components: ['sessions', 'skills'],
      outputPath: output,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === 'packing') controller.abort()
      },
    })

    expect(result.success).toBe(false)
    expect(result.cancelled).toBe(true)
    expect(existsSync(output)).toBe(false)
  })
})
