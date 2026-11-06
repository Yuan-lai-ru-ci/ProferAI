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

interface MacSignatureModule {
  expectedDesignatedRequirement: (bundleId: string) => string
  parseDesignatedRequirement: (codesignOutput: string) => string | null
  assertMacSignatureContract: (appPath: string) => { bundleId: string; designatedRequirement: string }
}

const {
  assertBuilderPackagingHost,
  assertPackagingHost,
  getRequestedPlatform,
  getRequestedPlatforms,
} = require('./packaging-host.cjs') as PackagingHostModule
const { verifyPackagedWindowsCli } = require('./packaged-cli-contract.cjs') as PackagedCliContractModule
const {
  expectedDesignatedRequirement,
  parseDesignatedRequirement,
  assertMacSignatureContract,
} = require('./macos-signature.cjs') as MacSignatureModule

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

  test('Given electron-builder 配置 When 打包 macOS Then 挂上签名补签钩子', () => {
    const appDir = resolve(import.meta.dir, '..')
    const config = readFileSync(join(appDir, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
    // afterSign 必须在 DMG/ZIP 打包之前执行，否则归档里仍是不可验证的包。
    expect(config).toContain('afterSign: scripts/after-sign-mac.cjs')
    expect(config).toContain('afterPack: scripts/after-pack.cjs')
  })

  test('Given 发布脚本 When 校验 macOS 产物 Then 使用共享签名契约而非 spctl', () => {
    const appDir = resolve(import.meta.dir, '..')
    const repoRoot = resolve(appDir, '..', '..')
    const pushScript = readFileSync(join(repoRoot, 'scripts', 'push-mac-release.cjs'), 'utf8')
    const packageJson = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      version: string
    }
    // ad-hoc 签名下 spctl 评估必然 rejected，且 Squirrel.Mac 安装更新不依赖 spctl。
    expect(pushScript).not.toMatch(/run\(`spctl/)
    expect(pushScript).toMatch(/assertMacSignatureContract\(appPath\)/)
    expect(pushScript).toContain("require('../apps/electron/scripts/macos-signature.cjs')")
    // 增量下载索引缺失会让每次更新退化为全量下载。
    expect(pushScript).toContain('zip.blockmap')
    expect(packageJson.scripts['verify:mac-signature']).toBe('node scripts/verify-macos-signature.cjs')
    const changelog = JSON.parse(
      readFileSync(join(appDir, 'resources', 'CHANGELOG.json'), 'utf8'),
    ) as { releases: Array<{ version: string }> }
    expect(changelog.releases[0].version).toBe(packageJson.version)
  })

  test('Given Windows 安装器配置 When 覆盖安装 Then 不写被 Shell 引用的 .ico 且先关闭旧进程', () => {
    const appDir = resolve(import.meta.dir, '..')
    const config = readFileSync(join(appDir, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
    const commonResources = getTopLevelSection(config, 'extraResources')
    const winConfig = getTopLevelSection(config, 'win')

    // 文件关联不能自带 icon：那样 electron-builder 会把图标写成 $INSTDIR\resources\icon.ico，
    // 并把该路径注册成 DefaultIcon；升级时 Explorer 仍可能持有句柄，安装器写不进去。
    const fileAssociations = winConfig.slice(winConfig.indexOf('fileAssociations:'))
    expect(fileAssociations).not.toContain('icon:')
    // 窗口图标用改名后的副本，安装器不再改写旧版注册表引用的路径。
    expect(commonResources).toContain('from: resources/icon.ico\n    to: app-icon.ico')

    // 安装前必须先关掉还在托盘里的 Profer，并且有 /F 与提权兜底。
    expect(config).toContain('include: scripts/nsis-custom.nsh')
    const nsisInclude = readFileSync(join(appDir, 'scripts', 'nsis-custom.nsh'), 'utf8')
    expect(nsisInclude).toContain('!macro customCheckAppRunning')
    expect(nsisInclude).toContain('--quit')
    expect(nsisInclude).toContain('taskkill.exe" /F /T /IM ${APP_EXECUTABLE_FILENAME}')
    expect(nsisInclude).toContain('ExecShell "runas"')
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

describe('macOS 签名契约', () => {
  test('Given bundle id When 构造 designated requirement Then 只锚定 identifier', () => {
    // 钉死 identifier 是 ad-hoc 下唯一能跨版本稳定的形式；换成 cdhash 会让每次构建的
    // DR 都不同，Squirrel.Mac 就会拒绝安装新包。
    expect(expectedDesignatedRequirement('com.profer.app')).toBe('identifier "com.profer.app"')
    expect(() => expectedDesignatedRequirement('')).toThrow('bundle identifier')
  })

  test('Given codesign 输出 When 解析 Then 兼容显式与缺省派生两种 DR 写法', () => {
    const explicit = [
      'Executable=/Applications/Profer.app/Contents/MacOS/Profer',
      'designated => identifier "com.profer.app"',
    ].join('\n')
    expect(parseDesignatedRequirement(explicit)).toBe('identifier "com.profer.app"')

    // ad-hoc 未显式指定 -r 时，codesign 派生的 DR 是 cdhash，且行首带 `#`。
    const derived = [
      'Executable=/Applications/Profer.app/Contents/MacOS/Profer',
      '# designated => cdhash H"5c22a19a764af33c82dfc3e3191db283a5b8e376"',
    ].join('\n')
    expect(parseDesignatedRequirement(derived)).toBe(
      'cdhash H"5c22a19a764af33c82dfc3e3191db283a5b8e376"',
    )

    expect(parseDesignatedRequirement('Executable=/tmp/nothing\n')).toBeNull()
  })

  test('Given 未签名的 App 产物 When 断言契约 Then 失败并指出 DR 不符', () => {
    if (process.platform !== 'darwin') return
    // 空目录没有 Info.plist，必须在读取 bundle id 阶段就明确失败，而不是静默通过。
    const emptyApp = join(createTemporaryRoot(), 'Profer.app')
    mkdirSync(join(emptyApp, 'Contents'), { recursive: true })
    expect(() => assertMacSignatureContract(emptyApp)).toThrow('Info.plist')
    expect(() => assertMacSignatureContract(join(createTemporaryRoot(), 'Missing.app')))
      .toThrow('不存在')
  })
})
