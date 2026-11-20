import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoreWorkspaceStore } from './workspaces'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })

function setup() {
  root = mkdtempSync(join(tmpdir(), 'profer-core-workspaces-'))
  return createCoreWorkspaceStore(join(root, 'config'), join(root, 'workspaces'))
}

describe('Core workspace store', () => {
  test('只读桌面 v4 索引并即时看到后续新增工作区，不回写或混入 Core 索引', () => {
    setup()
    const configDir = join(root, 'config')
    mkdirSync(configDir)
    const indexPath = join(configDir, 'agent-workspaces.json')
    const workspace = { id: 'desktop-managed', name: 'Desktop', slug: 'desktop', createdAt: 1, updatedAt: 1 }
    const store = createCoreWorkspaceStore(configDir, join(root, 'workspaces'), indexPath)
    expect(store.list()).toEqual([])
    writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces: [workspace], desktopMetadata: 'preserve' }))
    const before = readFileSync(indexPath, 'utf8')
    expect(store.list()).toEqual([{ ...workspace, storageMode: 'managed' }])
    expect(() => store.createManaged('New')).toThrow('只读')
    expect(() => store.update(workspace.id, { name: 'New' })).toThrow('只读')
    expect(() => store.remove(workspace.id)).toThrow('只读')
    expect(() => store.assertRemovable(workspace.id)).toThrow('只读')
    expect(() => store.bindProject({ rootPath: root })).toThrow('只读')
    expect(() => store.relocateProject({ id: workspace.id, rootPath: root })).toThrow('只读')
    expect(readFileSync(indexPath, 'utf8')).toBe(before)
    expect(existsSync(join(configDir, 'workspaces.json'))).toBe(false)
    expect(existsSync(join(root, 'workspaces'))).toBe(false)
    const second = { ...workspace, id: 'desktop-new', slug: 'desktop-new' }
    writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces: [workspace, second] }))
    expect(store.list().map(item => item.id)).toEqual(['desktop-managed', 'desktop-new'])
  })

  test('桌面项目根仍保持 project 语义，损坏索引和越界 slug 明确拒绝', () => {
    setup()
    const indexPath = join(root, 'agent-workspaces.json')
    const store = createCoreWorkspaceStore(root, join(root, 'workspaces'), indexPath)
    const workspace = { id: 'project', name: 'Project', slug: 'project', createdAt: 1, updatedAt: 1, rootPath: root }
    writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces: [workspace] }))
    expect(store.list()[0]?.storageMode).toBe('project')
    writeFileSync(indexPath, JSON.stringify({ version: 4, workspaces: [{ ...workspace, slug: '../escape' }] }))
    expect(() => store.list()).toThrow('索引')
    writeFileSync(indexPath, JSON.stringify({ version: 1, workspaces: [] }))
    expect(() => store.list()).toThrow('索引')
  })

  test('本机Core可原子写入桌面v4索引并保留顶层元数据', () => {
    root = mkdtempSync(join(tmpdir(), 'profer-core-workspaces-writable-'))
    const configDir = join(root, 'config')
    mkdirSync(configDir)
    const indexPath = join(configDir, 'agent-workspaces.json')
    const original = { version: 4, desktopMetadata: { selected: 'existing' }, workspaces: [{ id: 'existing', name: 'Existing', slug: 'existing', createdAt: 1, updatedAt: 1 }] }
    writeFileSync(indexPath, JSON.stringify(original))
    let changed = 0
    const store = createCoreWorkspaceStore(configDir, join(root, 'workspaces'), indexPath, undefined, () => { changed++ }, undefined, true)
    expect(store.list().map(item => item.id)).toEqual(['existing'])
    const created = store.createManaged('Created')
    expect(store.update(created.id, { archived: true }).archived).toBe(true)
    expect(store.reorder([created.id]).map(item => item.id)).toEqual([created.id, 'existing'])
    const persisted = JSON.parse(readFileSync(indexPath, 'utf8'))
    expect(persisted.version).toBe(4)
    expect(persisted.desktopMetadata).toEqual(original.desktopMetadata)
    expect(persisted.workspaces[0].id).toBe(created.id)
    expect(changed).toBe(3)
    expect(existsSync(join(configDir, 'workspaces.json'))).toBe(false)
  })

  test('writable桌面索引拒绝越界slug和重复身份，损坏文件保持原样', () => {
    setup()
    const indexPath = join(root, 'agent-workspaces.json')
    const store = createCoreWorkspaceStore(root, join(root, 'workspaces'), indexPath, undefined, undefined, undefined, true)
    const item = { id: 'one', name: 'One', slug: 'one', createdAt: 1, updatedAt: 1 }
    for (const workspaces of [[{ ...item, slug: '../escape' }], [item, item], [item, { ...item, id: 'two', slug: 'ONE' }]]) {
      const raw = JSON.stringify({ version: 4, workspaces, extra: 'keep' })
      writeFileSync(indexPath, raw)
      expect(() => store.createManaged('Denied')).toThrow('索引')
      expect(readFileSync(indexPath, 'utf8')).toBe(raw)
    }
  })

  test('项目骨架预检查拒绝外部junction和损坏清单且不补建文件', () => {
    const store = setup()
    const project = join(root, 'repo'), outside = join(root, 'outside')
    mkdirSync(project); mkdirSync(outside)
    const link = join(project, '.profer')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => store.bindProject({ rootPath: project })).toThrow()
      expect(existsSync(join(outside, 'profer.json'))).toBe(false)
    } finally { unlinkSync(link) }
    mkdirSync(link)
    writeFileSync(join(link, 'profer.json'), '{broken')
    expect(() => store.bindProject({ rootPath: project })).toThrow('清单')
    expect(existsSync(join(link, 'sessions'))).toBe(false)
    expect(store.list()).toEqual([])
  })

  test('creates managed workspaces under the Core workspace root and persists the index', () => {
    const store = setup()
    const workspace = store.createManaged('Linux 项目')
    expect(workspace.storageMode).toBe('managed')
    expect(store.list()).toEqual([workspace])
    expect(() => store.createManaged('Linux 项目')).toThrow('已存在')
  })

  test('binds Linux project paths and reopens an existing binding without duplicating it', () => {
    const store = setup()
    const projectPath = join(root, 'repo')
    mkdirSync(projectPath)
    const created = store.bindProject({ rootPath: projectPath, name: 'Repo' })
    expect(created.workspace).toMatchObject({ storageMode: 'project', rootPath: realpathSync(projectPath) })
    expect(created.created).toBe(true)
    expect(store.bindProject({ rootPath: projectPath, open: true })).toMatchObject({ workspace: created.workspace, created: false })
    expect(() => store.bindProject({ rootPath: projectPath })).toThrow('已绑定')
  })

  test('项目绑定由Core补齐安全骨架，保留清单字段并拒绝覆盖未来schema', () => {
    const store = setup()
    const projectPath = join(root, 'repo'); mkdirSync(projectPath)
    const first = store.bindProject({ rootPath: projectPath, name: 'Repo' }).workspace
    for (const relativePath of ['.profer/profile.md', '.profer/memory/MEMORY.md', '.profer/mcp.json', '.profer/config.json', '.profer/.gitignore', '.profer/presets/_config.json', '.profer/profer.json']) expect(existsSync(join(projectPath, relativePath))).toBe(true)
    const manifestPath = join(projectPath, '.profer', 'profer.json')
    writeFileSync(manifestPath, JSON.stringify({ schema: 'profer.project/1', name: 'Repo', custom: 'keep' }))
    expect(store.bindProject({ rootPath: projectPath, open: true }).workspace.id).toBe(first.id)
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).custom).toBe('keep')
    writeFileSync(manifestPath, JSON.stringify({ schema: 'profer.project/99', custom: 'future' }))
    expect(() => store.bindProject({ rootPath: projectPath, open: true })).not.toThrow()
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).schema).toBe('profer.project/99')
  })

  test('Core workspace update validates name/archive and project removal preserves external root', () => {
    const store = setup()
    const managed = store.createManaged('Managed')
    const projectPath = join(root, 'repo'); mkdirSync(projectPath)
    const project = store.bindProject({ rootPath: projectPath, name: 'Repo' }).workspace
    expect(store.update(managed.id, { name: 'Renamed', archived: true })).toMatchObject({ id: managed.id, name: 'Renamed', archived: true })
    expect(store.update(managed.id, { archived: false }).archived).toBeUndefined()
    expect(() => store.update(managed.id, { name: 'Renamed' })).not.toThrow()
    expect(() => store.update(managed.id, { name: 'Repo' })).toThrow('已存在')
    expect(() => store.update(managed.id, { name: '' })).toThrow('不能为空')
    store.remove(project.id)
    expect(store.list().find(item => item.id === project.id)).toBeUndefined()
    expect(existsSync(projectPath)).toBe(true)
  })

  test('Core managed workspace removal refuses attached sessions before changing index', () => {
    const store = setup()
    const managed = store.createManaged('Managed')
    store.createManaged('Other')
    const storeWithSession = createCoreWorkspaceStore(join(root, 'config'), join(root, 'workspaces'), undefined, () => [{ id: 'session', title: 'session', workspaceId: managed.id, createdAt: 1, updatedAt: 1 }])
    expect(() => storeWithSession.remove(managed.id)).toThrow('仍有会话')
    expect(storeWithSession.list()).toHaveLength(2)
  })
  test('rejects invalid or non-existing Core-side paths', () => {
    const store = setup()
    expect(() => store.bindProject({ rootPath: 'relative/project' })).toThrow('绝对路径')
    expect(() => store.bindProject({ rootPath: join(root, 'missing') })).toThrow('不存在')
  })

})
