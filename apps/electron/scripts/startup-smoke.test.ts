/**
 * 启动冒烟脚本的纯函数契约。
 *
 * 这条门禁的价值全在「判定不能假阳性、也不能假阴性」：
 * 0.16.27 的四套包构建/签名/元数据全绿但起不来，只有真启动产物才能拦住；
 * 而误报会让正常的发版被无故阻塞。所以把三个判定点（产物定位、探针解析、结论）
 * 都拆成纯函数单独测，真正的进程启动只在 verify:startup 里做。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateStartup, parseArgs, parseProbeStages, resolveStartupArtifact } from './startup-smoke'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-startup-smoke-test-'))
  roots.push(root)
  return root
}

describe('启动冒烟：产物定位', () => {
  test('macOS 在 out/<arch>/Profer.app 与 out/Profer.app 两种布局下都能找到可执行文件', () => {
    const root = tempRoot()
    const nested = join(root, 'mac-arm64', 'Profer.app', 'Contents', 'MacOS')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'Profer'), '#!/bin/sh\n')
    expect(resolveStartupArtifact({ platform: 'darwin', outputDir: root })).toEqual({
      binary: join(nested, 'Profer'),
      label: join(root, 'mac-arm64', 'Profer.app'),
    })

    const flat = tempRoot()
    const flatMacOs = join(flat, 'Profer.app', 'Contents', 'MacOS')
    mkdirSync(flatMacOs, { recursive: true })
    writeFileSync(join(flatMacOs, 'Profer'), '#!/bin/sh\n')
    expect(resolveStartupArtifact({ platform: 'darwin', outputDir: flat }).binary).toBe(join(flatMacOs, 'Profer'))
  })

  test('Windows 取 win-unpacked/Profer.exe；缺失时报错而不是静默通过', () => {
    const root = tempRoot()
    const unpacked = join(root, 'win-unpacked')
    mkdirSync(unpacked, { recursive: true })
    writeFileSync(join(unpacked, 'Profer.exe'), '')
    expect(resolveStartupArtifact({ platform: 'win32', outputDir: root }).binary).toBe(join(unpacked, 'Profer.exe'))
    expect(() => resolveStartupArtifact({ platform: 'win32', outputDir: join(root, 'missing') })).toThrow(/未找到 Windows 解包产物/)
  })

  test('--app 显式指向可执行文件时原样使用；目录必须是 .app bundle', () => {
    const root = tempRoot()
    const binary = join(root, 'Custom.exe')
    writeFileSync(binary, '')
    expect(resolveStartupArtifact({ platform: 'win32', outputDir: root, appPath: binary })).toEqual({ binary, label: binary })
    expect(() => resolveStartupArtifact({ platform: 'darwin', outputDir: root, appPath: root })).toThrow(/不是 macOS \.app bundle/)
  })
})

describe('启动冒烟：探针解析与结论', () => {
  test('探针按行解析 stage，坏行（进程被砍时的半行）忽略', () => {
    const content = [
      '{"stage":"main-loaded"}',
      '',
      '{"stage":"window-created"}',
      '{"stage":"trunc',
    ].join('\n')
    expect(parseProbeStages(content)).toEqual(['main-loaded', 'window-created'])
    expect(parseProbeStages('')).toEqual([])
  })

  test('写出 window-created 即通过', () => {
    expect(evaluateStartup({ stages: ['main-loaded', 'window-created'], stderr: '', exitCode: null, timedOut: false }).ok).toBe(true)
  })

  test('加载阶段崩溃（纯 ESM 包被顶层 require）单独报出，与“没有探针”区分开', () => {
    const result = evaluateStartup({
      stages: [],
      stderr: 'Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../pi-coding-agent/package.json',
      exitCode: null,
      timedOut: true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED')
  })

  test('只有 main-loaded 时按“没建出窗口”报告，而不是“没加载”', () => {
    const timedOut = evaluateStartup({ stages: ['main-loaded'], stderr: '', exitCode: null, timedOut: true })
    expect(timedOut.ok).toBe(false)
    expect(timedOut.reason).toContain('没有创建主窗口')

    const exited = evaluateStartup({ stages: ['main-loaded'], stderr: '', exitCode: 1, timedOut: false })
    expect(exited.reason).toContain('exit 1')
  })

  test('完全没有探针记录说明 bundle 没求值到主入口', () => {
    const result = evaluateStartup({ stages: [], stderr: '', exitCode: 1, timedOut: false })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('加载阶段')
  })

  test('bootstrap 抛错但降级窗口仍在，不算启动成功（需要人看）', () => {
    const result = evaluateStartup({ stages: ['main-loaded', 'bootstrap-failed'], stderr: '', exitCode: null, timedOut: true })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('bootstrap')
  })
})

describe('启动冒烟：参数解析', () => {
  test('默认走 out/，超时可覆盖；非法超时直接报错', () => {
    const options = parseArgs([], {})
    expect(options.timeoutMs).toBe(45_000)
    expect(options.outputDir.endsWith('/out')).toBe(true)
    expect(options.keepProfile).toBe(false)

    const commercial = parseArgs(['--target', 'commercial', '--timeout', '90000', '--keep-profile'], {})
    expect(commercial.timeoutMs).toBe(90_000)
    expect(commercial.outputDir.endsWith('/out-commercial')).toBe(true)
    expect(commercial.keepProfile).toBe(true)

    expect(() => parseArgs(['--timeout', '10'], {})).toThrow(/--timeout/)
    expect(() => parseArgs(['--target', 'other'], {})).toThrow(/--target/)
  })
})
