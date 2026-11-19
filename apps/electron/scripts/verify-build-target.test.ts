/**
 * 构建期门禁的契约：主进程 CJS bundle 里出现对纯 ESM 包的顶层 require 时必须失败。
 *
 * 0.16.27 的教训是这个检查只认硬编码包名 + 精确 `require("pkg")`：
 * 换一个包、或者写成子路径（`@earendil-works/pi-ai/compat`）就漏过去了。
 * 现在改成按 metafile 的 external 列表逐个 require.resolve()，与 Electron 加载产物同一条解析路径。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, 'verify-build-target.cjs')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** 最小合法 bundle：发行版字面量 + 更新源常量都齐全。 */
function ossBundle(extra: string): string {
  return `const t = false ? "oss" : "oss";const feed = "https://updates.profer.cn/";${extra}`
}

function runVerify(args: string[]) {
  return spawnSync('node', [scriptPath, ...args], { encoding: 'utf8' })
}

function writeFixture(bundle: string, meta?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-verify-build-target-'))
  roots.push(root)
  const bundlePath = join(root, 'main.cjs')
  writeFileSync(bundlePath, bundle)
  if (meta !== undefined) writeFileSync(join(root, 'main.meta.json'), JSON.stringify(meta))
  return bundlePath
}

function metaWith(imports: { path: string; kind: string; external?: boolean }[]): unknown {
  return { outputs: { 'main.cjs': { imports } } }
}

describe('verify-build-target：发行版断言', () => {
  test('干净的 oss bundle 通过', () => {
    const result = runVerify(['oss', writeFixture(ossBundle(''))])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('oss bundle verified')
  })

  test('商业版 bundle 混入 oss 字面量时失败', () => {
    const result = runVerify(['commercial', writeFixture(ossBundle(''))])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Commercial build target mismatch')
  })
})

describe('verify-build-target：纯 ESM 顶层 require', () => {
  test('metafile 列出 external require-call 指向纯 ESM 包时失败', () => {
    const bundlePath = writeFixture(
      ossBundle(''),
      metaWith([{ path: '@earendil-works/pi-coding-agent', kind: 'require-call', external: true }]),
    )
    const result = runVerify(['oss', bundlePath])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@earendil-works/pi-coding-agent')
    expect(result.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED')
  })

  test('子路径形式的纯 ESM 导出同样被抓到（0.16.27 的检查漏过这类）', () => {
    const bundlePath = writeFixture(
      ossBundle(''),
      metaWith([{ path: '@earendil-works/pi-ai/compat', kind: 'require-call', external: true }]),
    )
    const result = runVerify(['oss', bundlePath])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@earendil-works/pi-ai/compat')
  })

  test('dynamic-import 不在检查范围（它不会在加载阶段炸）', () => {
    const bundlePath = writeFixture(
      ossBundle(''),
      metaWith([
        { path: '@earendil-works/pi-coding-agent', kind: 'dynamic-import', external: true },
        { path: 'electron', kind: 'require-call', external: true },
      ]),
    )
    expect(runVerify(['oss', bundlePath]).status).toBe(0)
  })

  test('metafile 缺失时退回源码扫描，仍能识别顶层 require', () => {
    const bundlePath = writeFixture(ossBundle('const sdk = require("@earendil-works/pi-coding-agent");'))
    const result = runVerify(['oss', bundlePath])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('bundle 源码扫描')
  })
})
