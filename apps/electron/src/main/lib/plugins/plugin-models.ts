import { supportsPluginModel } from './plugin-model-availability'
import { getAdapter, streamSSE } from '@profer/core'
import { resolveXaiCredentialMode } from '@profer/shared'
import { resolveEditionBearerToken } from '@profer/edition-contract'
import type { ProferPluginModel, ProferPluginGenerateResult } from '@profer/plugin-api'
import { listChannels, decryptApiKey } from '../channel-manager'
import { editionProviders } from '../edition'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { getFetchFn } from '../proxy-fetch'
import { generateSchema } from './plugin-capabilities'

export function listPluginModels(): ProferPluginModel[] {
  return listChannels().flatMap((channel) => channel.models.map((model) => ({
    channelId: channel.id, channelName: channel.name, modelId: model.id, name: model.name,
    provider: channel.provider, available: channel.enabled && model.enabled,
    supportsChat: supportsPluginModel(channel, 'chat'),
    supportsAgent: supportsPluginModel(channel, 'agent', 'pi') || supportsPluginModel(channel, 'agent', 'claude'),
  })))
}
export async function generatePluginModel(raw: unknown, signal: AbortSignal): Promise<ProferPluginGenerateResult> {
  const input = generateSchema.parse(raw)
  const channel = listChannels().find((candidate) => candidate.id === input.channelId && candidate.enabled)
  if (!channel?.models.some((model) => model.enabled && model.id === input.modelId)) throw new Error('所选模型已不可用')
  if (!supportsPluginModel(channel, 'chat')) throw new Error('此渠道仅支持 Agent；插件生成请选择 Chat 模型')
  const adapter = getAdapter(channel.provider, channel.apiProtocol, channel.baseUrl)
  let apiKey: string, baseUrl = channel.baseUrl, commercial = false
  if (editionProviders.credentials.shouldUseManagedRoute(channel)) {
    const auth = await editionProviders.account.getSession()
    if (!auth) throw new Error('请重新登录团队账号')
    apiKey = resolveEditionBearerToken(auth)
    const probe = adapter.buildStreamRequest({ baseUrl, apiKey: '', modelId: input.modelId, history: [], userMessage: '', readImageAttachments: () => [] })
    baseUrl = `${auth.baseUrl}${new URL(probe.url).pathname.endsWith('/messages') ? '/v1/proxy/messages' : '/v1/proxy/chat'}`
    commercial = true
  } else {
    apiKey = decryptApiKey(channel.id)
    if (channel.provider === 'xai' && resolveXaiCredentialMode(channel.credentialMode, apiKey) === 'oauth') throw new Error('xAI 订阅模型请通过 Pi Agent 使用')
  }
  signal.throwIfAborted()
  const req = adapter.buildStreamRequest({ baseUrl: channel.baseUrl, apiKey, modelId: input.modelId, history: [], userMessage: input.prompt, systemMessage: input.system, readImageAttachments: () => [] })
  if (commercial) { req.url = baseUrl; req.headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } }
  const body = JSON.parse(req.body) as Record<string, unknown>
  if (channel.provider === 'google') body.generationConfig = { ...(body.generationConfig as Record<string, unknown> ?? {}), maxOutputTokens: input.maxTokens }
  else if (new URL(req.url).pathname.endsWith('/responses')) body.max_output_tokens = input.maxTokens
  else if ('max_completion_tokens' in body) body.max_completion_tokens = input.maxTokens
  else body.max_tokens = input.maxTokens
  req.body = JSON.stringify(body)
  let text = ''
  try {
    await streamSSE({ request: req, adapter, signal, fetchFn: getFetchFn(await getEffectiveProxyUrl()), onEvent: (event) => {
      if (event.type === 'chunk') {
        text += event.delta
        if (text.length > 1_000_000) throw new Error('模型输出超过限制')
      }
    } })
  } catch {
    // 不把上游原始响应/请求配置返回插件，避免泄漏渠道凭据。
    throw new Error(signal.aborted ? '模型调用已取消或超时' : '模型调用失败，请检查模型可用性和额度')
  }
  return { text, channelId: channel.id, modelId: input.modelId }
}
