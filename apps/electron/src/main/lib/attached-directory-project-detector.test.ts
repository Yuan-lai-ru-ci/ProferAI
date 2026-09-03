import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectAttachedDirectoryProjects } from './attached-directory-project-detector'

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'profer-project-detector-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('detectAttachedDirectoryProjects', () => {
  test('识别附加目录下嵌套的 Obsidian Vault', () => {
    withTempDirectory((directory) => {
      const vault = join(directory, 'AAAI学习大师')
      mkdirSync(join(vault, '.obsidian'), { recursive: true })

      expect(detectAttachedDirectoryProjects([directory])).toContainEqual(expect.objectContaining({
        rootPath: vault,
        type: 'obsidian-vault',
        evidence: ['.obsidian/'],
        sourceDirectory: directory,
        name: 'AAAI学习大师',
        relativePath: 'AAAI学习大师',
      }))
    })
  })

  test('识别 Git、Node 与 Python 项目', () => {
    withTempDirectory((directory) => {
      const gitProject = join(directory, 'git')
      const nodeProject = join(directory, 'node')
      const pythonProject = join(directory, 'python')
      mkdirSync(join(gitProject, '.git'), { recursive: true })
      mkdirSync(nodeProject, { recursive: true })
      mkdirSync(pythonProject, { recursive: true })
      writeFileSync(join(nodeProject, 'package.json'), '{"name":"node-project"}')
      writeFileSync(join(pythonProject, 'pyproject.toml'), '[project]')

      const candidates = detectAttachedDirectoryProjects([directory])
      expect(candidates.map(({ rootPath, type }) => ({ rootPath, type }))).toEqual(expect.arrayContaining([
        { rootPath: gitProject, type: 'git-repository' },
        { rootPath: nodeProject, type: 'node-project' },
        { rootPath: pythonProject, type: 'python-project' },
      ]))
    })
  })

  test('不会扫描 node_modules 内的项目标志', () => {
    withTempDirectory((directory) => {
      const hiddenProject = join(directory, 'node_modules', 'package')
      mkdirSync(join(hiddenProject, '.obsidian'), { recursive: true })

      expect(detectAttachedDirectoryProjects([directory])).toEqual([])
    })
  })

  test('不会把只有依赖字段的外层 package.json 误报为 Node 项目', () => {
    withTempDirectory((directory) => {
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ dependencies: { sharp: '^1.0.0' } }))
      const nestedProject = join(directory, 'real-project')
      mkdirSync(nestedProject, { recursive: true })
      writeFileSync(join(nestedProject, 'package.json'), JSON.stringify({ name: 'real-project', scripts: { test: 'bun test' } }))

      const candidates = detectAttachedDirectoryProjects([directory])
      expect(candidates.map(({ rootPath }) => rootPath)).toEqual([nestedProject])
      expect(candidates[0]).toMatchObject({ name: 'real-project', packageName: 'real-project', relativePath: 'real-project' })
    })
  })

  test('识别 Git remote，并把仓库根注入子项目元数据', () => {
    withTempDirectory((directory) => {
      const repository = join(directory, 'repo')
      const subproject = join(repository, 'apps', 'web')
      mkdirSync(join(repository, '.git'), { recursive: true })
      mkdirSync(subproject, { recursive: true })
      writeFileSync(join(repository, '.git', 'config'), '[remote "origin"]\n\turl = https://example.com/team/repo.git\n')
      writeFileSync(join(subproject, 'package.json'), JSON.stringify({ name: '@team/web', version: '1.0.0' }))

      const candidates = detectAttachedDirectoryProjects([directory])
      expect(candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ rootPath: repository, type: 'git-repository', gitRemote: 'https://example.com/team/repo.git' }),
        expect.objectContaining({ rootPath: subproject, type: 'node-project', repositoryRoot: repository, packageName: '@team/web' }),
      ]))
    })
  })
})
