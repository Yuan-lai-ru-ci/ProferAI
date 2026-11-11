import { getGptImageCredentials, getToolCredentials } from './chat-tool-config'
import { editionProviders } from './edition'

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com'
const DEFAULT_XAI_BASE_URL = 'https://api.x.ai'

function normalizeBaseUrl(value: string, fallback: string): string {
  return (value.trim() || fallback).replace(/\/+$/, '').replace(/\/v1$/i, '')
}

export interface GptImageConnectionTestResult {
  success: boolean
  message: string
}

/**
 * 测试图片生成连接，不执行生图，避免测试动作产生图片或费用。
 * 官方模式检查 Profer 团队账号与官方模型健康接口；自带 Key 模式检查
 * 对应 provider 的 models 接口。
 */
export async function testGptImageConnection(): Promise<GptImageConnectionTestResult> {
  const credentials = getGptImageCredentials()

  if (credentials.mode === 'official') {
    const auth = await editionProviders.account.getSession()
    if (!auth) {
      return { success: false, message: '请先登录 Profer 团队账号' }
    }

    try {
      const response = await fetch(
        `${auth.baseUrl.replace(/\/+$/, '')}/v1/account/channels/health`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${auth.token}` },
          signal: AbortSignal.timeout(10000),
        },
      )
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          return { success: false, message: 'Profer 团队账号登录已失效，请重新登录' }
        }
        return { success: false, message: `官方生图服务检查失败 (${response.status})` }
      }
      return { success: true, message: '连接成功，Profer 官方生图服务可用' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, message: `官方生图服务连接失败: ${message}` }
    }
  }

  if (!credentials.apiKey) {
    return { success: false, message: `请先填写${credentials.provider === 'xai' ? ' xAI' : ' OpenAI'} API Key` }
  }

  try {
    const providerLabel = credentials.provider === 'xai' ? 'xAI Grok' : 'OpenAI'
    const baseUrl = normalizeBaseUrl(
      credentials.baseUrl,
      credentials.provider === 'xai' ? DEFAULT_XAI_BASE_URL : DEFAULT_OPENAI_BASE_URL,
    )
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, message: `${providerLabel} API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }
    }
    return { success: true, message: `连接成功，${providerLabel} Images API 可用` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message: `连接失败: ${message}` }
  }
}

/** 兼容历史 nano-banana 工具的旧式 API Key 连接测试。 */
export async function testLegacyImageToolConnection(toolId: string): Promise<GptImageConnectionTestResult> {
  const credentials = getToolCredentials(toolId)
  if (!credentials.apiKey) {
    return { success: false, message: '请先填写 OpenAI API Key' }
  }
  try {
    const baseUrl = normalizeBaseUrl(credentials.baseUrl ?? '', DEFAULT_OPENAI_BASE_URL)
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credentials.apiKey}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, message: `API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }
    }
    return { success: true, message: '连接成功，OpenAI API 可用' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, message: `连接失败: ${message}` }
  }
}
