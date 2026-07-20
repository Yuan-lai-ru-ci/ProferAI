import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appDir = resolve(import.meta.dir, '..')

async function read(path: string): Promise<string> {
  return Bun.file(path).text()
}

describe('Pi packaged runtime 闭包', () => {
  test('electron-builder 解包 Pi 所需的 native/WASM scope，并保留 Profer 打包契约', async () => {
    const builder = await read(join(appDir, 'electron-builder.yml'))

    for (const pattern of [
      'node_modules/@silvia-odwyer/**',
      'node_modules/@mariozechner/**',
      'node_modules/@napi-rs/**',
      'node_modules/@earendil-works/pi-tui/native/**',
    ]) {
      expect(builder).toContain(`- "${pattern}"`)
    }
    expect(builder).toContain('appId: com.profer.app')
    expect(builder).toContain('afterPack: scripts/after-pack.cjs')
  })

  test('probe 按 ESM import export 解析 Pi 包，不依赖 CJS require.resolve', () => {
    const probe = require('./packaged-pi-probe.cjs') as {
      resolvePackageImportEntry(appArchive: string, packageName: string): string
    }
    const root = mkdtempSync(join(tmpdir(), 'profer-pi-esm-probe-'))
    try {
      const packageDir = join(root, 'node_modules', '@earendil-works', 'pi-ai')
      mkdirSync(packageDir, { recursive: true })
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      }))

      expect(probe.resolvePackageImportEntry(root, '@earendil-works/pi-ai'))
        .toBe(join(packageDir, 'dist/index.js'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('probe 只枚举目标 unpacked scope 内的 native/WASM 文件', () => {
    const probe = require('./packaged-pi-probe.cjs') as {
      findUnpackedNativeFiles(root: string): string[]
    }
    const root = mkdtempSync(join(tmpdir(), 'profer-pi-native-probe-'))
    try {
      const allowedNode = join(root, '@napi-rs', 'canvas', 'binding.node')
      const allowedWasm = join(root, '@silvia-odwyer', 'photon-node', 'binding.wasm')
      const ignored = join(root, 'other', 'binding.node')
      mkdirSync(join(allowedNode, '..'), { recursive: true })
      mkdirSync(join(allowedWasm, '..'), { recursive: true })
      mkdirSync(join(ignored, '..'), { recursive: true })
      writeFileSync(allowedNode, '')
      writeFileSync(allowedWasm, '')
      writeFileSync(ignored, '')

      expect(probe.findUnpackedNativeFiles(root)).toEqual([allowedNode, allowedWasm].sort())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
