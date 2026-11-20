import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePackagedCoreRuntime } from './verify-packaged-core'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test('Windows/Linux 使用本次解包目录而非开发资源', () => {
  expect(resolvePackagedCoreRuntime('/output', 'win32')).toBe('/output/win-unpacked/resources/bin')
  expect(resolvePackagedCoreRuntime('/output', 'linux')).toBe('/output/linux-unpacked/resources/bin')
  expect(() => resolvePackagedCoreRuntime('/output', 'freebsd')).toThrow('不支持')
})
test('Mac定位本次发行版bundle，缺失明确失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-core-package-location-')); roots.push(root)
  expect(() => resolvePackagedCoreRuntime(root, 'darwin')).toThrow('未找到')
  mkdirSync(join(root, 'mac-arm64', 'Profer.app'), { recursive: true })
  expect(resolvePackagedCoreRuntime(root, 'darwin')).toBe(join(root, 'mac-arm64/Profer.app/Contents/Resources/bin'))
})
