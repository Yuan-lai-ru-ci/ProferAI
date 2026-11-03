/**
 * P0-A3-3b：project 模式下 Pi 附加目录提示词的项目根优先级
 *
 * project 模式下 cwd 就是项目根，它才是用户口中「这个项目」的唯一答案。
 * 从附加目录反推出来候选只能算猜测（monorepo 子包 / 相邻仓库都会混进来），
 * 因此传了 projectRoot 时：废弃候选列表，改为单一权威项目根。
 */
import { describe, expect, test } from 'bun:test'
import { buildPiAdditionalDirectoriesPrompt } from './pi-additional-directories-prompt'
import type { AttachedDirectoryProjectCandidate } from './attached-directory-project-detector'

const candidate: AttachedDirectoryProjectCandidate = {
  rootPath: '/Users/me/work/other-repo',
  type: 'git-repository',
  evidence: ['package.json'],
  sourceDirectory: '/Users/me/work/other-repo',
  name: 'other-repo',
  packageName: 'other-repo',
  gitRemote: 'git@example.test:me/other-repo.git',
  relativePath: '.',
}

describe('buildPiAdditionalDirectoriesPrompt：project 项目根优先', () => {
  test('Given 未给 projectRoot When 有候选 Then 保持改造前输出（候选块照常注入）', () => {
    const prompt = buildPiAdditionalDirectoriesPrompt(['/Users/me/work/other-repo'], [candidate])

    expect(prompt).toContain('<detected_project_candidates>')
    expect(prompt).toContain('other-repo')
    expect(prompt).not.toContain('<workspace_project_root>')
  })

  test('Given 给了 projectRoot When 同时有候选 Then 候选块被废弃，只保留权威项目根', () => {
    const prompt = buildPiAdditionalDirectoriesPrompt(
      ['/Users/me/work/other-repo', '/Users/me/.profer/agent-workspaces/demo'],
      [candidate],
      { projectRoot: '/Users/me/projects/demo' },
    )

    expect(prompt).toContain('<workspace_project_root>/Users/me/projects/demo</workspace_project_root>')
    expect(prompt).toContain('不要再从附加目录反推项目根')
    expect(prompt).not.toContain('<detected_project_candidates>')
    expect(prompt).not.toContain('git@example.test:me/other-repo.git')
    // 附加目录仍然全部列出（它们是授权范围，不是项目根）
    expect(prompt).toContain('<directory index="1">/Users/me/work/other-repo</directory>')
    expect(prompt).toContain('<directory index="2">/Users/me/.profer/agent-workspaces/demo</directory>')
  })

  test('Given projectRoot 含 XML 特殊字符 When 渲染 Then 转义', () => {
    const prompt = buildPiAdditionalDirectoriesPrompt(['/tmp/a'], [], { projectRoot: '/tmp/a&b<c>' })

    expect(prompt).toContain('<workspace_project_root>/tmp/a&amp;b&lt;c&gt;</workspace_project_root>')
  })
})
