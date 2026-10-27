import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { getConfigDir } from './config-paths'
import {
  isCredentialSensitivePath,
  isPathInsideAnyRoot,
  isPathInsideRoot,
  isReadOnlyPreviewPathAllowed,
  isSystemSensitivePath,
  type PreviewPathPolicy,
} from './preview-path-policy'

/** 临时目录 fixture：模拟「皮肤目录 / 日志目录」这类会话工作区之外的路径。 */
function createFixtureFile(...segments: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'profer-preview-policy-'))
  const file = join(root, ...segments)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, 'content')
  return file
}

describe('isReadOnlyPreviewPathAllowed', () => {
  test('会话工作区之外的普通文件放行（皮肤目录场景）', () => {
    const skinPreview = createFixtureFile('.profer-dev', 'skins', 'profer-lumen-mist-skin', 'preview.png')
    expect(isReadOnlyPreviewPathAllowed(skinPreview)).toBe(true)
  })

  test('临时日志文件放行（/tmp 日志场景）', () => {
    const logFile = createFixtureFile('logs', 'profer-dev-agent.log')
    expect(isReadOnlyPreviewPathAllowed(logFile)).toBe(true)
  })

  test('目录本身也放行（用于在文件管理器中定位）', () => {
    const skinDir = dirname(createFixtureFile('.profer-dev', 'skins', 'demo-skin', 'skin.css'))
    expect(isReadOnlyPreviewPathAllowed(skinDir)).toBe(true)
  })

  test('系统敏感位置拒绝', () => {
    expect(isReadOnlyPreviewPathAllowed('/etc/hosts')).toBe(false)
    expect(isSystemSensitivePath('/etc')).toBe(true)
  })

  test('凭据目录拒绝', () => {
    const secret = createFixtureFile('.ssh', 'id_ed25519')
    const policy: PreviewPathPolicy = { credentialSensitiveRoots: [join(dirname(secret), '..')] }
    expect(isReadOnlyPreviewPathAllowed(secret, policy)).toBe(false)
  })

  test('指向凭据目录的符号链接按真实路径拒绝', () => {
    const secret = createFixtureFile('.ssh', 'id_ed25519')
    const credentialRoot = dirname(secret)
    const linkDir = createFixtureFile('links', 'placeholder.txt')
    const link = join(dirname(linkDir), 'escape.png')
    symlinkSync(secret, link)
    const policy: PreviewPathPolicy = { credentialSensitiveRoots: [credentialRoot] }
    expect(isReadOnlyPreviewPathAllowed(link, policy)).toBe(false)
  })

  test('不存在的路径拒绝', () => {
    expect(isReadOnlyPreviewPathAllowed(join(tmpdir(), 'profer-preview-policy-missing', 'nope.md'))).toBe(false)
    expect(isReadOnlyPreviewPathAllowed('')).toBe(false)
  })
})

describe('isCredentialSensitivePath 默认边界', () => {
  test('覆盖私钥、钥匙串与 Profer 自身凭据', () => {
    expect(isCredentialSensitivePath(join(homedir(), '.ssh', 'id_ed25519'))).toBe(true)
    expect(isCredentialSensitivePath(join(homedir(), 'Library', 'Keychains', 'login.keychain-db'))).toBe(true)
    expect(isCredentialSensitivePath(join(getConfigDir(), 'auth-tokens.enc'))).toBe(true)
    expect(isCredentialSensitivePath(join(getConfigDir(), 'channels.json'))).toBe(true)
    expect(isCredentialSensitivePath(join(getConfigDir(), 'sdk-config', 'x.json'))).toBe(true)
  })

  test('不放宽到整个配置文件目录（皮肤目录仍可预览）', () => {
    expect(isCredentialSensitivePath(join(getConfigDir(), 'skins', 'demo-skin', 'skin.css'))).toBe(false)
  })
})

/**
 * 回归：路径前缀判定必须容忍大小写差异。
 *
 * Windows 上 `realpathSync` 不归一大小写（小写输入原样返回），而文件系统大小写不敏感。
 * 曾经直接用 `startsWith` 比较，导致 Agent 输出的小写盘符路径（`c:/users/...`）
 * 被判定为「越界」——表现为预览正常、但「用默认应用打开」静默失败；
 * 反过来，靠改大小写还能绕过 ~/.ssh 这类凭据目录拦截。
 */
describe('isPathInsideRoot 大小写', () => {
  const insideFixture = (): { file: string; root: string } => {
    const file = createFixtureFile('workspace', 'nested', 'image.png')
    return { file, root: join(dirname(file), '..') }
  }

  test('根内路径判定为在根内', () => {
    const { file, root } = insideFixture()
    expect(isPathInsideRoot(file, root)).toBe(true)
    expect(isPathInsideAnyRoot(file, [join(tmpdir(), 'unrelated-root'), root])).toBe(true)
  })

  test('根外路径仍拒绝（修复后不放宽边界）', () => {
    const { file } = insideFixture()
    const outsideRoot = createFixtureFile('another-workspace', 'placeholder.txt')
    expect(isPathInsideRoot(file, dirname(outsideRoot))).toBe(false)
  })

  test('根目录本身（文件系统根）不应拼出双分隔符', () => {
    const { file } = insideFixture()
    const fsRoot = file.slice(0, file.indexOf(sep) + 1) || sep
    expect(isPathInsideRoot(file, fsRoot)).toBe(true)
  })

  const windowsOnly = process.platform === 'win32' ? test : test.skip

  windowsOnly('全小写目标路径仍判定在根内（本次「打开无反应」的根因）', () => {
    const { file, root } = insideFixture()
    expect(isPathInsideRoot(file.toLowerCase(), root)).toBe(true)
    expect(isPathInsideAnyRoot(file.replace(/\\/g, '/').toLowerCase(), [root])).toBe(true)
  })

  windowsOnly('凭据目录换大小写后仍被拦截（安全边界不能被绕过）', () => {
    const secret = createFixtureFile('.ssh', 'id_ed25519')
    const credentialRoot = dirname(secret)
    expect(isCredentialSensitivePath(secret, [credentialRoot])).toBe(true)
    expect(isCredentialSensitivePath(secret.toLowerCase(), [credentialRoot])).toBe(true)
    expect(
      isReadOnlyPreviewPathAllowed(secret.toLowerCase(), { credentialSensitiveRoots: [credentialRoot] }),
    ).toBe(false)
  })
})
