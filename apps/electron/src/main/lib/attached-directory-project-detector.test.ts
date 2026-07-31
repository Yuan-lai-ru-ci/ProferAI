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

      expect(detectAttachedDirectoryProjects([directory])).toContainEqual({
        rootPath: vault,
        type: 'obsidian-vault',
        evidence: ['.obsidian/'],
        sourceDirectory: directory,
      })
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
      writeFileSync(join(nodeProject, 'package.json'), '{}')
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
})
