import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCodexCredentials, serializeCodexCredentials, type Channel, type CodexOAuthCredentials } from '@profer/shared'

const root = mkdtempSync(join(tmpdir(), 'profer-runtime-codex-fixture-'))
const configPath = join(root, 'channels.json')
const old: CodexOAuthCredentials = { access: 'fixture-old-access', refresh: 'fixture-old-refresh', expires: 1, accountId: 'fixture-account' }
const fresh: CodexOAuthCredentials = { access: 'fixture-new-access', refresh: 'fixture-new-refresh', expires: Date.now() + 3_600_000 }
let releaseRefresh: (() => void) | undefined
let rejectRefresh = false
const refresh = mock(async (_refreshToken: string): Promise<CodexOAuthCredentials> => {
  if (rejectRefresh) throw new Error('fixture refresh rejected')
  await new Promise<void>((resolve) => { releaseRefresh = resolve })
  return { ...fresh }
})

mock.module('./config-paths', () => ({ getChannelsPath: () => configPath }))
mock.module('./token-crypto', () => ({
  encryptToken: (token: string) => `fixture:${token}`,
  decryptToken: (token: string) => token.replace(/^fixture:/, ''),
}))
mock.module('./auth-service', () => ({
  getCommercialMode: () => false, isSelfConfigAllowed: () => true,
  getTeamAuth: () => null, getTeamAuthWithRefresh: async () => null,
}))
mock.module('./build-target', () => ({ isCommercialBuild: () => false }))
mock.module('./proxy-settings-service', () => ({ getEffectiveProxyUrl: async () => undefined }))
mock.module('./proxy-fetch', () => ({ getFetchFn: () => () => { throw new Error('fixture forbids network') } }))
mock.module('./codex-oauth-service', () => ({
  refreshCodexOAuth: refresh,
  loginCodexOAuth: async () => { throw new Error('fixture forbids login') },
}))
mock.module('./xai-oauth-service', () => ({
  refreshXaiOAuth: async () => { throw new Error('fixture forbids xAI OAuth') },
  loginXaiOAuth: async () => { throw new Error('fixture forbids xAI login') },
}))
const { buildPiRuntimeCredentialOptions, resolveRuntimeCredentials } = await import('./agent-runtime-credentials')
const { getChannelById } = await import('./channel-manager')

function seed(credentials: CodexOAuthCredentials = old): Channel {
  const channel: Channel = {
    id: 'fixture-codex', name: 'Fixture Codex', provider: 'openai-codex',
    baseUrl: '', apiKey: `fixture:${serializeCodexCredentials(credentials)}`, agentRuntimes: ['pi'],
    models: [{ id: 'gpt-5.6-terra', name: 'Fixture', enabled: true }],
    enabled: true, createdAt: 1, updatedAt: 1,
  }
  writeFileSync(configPath, JSON.stringify({ version: 1, channels: [channel] }))
  return channel
}

function savedCredentials(): CodexOAuthCredentials | null {
  const saved = getChannelById('fixture-codex')
  return parseCodexCredentials(saved?.apiKey.replace(/^fixture:/, '') ?? '')
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('普通 Agent 沿用 Codex resolver 的旧凭据刷新', () => {
  test('Given 同渠道过期 OAuth When 并发两轮解析 Then 只刷新一次并保留 accountId', async () => {
    const value = seed()
    const first = resolveRuntimeCredentials(value, 'pi')
    const second = resolveRuntimeCredentials(value, 'pi')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(old.refresh)
    releaseRefresh?.()
    const results = await Promise.all([first, second])
    for (const result of results) {
      expect(result).toMatchObject({
        ok: true, credentials: { apiKey: fresh.access, codexOAuthCredentials: { ...fresh, accountId: old.accountId } },
      })
    }
    expect(savedCredentials()).toEqual({ ...fresh, accountId: old.accountId })
    await resolveRuntimeCredentials(value, 'pi')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  test('Given 长轮次刷新回调未携带 accountId When 原回调回写 Then 沿用现存账户归属', async () => {
    seed({ ...fresh, accountId: old.accountId })
    const resolved = await resolveRuntimeCredentials(getChannelById('fixture-codex')!, 'pi')
    if (!resolved.ok) throw new Error('fixture resolve failed')
    const options = buildPiRuntimeCredentialOptions('fixture-codex', resolved.credentials)
    const next = { ...fresh, access: 'fixture-long-turn-access', expires: fresh.expires + 3_600_000 }
    await options.onCodexOAuthCredentialsRefreshed?.(next)
    expect(savedCredentials()).toEqual({ ...next, accountId: old.accountId })
  })

  test('Given 刷新失败 When 普通轮次解析 Then 不覆盖旧凭据且下次可重试', async () => {
    const value = seed()
    const before = savedCredentials()
    rejectRefresh = true
    expect(await resolveRuntimeCredentials(value, 'pi')).toEqual({ ok: false, code: 'api_key_decrypt_failed' })
    expect(savedCredentials()).toEqual(before)
    rejectRefresh = false
    const retry = resolveRuntimeCredentials(value, 'pi')
    releaseRefresh?.()
    expect(await retry).toMatchObject({ ok: true, credentials: { apiKey: fresh.access } })
    expect(savedCredentials()).toEqual({ ...fresh, accountId: old.accountId })
  })
})
