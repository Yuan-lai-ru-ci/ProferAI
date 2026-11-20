import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertElfX64, verifyLinuxPackageStructure, verifyLinuxPackage } from './verify-linux-package.cjs'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'profer-linux-fixture-'))
  roots.push(root)
  const elf = Buffer.alloc(64)
  elf.write('7f454c46', 0, 'hex')
  elf[4] = 2
  elf[5] = 1
  elf.writeUInt16LE(62, 18)
  const put = (name: string, binary = false) => {
    const file = join(root, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, binary ? elf : 'fixture-not-a-real-package')
    chmodSync(file, binary ? 0o755 : 0o644)
    return file
  }
  put('profer', true)
  put('resources/bin/profer', true)
  put('resources/bin/profer-core', true)
  put('resources/bin/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', true)
  put('resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', true)
  put('resources/app.asar.unpacked/node_modules/@napi-rs/test/addon.node', true)
  put('resources/app.asar.unpacked/dist/session-persistence-worker.cjs')
  put('resources/app.asar')
  return { root, put }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('Linux 包闭包结构 fixture（不执行伪造产物）', () => {
  test('Given 完整 x64 fixture Then 结构检查通过', () => {
    expect(verifyLinuxPackageStructure(fixture().root).nativeFileCount).toBe(1)
  })
  test.each(['profer', 'resources/bin/profer', 'resources/bin/profer-core', 'resources/bin/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', 'resources/app.asar', 'resources/app.asar.unpacked/dist/session-persistence-worker.cjs', 'resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'])(
    'Given 缺少 %s Then 拒绝', (name) => {
      const { root } = fixture()
      rmSync(join(root, name))
      expect(() => verifyLinuxPackageStructure(root)).toThrow()
    },
  )
  test('Given CLI 无执行权限 Then 拒绝', () => {
    const { root } = fixture()
    chmodSync(join(root, 'resources/bin/profer'), 0o644)
    expect(() => verifyLinuxPackageStructure(root)).toThrow('执行权限')
  })
  test('Given 非 ELF 或 arm64 native Then 拒绝', () => {
    const { root, put } = fixture()
    expect(() => assertElfX64(put('wrong', false))).toThrow('ELF x64')
    const file = join(root, 'resources/app.asar.unpacked/node_modules/@napi-rs/test/addon.node')
    const bytes = readFileSync(file)
    bytes.writeUInt16LE(183, 18)
    writeFileSync(file, bytes)
    expect(() => verifyLinuxPackageStructure(root)).toThrow('ELF x64')
  })
  test('Given 缺少 Pi native 或依赖逃逸 Then 拒绝', () => {
    const { root } = fixture()
    rmSync(join(root, 'resources/app.asar.unpacked/node_modules/@napi-rs'), { recursive: true })
    expect(() => verifyLinuxPackageStructure(root)).toThrow('Pi native')
    symlinkSync(tmpdir(), join(root, 'resources/bin/node_modules/escape'))
    expect(() => verifyLinuxPackageStructure(root)).toThrow('依赖逃逸')
  })
  test('Given pi-tui 多平台 prebuilds Then 只把 linux-x64 计入目标证据', () => {
    const { root, put } = fixture()
    rmSync(join(root, 'resources/app.asar.unpacked/node_modules/@napi-rs'), { recursive: true })
    const native = 'resources/app.asar.unpacked/node_modules/@earendil-works/pi-tui/native'
    for (const target of ['darwin/prebuilds/darwin-arm64', 'darwin/prebuilds/darwin-x64', 'win32/prebuilds/win32-x64', 'linux/prebuilds/linux-arm64']) {
      put(`${native}/${target}/platform.node`)
    }
    expect(() => verifyLinuxPackageStructure(root)).toThrow('Pi native')
    const target = put(`${native}/linux/prebuilds/linux-x64/platform.node`, true)
    expect(verifyLinuxPackageStructure(root).nativeFileCount).toBe(1)
    const bytes = readFileSync(target)
    bytes.writeUInt16LE(183, 18)
    writeFileSync(target, bytes)
    expect(() => verifyLinuxPackageStructure(root)).toThrow('ELF x64')
  })
  test('Given 非目标 prebuild 内链接逃逸 Then 仍拒绝', () => {
    const { root, put } = fixture()
    const target = put('resources/app.asar.unpacked/node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/platform.node')
    rmSync(target)
    symlinkSync(tmpdir(), target)
    expect(() => verifyLinuxPackageStructure(root)).toThrow('依赖逃逸')
  })
  test('Given 非 linux-x64 宿主 Then 不运行真实产物验证', () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') expect(() => verifyLinuxPackage('/missing')).toThrow('linux-x64')
  })
  test('Given builder Linux 配置 Then 两种 x64 格式、可执行名及商业命名固定', () => {
    const base = readFileSync(join(import.meta.dir, '../electron-builder.yml'), 'utf8').split('\nlinux:\n')[1]!.split('\nwin:')[0]!
    expect(base).toContain('executableName: profer')
    expect(base).toContain('category: Development')
    expect(base).toContain('maintainer: Profer Team <ybwwsnbb@126.com>')
    expect(JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')).homepage).toBe('https://profer.cn')
    expect(base).toContain('target: AppImage\n      arch: [x64]')
    expect(base).toContain('target: deb\n      arch: [x64]')
    const commercial = readFileSync(join(import.meta.dir, '../electron-builder.commercial.yml'), 'utf8')
    expect(commercial).toContain('linux:\n  artifactName: Profer-Commercial-${version}-linux-${arch}.${ext}')
  })
})
