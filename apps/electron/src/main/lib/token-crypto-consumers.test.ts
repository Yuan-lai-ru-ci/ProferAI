import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { safeStorage } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let identityFails = false
mock.module('./identity-service', () => ({ getOrCreateDeviceIdentity: () => {
  if (identityFails) throw new Error('fixture identity unavailable')
  return { deviceId: 'fixture-consumer-device' }
} }))
const feishu = await import('./feishu-config')
const dingtalk = await import('./dingtalk-config')
const wechat = await import('./wechat-config')
const voice = await import('./voice-dictation-settings-service')
const settings = await import('./settings-service')
const tools = await import('./chat-tool-config')
const originalConfigDir = process.env.PROFER_CONFIG_DIR
let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'profer-token-consumers-'))
  process.env.PROFER_CONFIG_DIR = configDir
  identityFails = false
  settings.clearSettingsCache()
})
afterEach(() => {
  settings.clearSettingsCache()
  mock.restore()
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('共享 token-crypto 消费者兼容', () => {
  for (const osEncrypted of [false, true]) {
    test(`Given ${osEncrypted ? '带前缀 safeStorage' : 'AES'} When 保存其它消费者凭据 Then 正常解密且无明文落盘`, () => {
      if (osEncrypted) {
        spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
        spyOn(safeStorage, 'encryptString').mockImplementation((value) => Buffer.from('fixture-opaque:' + value))
        spyOn(safeStorage, 'decryptString').mockImplementation((buffer) => buffer.toString().slice('fixture-opaque:'.length))
      }
      const secret = 'fixture-consumer-secret'
      const feishuBot = feishu.saveFeishuBotConfig({ name: 'Fixture Feishu', enabled: true, appId: 'fixture-app', appSecret: secret })
      const dingtalkBot = dingtalk.saveDingTalkBotConfig({ name: 'Fixture DingTalk', enabled: true, clientId: 'fixture-client', clientSecret: secret })
      wechat.saveWeChatCredentials({ botToken: secret, ilinkBotId: 'fixture-bot', ilinkUserId: 'fixture-user', baseUrl: 'https://fixture.invalid' })
      voice.updateVoiceDictationSettings({ accessToken: secret, appId: 'fixture-app' })
      tools.updateToolCredentials('gpt-image', { provider: 'openai', apiKey: secret, mode: 'byok' })
      expect(feishu.getDecryptedBotAppSecret(feishuBot.id)).toBe(secret)
      expect(dingtalk.getDecryptedBotClientSecret(dingtalkBot.id)).toBe(secret)
      expect(wechat.getDecryptedCredentials()?.botToken).toBe(secret)
      expect(voice.getVoiceDictationSettings().accessToken).toBe(secret)
      expect(tools.getGptImageCredentials().apiKey).toBe(secret)
      for (const file of ['feishu.json', 'dingtalk.json', 'wechat.json', 'settings.json', 'chat-tools.json']) {
        const raw = readFileSync(join(configDir, file), 'utf8')
        expect(raw).not.toContain(secret)
        expect(raw).toContain(osEncrypted ? 'proferss1:' : 'proferv1:')
      }
    })
  }

  test('Given 加密失败 When 消费者保存 Then 全部拒绝写入明文', () => {
    identityFails = true
    const secret = 'fixture-consumer-secret'
    const actions = [
      () => feishu.saveFeishuBotConfig({ name: 'Fixture Feishu', enabled: true, appId: 'fixture-app', appSecret: secret }),
      () => dingtalk.saveDingTalkBotConfig({ name: 'Fixture DingTalk', enabled: true, clientId: 'fixture-client', clientSecret: secret }),
      () => wechat.saveWeChatCredentials({ botToken: secret, ilinkBotId: 'fixture-bot', ilinkUserId: 'fixture-user', baseUrl: 'https://fixture.invalid' }),
      () => voice.updateVoiceDictationSettings({ accessToken: secret }),
      () => tools.updateToolCredentials('gpt-image', { provider: 'openai', apiKey: secret }),
    ]
    for (const action of actions) expect(action).toThrow('加密令牌失败')
    for (const file of ['feishu.json', 'dingtalk.json', 'wechat.json', 'settings.json', 'chat-tools.json']) {
      expect(existsSync(join(configDir, file))).toBe(false)
    }
  })
})
