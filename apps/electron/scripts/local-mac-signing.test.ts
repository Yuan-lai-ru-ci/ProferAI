import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { certificateRequirement, signCopy } = require('./local-mac-signing.cjs') as {
  certificateRequirement: (bundleId: string, fingerprint: string) => string
  signCopy: (options: { source: string; output: string; keychain: string; fingerprint: string }) => Promise<unknown>
}

const fingerprint = 'abcdef0123456789abcdef0123456789abcdef01'

describe('本地证书签名入口', () => {
  test('Given 指定证书 When 构造签名要求 Then 锚定完整证书而不是同名证书', () => {
    expect(certificateRequirement('com.profer.app', fingerprint.toUpperCase()))
      .toBe(`identifier "com.profer.app" and certificate leaf = H"${fingerprint}"`)
    expect(() => certificateRequirement('com.profer.app" or true', fingerprint)).toThrow('identifier')
    expect(() => certificateRequirement('com.profer.app', 'Profer Local Development')).toThrow('SHA-1')
  })

  test('Given 已存在输出 When 请求签名 Then 保留用户文件', async () => {
    if (process.platform !== 'darwin') return
    const root = mkdtempSync(join(tmpdir(), 'profer-local-sign-guard-'))
    try {
      const source = join(root, 'Source.app')
      const output = join(root, 'Existing.app')
      mkdirSync(source)
      mkdirSync(output)
      writeFileSync(join(output, 'keep.txt'), 'user content')
      await expect(signCopy({ source, output, keychain: '/missing', fingerprint })).rejects.toThrow('输出已存在')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('Given 输出在安装目录或源包内部 When 请求签名 Then 不触碰安装包', async () => {
    if (process.platform !== 'darwin') return
    const root = mkdtempSync(join(tmpdir(), 'profer-local-sign-guard-'))
    try {
      const source = join(root, 'Source.app')
      mkdirSync(source)
      writeFileSync(join(source, 'Info.plist'), '')
      for (const output of ['/Applications/Profer-Local-Sign-Test.app', join(source, 'Inside.app')]) {
        await expect(signCopy({ source, output, keychain: '/missing', fingerprint })).rejects.toThrow('独立副本')
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
