import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePackagedCoreRuntime, verifyPackagedCoreRuntime } from './verify-packaged-core'
const roots: string[] = []
test('Given packaged Windows runtime Then reject missing helper and mismatched manifest architecture', () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-helper-package-')); roots.push(root)
  for (const file of ['core.js', 'profer-core.exe']) writeFileSync(join(root, file), 'fixture')
  const manifest = { format: 1, platform: 'win32', arch: 'x64', ownerHelper: { executable: 'profer-core-owner.exe', protocol: 1 } }
  writeFileSync(join(root, 'core-runtime.json'), JSON.stringify(manifest))
  expect(() => verifyPackagedCoreRuntime(root, 'win32', 'x64')).toThrow('helper')
  writeFileSync(join(root, 'core-runtime.json'), JSON.stringify({ ...manifest, arch: 'arm64' }))
  expect(() => verifyPackagedCoreRuntime(root, 'win32', 'x64')).toThrow('架构')
  expect(() => verifyPackagedCoreRuntime(root, 'win32', 'arm64')).toThrow('尚未验证')
})
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
test('Windows/Linux 使用本次解包目录而非开发资源', () => {
  expect(resolvePackagedCoreRuntime('/output', 'win32')).toBe(join('/output', 'win-unpacked', 'resources', 'bin'))
  expect(resolvePackagedCoreRuntime('/output', 'linux')).toBe(join('/output', 'linux-unpacked', 'resources', 'bin'))
  expect(() => resolvePackagedCoreRuntime('/output', 'freebsd')).toThrow('不支持')
})
test('Mac定位本次发行版bundle，缺失明确失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-core-package-location-')); roots.push(root)
  expect(() => resolvePackagedCoreRuntime(root, 'darwin')).toThrow('未找到')
  mkdirSync(join(root, 'mac-arm64', 'Profer.app'), { recursive: true })
  expect(resolvePackagedCoreRuntime(root, 'darwin')).toBe(join(root, 'mac-arm64/Profer.app/Contents/Resources/bin'))
})
