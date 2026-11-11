import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const libRoot = resolve(import.meta.dir, '..')

function importsOf(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(libRoot, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const specifiers: string[] = []
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

const executionChain = [
  'chat-service.ts',
  'agent-orchestrator.ts',
  'agent-runtime-credentials.ts',
  'plugins/plugin-models.ts',
]

const commercialModules = new Set([
  './auth-service',
  '../auth-service',
  './commercial-routing-policy',
  '../commercial-routing-policy',
  './build-target',
  '../build-target',
  './official-channel',
  '../official-channel',
])

describe('执行链商业依赖边界', () => {
  for (const file of executionChain) {
    test(`${file} 只通过 edition 契约访问商业能力`, () => {
      const violations = importsOf(file).filter((specifier) => commercialModules.has(specifier))
      expect(violations).toEqual([])
    })
  }
})

/**
 * 构建期二选一的实现边界。
 *
 * 模块级排除由 esbuild `--alias` 完成，靠的是「OSS 实现不得引用商业模块」。
 * 这条测试就是那个前提的机械校验：一旦有人往 oss.ts 里 import auth-service，
 * 开源包会静默把商业代码带回去（--alias 只换实现文件，不会检查实现内容）。
 */
describe('发行版实现边界', () => {
  test('OSS 实现不得引用任何商业模块', () => {
    const violations = importsOf('edition/oss.ts').filter((specifier) => commercialModules.has(specifier))
    expect(violations).toEqual([])
  })

  test('OSS 实现不得通过子路径间接引用商业实现', () => {
    const violations = importsOf('edition/oss.ts').filter((specifier) =>
      specifier.includes('account-ipc') ||
      specifier.includes('auth-service') ||
      specifier.includes('commercial') ||
      specifier.includes('official-channel'))
    expect(violations).toEqual([])
  })

  test('装配点只经构建期别名取实现，不直接 import 任何一侧', () => {
    // 这是 `export ... from` 而非 import，importsOf 取不到；直接看代码行。
    // 注释里会提到商业模块名（解释为什么不能引），必须先剔掉注释再判断。
    const code = readFileSync(resolve(libRoot, 'edition/index.ts'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(code).toContain("from '@profer/edition-impl'")
    expect(code).not.toContain('auth-service')
    expect(code).not.toContain('account-ipc')
    expect(code).not.toContain('commercial-routing-policy')
    expect(code).not.toMatch(/from '\.\/(oss|commercial)'/)
  })

  test('商业实现必须真实委托商业模块（防止被清空后仍能编译）', () => {
    const specifiers = importsOf('edition/commercial.ts')
    // 少了这几个导入，商业包会“构建成功但功能全空”，比构建失败更危险。
    expect(specifiers).toContain('../auth-service')
    expect(specifiers).toContain('../account-ipc')
    expect(specifiers).toContain('../commercial-routing-policy')
  })
})

/**
 * 商业语义不得内联在开源实现或共享解析里。
 *
 * 额度/充值、代管端点这类东西一旦写进共享模块，就会随开源包一起发出去；
 * 正确做法是收进发行版契约，由商业实现提供。
 */
describe('商业语义不进开源实现', () => {
  test('OSS 实现不得引用额度不足解析', () => {
    const violations = importsOf('edition/oss.ts').filter((specifier) =>
      specifier.includes('insufficient-credits'))
    expect(violations).toEqual([])
  })

  test('核心 barrel 不再导出额度不足解析（否则任何引用 barrel 的模块都会带上它）', () => {
    const indexPath = resolve(libRoot, '../../../../../packages/core/src/providers/index.ts')
    const source = readFileSync(indexPath, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n')
    expect(source).not.toContain("export * from './insufficient-credits.ts'")
  })

  test('OSS 的代管端点能力必须显式报错而不是静默返回空地址', () => {
    // 走到这里说明上层漏了 shouldUseManagedRoute 判定；静默返回 '' 会拼出
    // 一个看似正常的相对地址，失败点被推到远端，错误归因跑偏。
    const source = readFileSync(resolve(libRoot, 'edition/oss.ts'), 'utf8')
    expect(source).toContain('当前发行版不含代管通道')
  })
})
