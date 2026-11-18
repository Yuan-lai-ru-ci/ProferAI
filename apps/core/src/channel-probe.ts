import type { FetchModelsInput, FetchModelsResult, ProviderType } from '@profer/shared'
import { PROVIDER_CAPABILITIES } from '@profer/shared'
import { normalizeGoogleBaseUrl, resolveOpenAIModelsUrl, resolveAnthropicModelsUrl } from '../../../packages/core/src/providers/url-utils'

function endpoint(input: FetchModelsInput): string {
  const { provider, baseUrl } = input
  if (provider === 'ollama') return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/tags`
  if (provider === 'google') {
    const base = normalizeGoogleBaseUrl(baseUrl).replace(/\/+$/, '')
    return `${base}/v1beta/models?key=${encodeURIComponent(input.apiKey)}`
  }
  if (PROVIDER_CAPABILITIES[provider].isAnthropicProtocol) {
    const root = input.runtime === 'claude' || input.runtime === 'pi'
      ? (input.agentBaseUrl || baseUrl)
      : baseUrl
    return resolveAnthropicModelsUrl(root, provider, input.runtime === 'claude' || input.runtime === 'pi' ? 'sdk' : 'chat')
  }
  return resolveOpenAIModelsUrl(baseUrl)
}

function parseModels(provider: ProviderType, value: unknown): Array<{ id: string; name: string; enabled: boolean; source: 'fetched' }> {
  if (!value || typeof value !== 'object') throw new Error('供应商响应结构无效')
  const object = value as Record<string, unknown>
  if (provider === 'ollama') {
    if (!Array.isArray(object.models)) throw new Error('模型目录响应结构无效')
    return object.models.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string'
      ? [{ id: (item as Record<string, unknown>).name as string, name: (item as Record<string, unknown>).name as string, enabled: true, source: 'fetched' as const }]
      : [])
  }
  const items = provider === 'google' ? object.models : object.data
  if (!Array.isArray(items)) throw new Error('模型目录响应结构无效')
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name.replace(/^models\//, '') : undefined
    return id ? [{ id, name: typeof row.displayName === 'string' ? row.displayName : id, enabled: true, source: 'fetched' as const }] : []
  })
}

export async function discoverCoreModels(input: FetchModelsInput, signal?: AbortSignal): Promise<FetchModelsResult> {
  if (input.provider === 'openai-codex') {
    return { success: false, message: '远程 Core 暂不支持 OAuth 模型目录，请使用 API Key 渠道', models: [] }
  }
  try {
    const url = endpoint(input)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (input.provider === 'ollama') {
      if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`
    } else if (input.provider === 'google') {
      // Google API keys are supplied in the query string by its native API.
    } else if (PROVIDER_CAPABILITIES[input.provider].isAnthropicProtocol) {
      headers['x-api-key'] = input.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.Authorization = `Bearer ${input.apiKey}`
    }
    const response = await fetch(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
    if (!response.ok) return { success: false, message: `供应商返回 HTTP ${response.status}`, models: [] }
    const models = parseModels(input.provider, await response.json())
    return { success: true, message: `成功获取 ${models.length} 个模型`, models }
  } catch (error) {
    if (signal?.aborted) return { success: false, cancelled: true, message: '请求已取消', models: [] }
    return { success: false, message: '模型目录请求失败；请检查端点、凭据和供应商状态', models: [] }
  }
}

export async function testCoreChannel(input: FetchModelsInput, signal?: AbortSignal): Promise<{ success: boolean; message: string }> {
  const result = await discoverCoreModels(input, signal)
  return { success: result.success, message: result.success ? '模型目录连接成功' : result.message }
}
