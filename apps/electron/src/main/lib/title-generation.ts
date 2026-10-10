/**
 * 会话标题生成：提示词、清洗、信息量判定与首条有效来源定稿策略的唯一定义处。
 *
 * Chat（chat-service）与 Agent（agent-orchestrator）两条链路都从这里取用，
 * 避免此前在三处各写一份、且内联正则被编码往返损坏的问题。
 *
 * 命名策略（2026-10 起）：标题在首条「有信息量」用户消息后立即生成并定稿，避免等待后续轮次或因失败次数耗尽而长期保留默认名。
 * 只由该窗口写出的标题会被标记为自动生成；用户手动改名一律视为人工决定，永不覆盖。
 */
import { stripScheduledRunMarker } from '@profer/session-core'

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

// ===== 自动命名策略 =====

/**
 * 兼容旧会话元数据的最大尝试次数。新会话在首条有效来源后直接定稿。
 */
export const TITLE_REFINE_MAX_ATTEMPTS = 3

/** 首条有信息量的用户消息即可完成自动命名。 */
export const TITLE_LOCK_MIN_SOURCES = 1

/** 参与命名的来源消息条数上限（只取最早的若干条，避免长会话把窗口拖长）。 */
export const TITLE_SOURCE_MAX_COUNT = 4

/** 单条来源消息进入提示词的字符上限。 */
export const TITLE_SOURCE_MAX_CHARS = 400

/** 有效来源的最短长度（去掉空白与标点后）；低于此长度不构成任何主题。 */
const MIN_INFORMATIVE_LENGTH = 3

/**
 * 前几轮窗口的命名 Prompt。
 *
 * 与单条消息的 TITLE_PROMPT 的关键差别是显式禁止「照抄某一条消息的原文」：
 * 历史数据里大量标题就是首条消息的截断（如 `ok，现在继续转战未来规划类，我学空间专`），
 * 多轮输入必须让模型概括主题，而不是复制粘贴。
 */
const WINDOW_TITLE_PROMPT = '根据用户在会话最初几轮的消息，生成一个简短的对话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。标题要概括用户真正想做的事（主题、任务或产物），不要照抄某一条消息的原文，也不要使用「用户」「对话」「会话」这类空泛词。如果这些消息都没有明确主题，直接使用其中最具体的一条原文作为标题。'

/**
 * 注入到用户消息里的上下文块。
 *
 * 这些块是 Profer 自己拼上去的（附件清单、引用片段、探索分支增量说明等），
 * 不属于用户意图；命名前必须剥离，否则会把注入内容当主题。
 */
const INJECTED_BLOCK = /<(graph_focus|skill_routing|skill|attached_files|quoted_file|exploration_delta|mentioned_tools|session_recovery|knowledge_context|user_browser_context|attached_directories|workspace_state|working_directory)[^>]*>[\s\S]*?<\/\1>/gi

/** 剥离注入块后可能残留的孤立标签。 */
const INJECTED_TAG = /<\/?(?:graph_focus|skill_routing|skill|attached_files|quoted_file|exploration_delta|mentioned_tools|session_recovery|knowledge_context|user_browser_context|attached_directories|workspace_state|working_directory|scheduled_run)[^>]*>/gi

/** Profer 动态上下文中的时间行不是用户意图。 */
const INJECTED_TIME_LINE = /^\*\*当前时间:[^\n]*\*\*\s*$/gim

/**
 * 纯斜杠命令前缀：整条消息只有 `/命令`，或 `/命令 载荷`。
 *
 * 只认「命令词后紧跟空白或结尾」的形态，所以 `/Users/mac/x`、`/tmp/foo` 这类路径
 * 不会被误判成命令（它们含 `/` 或大写字母，不满足 `[a-z][a-z0-9-]*` 加边界的组合）。
 */
const SLASH_COMMAND_PREFIX = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/

/**
 * 无语义内容的词元：整条消息只由这些词拼成时，等于「继续 / 确认 / 收尾」，不构成主题。
 *
 * 例如 `提交吧`、`好的谢谢`、`帮我看一下`、`测试一下` 都会被判为无信息量。
 * 判定采用最长匹配逐段消费，只要有一段消费不掉就认为消息有内容。
 */
