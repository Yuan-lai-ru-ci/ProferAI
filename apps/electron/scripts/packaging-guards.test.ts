import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface PackagingHostModule {
  assertBuilderPackagingHost: (args: string[], hostPlatform?: string) => void
  assertPackagingHost: (targetPlatform: string, hostPlatform?: string) => void
  getRequestedPlatform: (args: string[]) => string | undefined
  getRequestedPlatforms: (args: string[]) => string[]
}

interface PackagedCliContractModule {
  verifyPackagedWindowsCli: (binDir: string) => string
}

const {
  assertBuilderPackagingHost,
  assertPackagingHost,
  getRequestedPlatform,
  getRequestedPlatforms,
} = require('./packaging-host.cjs') as PackagingHostModule
const { verifyPackagedWindowsCli } = require('./packaged-cli-contract.cjs') as PackagedCliContractModule

const temporaryRoots: string[] = []

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-packaging-guard-'))
  temporaryRoots.push(root)
  return root
}

function createBinDir(): string {
  const binDir = join(createTemporaryRoot(), 'bin')
  mkdirSync(binDir)
  return binDir
}

function getTopLevelSection(config: string, key: string): string {
  const marker = `${key}:\n`
  const start = config.indexOf(marker)
  if (start < 0) throw new Error(`配置缺少 ${key} 段`)
  const remainder = config.slice(start + marker.length)
  const nextSection = remainder.search(/^[A-Za-z][A-Za-z0-9_-]*:/m)
  return nextSection < 0 ? remainder : remainder.slice(0, nextSection)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Windows 打包宿主门禁', () => {
  test('Given macOS 或 Linux 宿主 When 请求 Windows 打包 Then 在构建前明确失败', () => {
    expect(() => assertPackagingHost('win', 'darwin')).toThrow('Windows 打包必须在 Windows 宿主上运行')
    expect(() => assertPackagingHost('win', 'linux')).toThrow('Windows 打包必须在 Windows 宿主上运行')
  })

  test('Given Windows 宿主 When 请求 Windows 打包 Then 允许继续', () => {
    expect(() => assertPackagingHost('win', 'win32')).not.toThrow()
    expect(getRequestedPlatform(['--x64', '--win'])).toBe('win')
    expect(() => assertBuilderPackagingHost(['--win', '--x64'], 'win32')).not.toThrow()
  })

  test('Given 组合平台参数 When 其中包含 Windows Then 不允许用参数顺序绕过门禁', () => {
    expect(getRequestedPlatforms(['--mac', '--win'])).toEqual(['mac', 'win'])
    expect(() => assertBuilderPackagingHost(['--mac', '--win'], 'darwin'))
      .toThrow('Windows 打包必须在 Windows 宿主上运行')
    expect(() => assertBuilderPackagingHost(['-mw'], 'darwin'))
      .toThrow('Windows 打包必须在 Windows 宿主上运行')
    expect(() => assertBuilderPackagingHost(['--win=nsis'], 'darwin'))
      .toThrow('Windows 打包必须在 Windows 宿主上运行')
  })
})

describe('Windows 随包 CLI 契约', () => {
  test('Given 目录只有非空 profer.exe When 验证 Then 通过', () => {
    const binDir = createBinDir()
    const cliPath = join(binDir, 'profer.exe')
    writeFileSync(cliPath, 'windows-cli')

    expect(verifyPackagedWindowsCli(binDir)).toBe(cliPath)
  })

  test('Given CLI 缺失或只有无扩展名文件 When 验证 Then 拒绝', () => {
    const missingBinDir = join(createTemporaryRoot(), 'bin')
    expect(() => verifyPackagedWindowsCli(missingBinDir)).toThrow('目录不存在')

    const wrongBinDir = createBinDir()
    writeFileSync(join(wrongBinDir, 'profer'), 'mac-cli')
    expect(() => verifyPackagedWindowsCli(wrongBinDir)).toThrow('必须且只能包含 profer.exe')
  })

  test('Given 两种宿主 CLI 并存或 exe 为空 When 验证 Then 拒绝', () => {
    const mixedBinDir = createBinDir()
    writeFileSync(join(mixedBinDir, 'profer'), 'mac-cli')
    writeFileSync(join(mixedBinDir, 'profer.exe'), 'windows-cli')
    expect(() => verifyPackagedWindowsCli(mixedBinDir)).toThrow('必须且只能包含 profer.exe')

    const emptyBinDir = createBinDir()
    writeFileSync(join(emptyBinDir, 'profer.exe'), '')
    expect(() => verifyPackagedWindowsCli(emptyBinDir)).toThrow('不能为空')
  })
})

describe('平台打包入口配置', () => {
  test('Given electron-builder 配置 When 选择平台 Then 只复制对应 CLI 文件名', () => {
    const appDir = resolve(import.meta.dir, '..')
    const config = readFileSync(join(appDir, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
    const commonResources = getTopLevelSection(config, 'extraResources')
    const macConfig = getTopLevelSection(config, 'mac')
    const linuxConfig = getTopLevelSection(config, 'linux')
    const winConfig = getTopLevelSection(config, 'win')

    expect(commonResources).not.toContain('resources/bin')
    expect(macConfig).toContain('from: resources/bin/profer\n      to: bin/profer')
    expect(linuxConfig).toContain('from: resources/bin/profer\n      to: bin/profer')
    expect(winConfig).toContain('from: resources/bin/profer.exe\n      to: bin/profer.exe')
  })

  test('Given Windows 发布脚本 When 启动构建 Then 宿主门禁总是最先执行', () => {
    const appDir = resolve(import.meta.dir, '..')
    const packageJson = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const scriptName of [
      'dist:win',
      'dist:win-github',
      'dist:win-commercial',
      'release:verify:windows',
    ]) {
      expect(packageJson.scripts[scriptName]).toStartWith('bun run verify:packaging-host:win &&')
    }
  })
})
