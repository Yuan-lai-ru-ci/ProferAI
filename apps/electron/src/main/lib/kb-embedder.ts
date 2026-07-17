/**
 * 知识库 Embedding 服务
 *
 * 复用用户已有的 LLM 渠道调用 Embedding API（OpenAI-compatible），
 * 将文本转换为向量用于语义搜索。
 *
 * 支持的提供商：OpenAI、DeepSeek、豆包、智谱 等（所有有 /v1/embeddings 端点的渠道）
 */

import { getChannelById, decryptApiKey } from './channel-manager'
import { getFetchFn } from './proxy-fetch'
import type { Channel } from '@profer/shared'

/** 单次 Embedding API 最大输入 token 数（text-embedding-3-small 上限为 8191） */
const MAX_TOKENS_PER_REQUEST = 8000

/** 默认 Embedding 模型 */
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'

/** Embedding 向量维度 */
const EMBEDDING_DIMENSIONS = 1536

/**
 * 查找支持 Embedding 的渠道
 *
 * 优先返回 OpenAI-compatible 渠道（有 /v1/embeddings 端点）。
 * 返回渠道 ID，外部可用 getChannelById + decryptApiKey 获取完整信息。
 */
export function findEmbeddingChannel(): { channel: Channel; apiKey: string; baseUrl: string } | null {
  // 导入 listChannels 避免循环依赖
  const { listChannels } = require('./channel-manager')
  const channels: Channel[] = listChannels()

  // 优先级排序：openai > doubao > zhipu > deepseek > qwen > custom
  const priorityOrder = ['openai', 'doubao', 'zhipu', 'deepseek', 'qwen', 'custom']

  const sorted = [...channels].sort((a, b) => {
    const ai = priorityOrder.indexOf(a.provider)
    const bi = priorityOrder.indexOf(b.provider)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  for (const channel of sorted) {
    // 只选已启用的渠道
    if (!channel.enabled) continue

    try {
      const apiKey = decryptApiKey(channel.id)
      if (!apiKey) continue

      // 构建 embedding endpoint URL
      const baseUrl = (channel.baseUrl || '').replace(/\/+$/, '')
      return { channel, apiKey, baseUrl }
    } catch {
      continue
    }
  }

  return null
}

/**
 * 调用 Embedding API 将文本转为向量
 *
 * @param texts 待 embedding 的文本数组
 * @param channelInfo 渠道信息（从 findEmbeddingChannel 获取）
 * @returns 向量数组（与输入 texts 一一对应）
 */
export async function embedTexts(
  texts: string[],
  channelInfo: { channel: Channel; apiKey: string; baseUrl: string },
): Promise<number[][]> {
  const { apiKey, baseUrl } = channelInfo
  const fetchFn = getFetchFn()

  // 构建 OpenAI-compatible embedding 请求
  const embeddingUrl = `${baseUrl}/embeddings`
  const model = DEFAULT_EMBEDDING_MODEL

  const body = JSON.stringify({
    model,
    input: texts,
  })

  const resp = await fetchFn(embeddingUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    signal: AbortSignal.timeout(60_000),
  })

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => '')
    throw new Error(`Embedding API 调用失败 (${resp.status}): ${errorText.slice(0, 200)}`)
  }

  const result = (await resp.json()) as {
    data: Array<{ embedding: number[]; index: number }>
    model: string
    usage: { total_tokens: number }
  }

  if (!result.data || !Array.isArray(result.data)) {
    throw new Error(`Embedding API 返回格式异常: ${JSON.stringify(result).slice(0, 200)}`)
  }

  // 按 index 排序确保顺序
  const sorted = [...result.data].sort((a, b) => a.index - b.index)
  const embeddings = sorted.map((item) => item.embedding)

  console.log(`[KB Embedding] ${texts.length} 段文本 → ${embeddings.length} 个向量 (${result.usage?.total_tokens || '?'} tokens)`)
  return embeddings
}

/**
 * 计算两个向量之间的余弦相似度
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不匹配: ${a.length} vs ${b.length}`)
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dotProduct += ai * bi
    normA += ai * ai
    normB += bi * bi
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

export { EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL }
