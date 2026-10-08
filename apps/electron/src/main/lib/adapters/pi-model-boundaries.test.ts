import { describe, expect, test } from 'bun:test'
import { buildModel, buildCodexModel, getCodexCatalogModels, listCodexModels } from './pi-model-registry'

const base = { prompt: 'hi', permissionMode: 'plan' as const, systemPrompt: 'fixture', piAgentDir: '/tmp/fixture-pi', piSessionDir: '/tmp/fixture-pi-session', sessionId: 'fixture', apiKey: 'fixture-token' }
const sdk = {
  ModelRuntime: {
    create: async () => ({ setRuntimeApiKey: async () => {}, registerProvider: () => {}, getModel: () => undefined, getModels: () => [] }),
  },
} as unknown as Parameters<typeof buildModel>[0]

describe('F20：SDK 路由与 Codex 未知模型边界（mock runtime）', () => {
  test.each(['fixture-unknown-model', '', ' ', 'fixture-unknown-model[1m]'])('Codex 未知模型 %s 在两条入口均失败，不换首个模型', async (model) => {
    const catalog = await listCodexModels()
    for (const operation of [
      () => buildModel(sdk, { ...base, provider: 'openai-codex', model }),
      () => buildCodexModel(sdk, { model, codexOAuthCredentials: { access: 'fixture-token', refresh: 'fixture-refresh', expires: Date.now() + 100_000, accountId: 'fixture-account' } }),
    ]) {
      try { await operation(); throw new Error('未拒绝未知模型') }
      catch (error) {
        const message = (error as Error).message
        expect(message).toContain('重新读取 Codex 模型目录')
        expect(message).toContain(catalog[0]!.id)
        expect(message).not.toContain('fixture-token')
      }
    }
  })

  test('Codex 未指定模型才采用目录默认，显式 ID 保留目录补丁', async () => {
    const catalog = await getCodexCatalogModels()
    expect((await buildModel(sdk, { ...base, provider: 'openai-codex' })).model.id).toBe(catalog[0]!.id)
    expect((await buildModel(sdk, { ...base, provider: 'openai-codex', model: 'gpt-6-astra[1m]' })).model.id).toBe('gpt-6-astra')
  })

  test.each(['openai', 'openai-responses', 'anthropic-compatible', 'google', 'ollama', 'custom', 'deepseek', 'xai'] as const)('Pi %s 拒绝 query/hash，不静默删除路由', async (provider) => {
    for (const suffix of ['?route=secret-fixture', '#secret-fixture']) {
      await expect(buildModel(sdk, { ...base, provider, model: 'fixture', baseUrl: `https://fixture.invalid/v1${suffix}` })).rejects.toThrow('query/hash')
    }
  })
})
