import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const rendererRoot = resolve(import.meta.dir, '../..')

function inspectSource(path: string): { imports: string[]; hostCalls: string[] } {
  const source = ts.createSourceFile(path, readFileSync(resolve(rendererRoot, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const result = { imports: [] as string[], hostCalls: [] as string[] }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) result.imports.push(node.moduleSpecifier.text)
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'electronAPI') result.hostCalls.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

test('自动任务页面通过 domain API 访问宿主，不直接触碰 electronAPI', () => {
  for (const path of [
    'components/automation/AutomationFormView.tsx',
    'components/automation/AutomationsListView.tsx',
    'components/automation/AutomationRecommendations.tsx',
  ]) {
    const source = inspectSource(path)
    expect(source.hostCalls, path).toEqual([])
    expect(source.imports, path).toContain('@/domains/automation/automation-api')
  }
})

test('Automation 纯逻辑和 API 层不依赖 React、Jotai 或页面组件', () => {
  for (const path of [
    'domains/automation/automation-draft.ts',
    'domains/automation/automation-form-utils.ts',
    'domains/automation/automation-api.ts',
  ]) {
    const source = inspectSource(path)
    expect(source.imports, path).not.toContain('react')
    expect(source.imports, path).not.toContain('jotai')
    expect(source.imports, path).not.toContain('@/components/automation/AutomationFormView')
  }
})

test('兼容 Atom 只从 domain 草稿模块转发，不复制 Automation 业务实现', () => {
  const source = inspectSource('atoms/automation-atoms.ts')
  expect(source.imports).toContain('@/domains/automation/automation-draft')
  expect(source.imports).not.toContain('@/domains/automation/automation-form-utils')
})
