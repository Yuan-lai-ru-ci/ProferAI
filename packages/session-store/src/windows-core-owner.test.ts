import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeOwnerResponse, resolveWindowsOwnerHelper } from './windows-core-owner'

function installation() {
  const root = mkdtempSync(join(tmpdir(), 'owner-installation-'))
  const manifest = (changes: object = {}) => writeFileSync(join(root, 'core-runtime.json'), JSON.stringify({
    format: 1, platform: 'win32', arch: 'x64', ownerHelper: { executable: 'profer-core-owner.exe', protocol: 1 }, ...changes,
  }))
  writeFileSync(join(root, 'profer-core-owner.exe'), 'fixture')
  manifest()
  return { root, manifest, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('Given 选定 Core 安装 When 定位 helper Then 只允许该运行目录和精确协议/架构', () => {
  const fixture = installation()
  try {
    expect(resolveWindowsOwnerHelper(fixture.root, 'x64')).toBe(join(realpathSync(fixture.root), 'profer-core-owner.exe'))
    expect(() => resolveWindowsOwnerHelper(undefined, 'x64')).toThrow('Core 安装目录')
    expect(() => resolveWindowsOwnerHelper('relative', 'x64')).toThrow('绝对路径')
    expect(() => resolveWindowsOwnerHelper(fixture.root, 'arm64')).toThrow('架构')
    fixture.manifest({ ownerHelper: { executable: '../profer-core-owner.exe', protocol: 1 } })
    expect(() => resolveWindowsOwnerHelper(fixture.root, 'x64')).toThrow('协议')
    fixture.manifest({ ownerHelper: { executable: 'profer-core-owner.exe', protocol: 2 } })
    expect(() => resolveWindowsOwnerHelper(fixture.root, 'x64')).toThrow('协议')
    fixture.manifest()
    rmSync(join(fixture.root, 'profer-core-owner.exe'))
    expect(() => resolveWindowsOwnerHelper(fixture.root, 'x64')).toThrow('缺少 Windows')
  } finally { fixture.cleanup() }
})

test('Given 原生 helper 响应 When 解析 Then 安全拒绝不变成缺失且错误不回显载荷', () => {
  expect(decodeOwnerResponse('{"version":1,"ok":true,"data":true}')).toBe(true)
  for (const code of ['ENOENT', 'ESRCH', 'BUSY', 'UNSAFE', 'PROTOCOL', 'IO']) {
    try { decodeOwnerResponse(JSON.stringify({ version: 1, ok: false, code, message: 'fixture-secret' })); throw new Error('expected failure') }
    catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe(code)
      expect((error as Error).message).not.toContain('fixture-secret')
    }
  }
  for (const value of ['{', '{"version":2,"ok":true}', '{"version":1,"ok":"true"}', '{"version":1,"ok":false,"code":"ENOEXEC"}']) {
    expect(() => decodeOwnerResponse(value)).toThrow('协议')
  }
})