const EMPTY_INTENT_TOKENS = [
  // 礼节 / 招呼 / 致谢
  'hi', 'hello', 'hey', 'yo', 'morning', 'thanks', 'thankyou', 'thx', '3q', 'sorry', 'yes', 'no',
  '你好', '您好', '哈喽', '嗨', '早', '早上好', '下午好', '晚上好', '晚安', '在吗', '在么', '在不在',
  '谢谢', '多谢', '感谢', '辛苦', '辛苦了', '麻烦', '麻烦了', '抱歉', '对不起',
  // 确认 / 称赞
  'ok', 'okay', 'okk', 'k', '好', '好的', '好吧', '好滴', '嗯', '嗯嗯', '对', '对的', '是', '是的',
  '收到', '了解', '懂了', '明白', '可以', '行', '可以了', '没问题', '不错', '厉害', '牛', '赞', '棒',
  // 催促 / 继续
  '继续', '接着', '开始', '来吧', '走', '冲', '干', 'go', 'start', 'continue', 'next', '然后', '下一步',
  '等等', '等一下', '稍等', '停', '别', '不', '不用',
  // 无宾语的动词（说了等于没说）
  '提交', '推送', '打包', '发', '跑', '重试', '再试', '试', '试试', '测试', '测', '修复',
  '看', '看看', '查', '查一下', '改', '改一下', '优化',
  // 结构词 / 语气词 / 代词（只在拼接里有意义，单独出现无信息）
  '的', '了', '吧', '啊', '呀', '哈', '哦', '噢', '喔', '呢', '嘛', '呗', '下', '一下', '一', '个', '这', '那',
  '我', '你', '帮', '请', '给', '把', '和', '与', '再', '还', '就', '都', '要', '想', '能',
]

/** 归一化文本，只保留字母、数字与中日文字符，用于「是否只是寒暄/命令」判定。 */
function normalizeIntentText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff]/g, '')
}

/** 整条消息是否只由寒暄/确认/催促词元拼成。 */
function isPureAcknowledgement(normalized: string): boolean {
  if (!normalized) return true
  let index = 0
  while (index < normalized.length) {
    let matched = ''
    for (const token of EMPTY_INTENT_TOKENS) {
      if (token.length > matched.length && normalized.startsWith(token, index)) matched = token
    }
    if (!matched) return false
    index += matched.length
  }
  return true
}

/** 剥离注入上下文块与调度标记。 */
function stripInjectedContext(raw: string): string {
  return stripScheduledRunMarker(raw)
    .replace(INJECTED_BLOCK, '')
    .replace(INJECTED_TAG, '')
    .replace(INJECTED_TIME_LINE, '')
}

/** 单条候选消息的信息量判定结果。 */
export interface TitleSourceEvaluation {
  /** 剥离注入块与纯命令后的有效文本；不可用时为空串。 */
  text: string
  /** 是否具备命名价值。 */
  informative: boolean
}

/**
 * 判定一条用户消息是否值得作为命名依据。
 *
 * 过滤三类历史脏数据来源：Profer 自己注入的上下文块、纯斜杠命令（`/compact`）、
 * 以及没有任何主题的寒暄/确认/催促（`hi`、`提交吧`、`帮我看一下`）。
 */
export function evaluateTitleSource(raw: string): TitleSourceEvaluation {
  const stripped = stripInjectedContext(raw).trim()
  if (!stripped) return { text: '', informative: false }

  const command = SLASH_COMMAND_PREFIX.exec(stripped)
  const body = (command ? command[2] ?? '' : stripped).trim()
  if (!body) return { text: '', informative: false }

  const normalized = normalizeIntentText(body)
  if (normalized.length < MIN_INFORMATIVE_LENGTH) return { text: body, informative: false }
  if (isPureAcknowledgement(normalized)) return { text: body, informative: false }
  return { text: body, informative: true }
}

/**
 * 把候选用户消息收敛为可用于命名的来源列表：剥离注入、跳过命令与寒暄、去重、限长限条数。
 *
 * 顺序即会话顺序——只取最早的 TITLE_SOURCE_MAX_COUNT 条，避免长会话把窗口越拖越长。
 */
export function collectTitleSources(messages: string[]): string[] {
  const seen = new Set<string>()
  const sources: string[] = []
  for (const message of messages) {
    const { text, informative } = evaluateTitleSource(message)
    if (!informative) continue
    const key = normalizeIntentText(text)
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(text.length > TITLE_SOURCE_MAX_CHARS ? text.slice(0, TITLE_SOURCE_MAX_CHARS) : text)
    if (sources.length >= TITLE_SOURCE_MAX_COUNT) break
  }
  return sources
}

/** 构建「前几轮」窗口的命名 prompt（来源已由 collectTitleSources 过滤）。 */
export function buildWindowTitlePrompt(sources: string[]): string {
  const list = sources.map((source, index) => `${index + 1}. ${source}`).join('\n')
  return `${WINDOW_TITLE_PROMPT}\n\n用户消息：\n${list}`
}

