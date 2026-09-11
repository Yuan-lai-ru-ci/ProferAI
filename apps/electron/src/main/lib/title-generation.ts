/**
 * 会话标题生成：提示词、清洗与兜底策略的唯一定义处。
 *
 * Chat（chat-service）与 Agent（agent-orchestrator）两条链路都从这里取用，
 * 避免此前在三处各写一份、且内联正则被编码往返损坏的问题。
 */

/** 标题最大长度（字符） */
export const MAX_TITLE_LENGTH = 20

/** 短消息阈值：不高于此长度时直接使用原文作为标题（仅 Chat 链路使用） */
export const SHORT_MESSAGE_THRESHOLD = 4

/**
 * Chat 与 Agent 共用的唯一标题生成 Prompt。
 *
 * “消息过短或无明确主题时回退原文”来自历史上的真实幻觉修复：Chat 仍会对
 * ≤SHORT_MESSAGE_THRESHOLD 的输入本地短路，Agent 则由模型按同一指令处理。
 */
const TITLE_PROMPT = '根据用户的第一条消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。如果消息内容过短或无明确主题，直接使用原始消息作为标题。'

/** 构建标题生成 prompt（已拼接用户消息）。 */
export function buildTitlePrompt(userMessage: string): string {
  return `${TITLE_PROMPT}\n\n用户消息：${userMessage}`
}

/**
 * 首尾成对的引号/书名号。
 *
 * 必须保留中文弯引号与书名号：内联副本曾在编码往返中把 `“”‘’` 退化成重复的直引号，
 * 导致 `“标题”`、`「标题」` 无法被剥离。
 */
const TITLE_PUNCTUATION = /^["'“”‘’「《]+|["'“”‘’」》]+$/g
const MARKDOWN_PREFIX = /^(?:[#>*\-\d.)]\s*)+/
const WHITESPACE = /\s+/g

/**
 * 从模型返回的原始标题内容中提取文本。
 *
 * OpenAI 兼容端点（如 OpenCode Go）对推理模型可能把 `message.content` 返回为
 * 字符串、内容块数组（`[{ type: 'text', text: '...' }]`）或空值。逐个归一为
 * 纯文本，避免 `.trim()` 在非字符串上抛异常，导致整个标题生成在 catch 里静默丢弃。
 */
function extractVisibleTextBlock(block: unknown, allowUntyped: boolean): string {
  if (!block || typeof block !== 'object') return ''
  const { type, text } = block as { type?: unknown; text?: unknown }
  if (typeof text !== 'string') return ''

  // 明确标记为 thinking/reasoning/tool 等类型的块不能进入标题。
  if (type === 'text') return text
  return allowUntyped && type == null ? text : ''
}

function extractTitleText(title: unknown): string {
  if (typeof title === 'string') return title
  if (Array.isArray(title)) {
    // 只要响应里有显式 text 块，就把它视为权威可见文本；仅在完全没有显式
    // text 块时，才兼容部分 OpenAI 端点省略 type 的 `{ text }` 形态。
    const hasExplicitTextBlock = title.some((block) =>
      !!block
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string',
    )
    return title
      .map((block) => extractVisibleTextBlock(block, !hasExplicitTextBlock))
      .join('')
      .trim()
  }
  return extractVisibleTextBlock(title, true)
}

/** 清理模型返回的标题。兼容字符串与内容块数组，非文本内容返回 null。 */
export function sanitizeGeneratedTitle(title: string | unknown): string | null {
  const text = extractTitleText(title)
  const cleaned = text.trim().replace(TITLE_PUNCTUATION, '').trim()
  return cleaned.slice(0, MAX_TITLE_LENGTH) || null
}

/**
 * 无法调用标题模型时，基于首条用户消息生成一个稳定兜底标题。
 *
 * ChatGPT (Codex) OAuth 使用 Pi SDK 的 Codex Responses 协议，不适配当前
 * @profer/core 的 Chat Completions / Messages 标题请求，因此需要本地兜底，
 * 避免会话长期停留在“新 Agent 会话”。
 */
export function createFallbackTitle(userMessage: string): string | null {
  const firstLine = userMessage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?? userMessage.trim()

  const cleaned = firstLine
    .replace(MARKDOWN_PREFIX, '')
    .replace(WHITESPACE, ' ')
    .trim()

  return cleaned.slice(0, MAX_TITLE_LENGTH) || null
}
