import { afterAll, beforeAll, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