/** 窗口路径的本地兜底：取最早一条有效来源的首行。 */
export function createWindowFallbackTitle(sources: string[]): string | null {
  for (const source of sources) {
    const title = createFallbackTitle(source)
    if (title) return title
  }
  return null
}

/** 应用本轮标题后是否应当定稿。 */
export function shouldLockTitle(sourceCount: number): boolean {
  return sourceCount >= TITLE_LOCK_MIN_SOURCES
}

/** 命名窗口在当前轮应当做什么。 */
export type TitleWindowDecision =
  /** 自动流程永久退出，并应把 titleLockedAt 写回数据。 */
  | { action: 'lock'; reason: 'human-named' | 'attempts-exhausted' }
  /** 本轮不动标题，也不写盘。 */
  | { action: 'skip'; reason: 'locked' | 'no-source' }
  /** 应当发起命名；attempts 是写回数据的新尝试次数，lockAfterApply 表示应用标题后当即定稿。 */
  | { action: 'generate'; attempts: number; lockAfterApply: boolean }

/** 命名窗口状态机入参。 */
export interface TitleWindowInput {
  /** 当前标题 */
  title: string
  /** 该链路的默认标题（Agent 为「新 Agent 会话」，Chat 为「新对话」） */
  defaultTitle: string
  /** 是否由本机制写过标题 */
  titleAutoGeneratedAt?: number
  /** 已发起的模型调用次数 */
  titleRefineAttempts?: number
  /** 已定稿锁定 */
  titleLockedAt?: number
  /** 本轮收集到的有效来源条数 */
  sourceCount: number
  /**
   * 允许在「非默认且非自动生成」的标题上命名。
   *
   * 仅 Pi 探索/分叉分支首次命名使用（它继承的是「父标题 (fork)」，必须有自己的名字）。
   */
  allowNonDefaultTitle?: boolean
}

/**
 * 自动命名窗口的状态机。Chat 与 Agent 两条链路共用，避免规则漂移。
 *
 * 优先级：已定稿 → 人工命名 → 次数用尽 → 无有效来源 → 生成。
 * 「人工命名」与「次数用尽」都返回 lock，调用方需把 titleLockedAt 写回数据，
 * 以免后续轮次反复读转录做无意义判定。
 */
export function planTitleWindow(input: TitleWindowInput): TitleWindowDecision {
  if (input.titleLockedAt) return { action: 'skip', reason: 'locked' }

  const isDefaultTitle = input.title === input.defaultTitle
  const autoNamedBefore = typeof input.titleAutoGeneratedAt === 'number'
  if (!isDefaultTitle && !autoNamedBefore && !input.allowNonDefaultTitle) {
    return { action: 'lock', reason: 'human-named' }
  }

  const attempts = input.titleRefineAttempts ?? 0
  // 旧会话可能记录了失败尝试，但默认标题仍必须允许首次成功命名。
  if (attempts >= TITLE_REFINE_MAX_ATTEMPTS && !isDefaultTitle) return { action: 'lock', reason: 'attempts-exhausted' }

  // 无有效来源（纯寒暄/命令）不消耗调用次数，也不关窗，等下一个有内容的轮次。
  if (input.sourceCount <= 0) return { action: 'skip', reason: 'no-source' }

  return {
    action: 'generate',
    attempts: Math.min(attempts + 1, TITLE_REFINE_MAX_ATTEMPTS),
    lockAfterApply: true,
  }
}

/**
 * 合并标题窗口的尝试次数，保证并发请求完成顺序不同也不会把已预占次数回退。
 *
 * Chat/Agent 在发起异步模型请求前会先同步预占 attempts；较早发起的请求可能较晚失败，
 * 因此所有后续回写都必须保留当前元数据中的较大值。
 */
export function mergeTitleRefineAttempts(current: number | undefined, candidate: number): number {
  return Math.max(current ?? 0, candidate)
}

/**
 * 元数据层面的便宜预判。
 *
 * 只看标题状态（是否已定稿、是否人工命名、次数是否用尽）就能断定「不该命名」时返回结论；
 * 需要读会话来源才能决定时返回 null。调用方先跑它，可以避免已定稿会话每轮白读一次转录。
 */
export function preflightTitleWindow(
  input: Omit<TitleWindowInput, 'sourceCount'>,
): Exclude<TitleWindowDecision, { action: 'generate' }> | null {
  const decision = planTitleWindow({ ...input, sourceCount: 1 })
  return decision.action === 'generate' ? null : decision
}
