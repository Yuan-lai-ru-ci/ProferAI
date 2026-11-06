import { afterAll, beforeAll, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const configRoot = join(tmpdir(), `profer-migration-project-guard-${Date.now()}`)
const projectRoot = join(configRoot, 'projects', 'demo-app')
process.env.PROFER_DEV = '1'
process.env.PROFER_CONFIG_DIR = configRoot

const {
  exportData,
  exportDataV2,
  getExportPreview,
  parseImportFile,
  confirmImport,
} = await import('./migration-service')
const { getWorkspaceSkillsDir } = await import('./config-paths')
const { invalidateWorkspaceLocation } = await import('./workspace-locator')

/** managed：配置目录在 `~/.profer/agent-workspaces/<slug>/`，迁移行为必须保持不变。 */
const managedWorkspace = {
  id: 'workspace-managed',
  name: '托管工作区',
  slug: 'workspace-managed',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  type: 'personal' as const,
  storageMode: 'managed' as const,
}

/** project：配置在用户项目目录里，P2-A 起禁止导出/导入。 */
const projectWorkspace = {
  id: 'workspace-project',
  name: '项目工作区',
  slug: 'workspace-project',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  type: 'personal' as const,
  storageMode: 'project' as const,
  rootPath: projectRoot,
}

const PROJECT_MIGRATION_REJECTED = '项目工作区暂不支持导出/导入'
const PROJECT_EXPORT_SESSIONS_ONLY = '只支持导出会话'
const PROJECT_AUTO_EXCLUDED_REASON = '项目工作区暂不支持导出，已自动排除'
const INDEX_PATH = join(configRoot, 'agent-workspaces.json')

/** 重写工作区索引，用于「全 managed」等场景；改完必须让 locator 丢掉旧缓存。 */
function writeWorkspaceIndex(workspaces: unknown[]): void {
  writeFileSync(INDEX_PATH, JSON.stringify({ version: 4, workspaces }))
  invalidateWorkspaceLocation()
}

beforeAll(() => {
  mkdirSync(join(configRoot, 'agent-workspaces', managedWorkspace.slug, 'skills', 'local-demo'), { recursive: true })
  writeFileSync(
    join(getWorkspaceSkillsDir(managedWorkspace.slug), 'local-demo', 'SKILL.md'),
    '---\nname: local-demo\nversion: 1.0.0\n---\n\n# local\n',
  )
  mkdirSync(join(projectRoot, '.profer', 'skills'), { recursive: true })
  writeWorkspaceIndex([managedWorkspace, projectWorkspace])
})

afterAll(() => {
  delete process.env.PROFER_CONFIG_DIR
  delete process.env.PROFER_DEV
  rmSync(configRoot, { recursive: true, force: true })
})

describe('项目工作区导出限制', () => {
  test('Given project 工作区 When v1 单工作区导出 Then 明确拒绝且不写文件', async () => {
    const output = join(configRoot, 'project-single.zip')
    await expect(exportData({
      mode: 'personal',
      workspaceId: projectWorkspace.id,
      components: ['skills'],
      outputPath: output,
    })).rejects.toThrow(PROJECT_MIGRATION_REJECTED)
    expect(existsSync(output)).toBe(false)
  })

  test('Given 显式选中 project + managed When 导出非会话组件 Then 拒绝并指出工作区', async () => {
    const output = join(configRoot, 'project-mixed.zip')
    await expect(exportDataV2({
      mode: 'share',
      components: ['skills'],
      outputPath: output,
      workspaceSelections: [{ workspaceId: managedWorkspace.id }, { workspaceId: projectWorkspace.id }],
    })).rejects.toThrow(PROJECT_EXPORT_SESSIONS_ONLY)
    expect(existsSync(output)).toBe(false)
  })

  test('Given 显式选中 project 工作区 When 导出非会话组件 Then 拒绝并指出工作区', async () => {
    const output = join(configRoot, 'project-multi.zip')
    await expect(exportDataV2({
      mode: 'share',
      components: ['skills'],
      outputPath: output,
      workspaceSelections: [{ workspaceId: projectWorkspace.id }],
    })).rejects.toThrow(PROJECT_EXPORT_SESSIONS_ONLY)
    expect(existsSync(output)).toBe(false)
  })

  test('Given 显式选中 project 工作区 When 只导出会话 Then 成功', async () => {
    const output = join(configRoot, 'project-sessions.zip')
    const result = await exportDataV2({
      mode: 'share',
      components: ['sessions'],
      outputPath: output,
      workspaceSelections: [{ workspaceId: projectWorkspace.id }],
    })
    expect(result.success).toBe(true)
    expect(existsSync(output)).toBe(true)
  })

  test('Given project 工作区 When 取导出预览 Then 成功（只读预览不搬运配置）', async () => {
    const preview = await getExportPreview(projectWorkspace.id)
    expect(preview.workspace?.id).toBe(projectWorkspace.id)
  })
})

describe('默认全量导出自动排除 project 工作区', () => {
  test('Given 未显式选择工作区 When 导出 Then 成功、project 进 excluded、managed 完整', async () => {
    const output = join(configRoot, 'default-all.zip')
    const result = await exportDataV2({ mode: 'share', components: ['skills'], outputPath: output })

    expect(result.success).toBe(true)
    expect(existsSync(output)).toBe(true)
    expect(result.excluded).toEqual([{
      workspaceId: projectWorkspace.id,
      workspaceName: projectWorkspace.name,
      workspaceSlug: projectWorkspace.slug,
      reason: PROJECT_AUTO_EXCLUDED_REASON,
    }])
    // 排除必须对用户可见：现有 UI 只渲染 warnings
    expect(result.warnings?.some((warning) => warning.includes(projectWorkspace.name))).toBe(true)

    const parsed = await parseImportFile(output)
    try {
      if (!('workspaces' in parsed)) throw new Error('预期 v2 归档')
      const preview = parsed
      expect(preview.manifest.workspaces.map((entry) => entry.workspaceSlug)).toEqual([managedWorkspace.slug])
      const managedEntry = preview.workspaces.find((entry) => entry.workspaceSlug === managedWorkspace.slug)
      expect(managedEntry?.skillNames).toContain('local-demo')
      expect(preview.workspaces.some((entry) => entry.workspaceSlug === projectWorkspace.slug)).toBe(false)
    } finally {
      rmSync(parsed.tempDir, { recursive: true, force: true })
    }
  })

  test('Given 只有 managed 工作区 When 默认全量导出 Then 行为不变（无 excluded）', async () => {
    writeWorkspaceIndex([managedWorkspace])
    try {
      const output = join(configRoot, 'managed-only-all.zip')
      const result = await exportDataV2({ mode: 'share', components: ['skills'], outputPath: output })

      expect(result.success).toBe(true)
      expect(result.excluded).toBeUndefined()

      const parsed = await parseImportFile(output)
      try {
        if (!('workspaces' in parsed)) throw new Error('预期 v2 归档')
        expect(parsed.manifest.workspaces.map((entry) => entry.workspaceSlug)).toEqual([managedWorkspace.slug])
      } finally {
        rmSync(parsed.tempDir, { recursive: true, force: true })
      }
    } finally {
      writeWorkspaceIndex([managedWorkspace, projectWorkspace])
    }
  })
})

describe('托管工作区导出行为不变', () => {
  test('Given managed 工作区 When 单工作区导出 Then 成功', async () => {
    const output = join(configRoot, 'managed-single.zip')
    const result = await exportData({
      mode: 'personal',
      workspaceId: managedWorkspace.id,
      components: ['skills'],
      outputPath: output,
    })
    expect(result.success).toBe(true)
    expect(existsSync(output)).toBe(true)
  })

  test('Given managed 工作区 When 多工作区导出 Then 成功', async () => {
    const output = join(configRoot, 'managed-multi.zip')
    const result = await exportDataV2({
      mode: 'share',
      components: ['skills'],
      outputPath: output,
      workspaceSelections: [{ workspaceId: managedWorkspace.id }],
    })
    expect(result.success).toBe(true)
  })

  test('Given managed 工作区 When 取导出预览 Then 成功', async () => {
    const preview = await getExportPreview(managedWorkspace.id)
    expect(preview.workspace?.id).toBe(managedWorkspace.id)
    expect(preview.skillCount).toBeGreaterThanOrEqual(1)
  })
})

describe('项目工作区禁用导入', () => {
  test('Given 多工作区归档 When 合并到 project 工作区 Then 拒绝且不落盘', async () => {
    const archive = join(configRoot, 'share-for-import.zip')
    await exportDataV2({
      mode: 'share',
      components: ['skills'],
      outputPath: archive,
      workspaceSelections: [{ workspaceId: managedWorkspace.id }],
    })
    const preview = await parseImportFile(archive)
    const projectSkillsBefore = existsSync(join(projectRoot, '.profer', 'skills', 'local-demo'))

    await expect(confirmImport({
      tempDir: preview.tempDir,
      manifest: preview.manifest,
      pathMappings: {},
      workspaceMappings: [{ sourceSlug: managedWorkspace.slug, action: 'merge', targetWorkspaceId: projectWorkspace.id }],
      conflictResolution: 'overwrite',
    })).rejects.toThrow(PROJECT_MIGRATION_REJECTED)
    expect(existsSync(join(projectRoot, '.profer', 'skills', 'local-demo'))).toBe(projectSkillsBefore)
  })

  test('Given 混合映射（managed + project） When 导入 Then 拒绝且 managed 未被写入', async () => {
    const archive = join(configRoot, 'share-for-mixed-import.zip')
    await exportDataV2({
      mode: 'share',
      components: ['skills'],
      outputPath: archive,
      workspaceSelections: [{ workspaceId: managedWorkspace.id }],
    })
    const preview = await parseImportFile(archive)
    // 先清掉 managed 下的 skill，用于验证拒绝后没有任何写入
    const managedSkill = join(getWorkspaceSkillsDir(managedWorkspace.slug), 'local-demo', 'SKILL.md')
    const before = readFileSync(managedSkill, 'utf-8')
    writeFileSync(managedSkill, 'mutated\n')
    try {
      await expect(confirmImport({
        tempDir: preview.tempDir,
        manifest: preview.manifest,
        pathMappings: {},
        workspaceMappings: [
          { sourceSlug: managedWorkspace.slug, action: 'merge', targetWorkspaceId: managedWorkspace.id },
          { sourceSlug: projectWorkspace.slug, action: 'merge', targetWorkspaceId: projectWorkspace.id },
        ],
        conflictResolution: 'overwrite',
      })).rejects.toThrow(PROJECT_MIGRATION_REJECTED)
      expect(readFileSync(managedSkill, 'utf-8')).toBe('mutated\n')
    } finally {
      writeFileSync(managedSkill, before)
    }
  })

  test('Given v1 归档 When 目标为 project 工作区 Then 拒绝', async () => {
    const preview = await parseImportFile(join(configRoot, 'managed-single.zip'))
    const tempDir = preview.tempDir
    await expect(confirmImport({
      tempDir,
      // v1 单工作区 manifest：走旧导入分支，目标工作区由 targetWorkspaceId 指定
      manifest: { mode: 'personal', version: '1.0', components: [], workspaceSlug: projectWorkspace.slug } as never,
      targetWorkspaceId: projectWorkspace.id,
      pathMappings: {},
      conflictResolution: 'overwrite',
    })).rejects.toThrow(PROJECT_MIGRATION_REJECTED)
  })

  test('Given 多工作区归档 When 合并到 managed 工作区 Then 成功（导入行为不变）', async () => {
    const archive = join(configRoot, 'share-for-managed.zip')
    await exportDataV2({
      mode: 'share',
      components: ['skills'],
      outputPath: archive,
      workspaceSelections: [{ workspaceId: managedWorkspace.id }],
    })
    const preview = await parseImportFile(archive)
    const result = await confirmImport({
      tempDir: preview.tempDir,
      manifest: preview.manifest,
      pathMappings: {},
      workspaceMappings: [{ sourceSlug: managedWorkspace.slug, action: 'merge', targetWorkspaceId: managedWorkspace.id }],
      conflictResolution: 'overwrite',
    })
    expect(result.success).toBe(true)
  })
})
