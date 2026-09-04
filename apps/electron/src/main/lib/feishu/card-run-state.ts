import type {
  AgentStreamPayload,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@profer/shared'

/**
 * 飞书流式卡片的运行时状态机。
 *
 * 把 AgentStreamPayload（sdk_message + profer_event）累积成一个结构化的
 * RunState，便于渲染层无时序地把状态转成 CardKit 2.0 JSON。设计参考
 * zara/feishu-claude-code-bridge `src/card/run-state.ts`，但消费的是
 * Profer 的 SDKMessage 形态而非 claude CLI 的 stream-json。
 *
 * 所有 reducer 是纯函数：`reduce(state, payload) → state`。
 */

export type ToolStatus = 'running' | 'done' | 'error'

export interface ToolEntry {
  id: string
  name: string
  input: unknown
  status: ToolStatus
  output?: string
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean; sourceId?: string }
  | { kind: 'tool'; tool: ToolEntry; sourceId?: string }

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null

export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout'

export interface RunState {
  blocks: Block[]
  reasoning: { content: string; active: boolean }
  footer: FooterStatus
  terminal: Terminal
  errorMsg?: string
  /** idle_timeout 终态下，无响应的分钟数（卡片渲染时拼"N 分钟无响应"）。 */
  idleTimeoutMinutes?: number
  startedAt: number
  /**
   * Pi 的 partial assistant 消息是“累计快照”而不是 delta；按 uuid 保存其来源，
   * 让后续快照替换旧块而不是重复追加。Claude 消息没有该字段时仍走增量兼容路径。
   */
  assistantSourceOrder?: string[]
  /** source uuid → 当前快照中的 thinking 文本。 */
  assistantThinking?: Record<string, string>
  /** result 消息携带的元数据，渲染卡片底部 summary 用。 */
  meta: {
    durationMs?: number
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
    model?: string
  }
}

export function createInitialState(): RunState {
  return {
    blocks: [],
    reasoning: { content: '', active: false },
    footer: 'thinking',
    terminal: 'running',
    startedAt: Date.now(),
    assistantSourceOrder: [],
    assistantThinking: {},
    meta: {},
  }
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b,
  )
}

function appendText(state: RunState, delta: string, sourceId?: string): RunState {
  const last = state.blocks[state.blocks.length - 1]
  if (last && last.kind === 'text' && last.streaming && last.sourceId === sourceId) {
    const next: Block = { ...last, content: last.content + delta }
    return {
      ...state,
      blocks: [...state.blocks.slice(0, -1), next],
      reasoning: { ...state.reasoning, active: false },
      footer: 'streaming',
    }
  }
  return {
    ...state,
    blocks: [...state.blocks, { kind: 'text', content: delta, streaming: true, ...(sourceId ? { sourceId } : {}) }],
    reasoning: { ...state.reasoning, active: false },
    footer: 'streaming',
  }
}

function appendThinking(state: RunState, delta: string): RunState {
  return {
    ...state,
    reasoning: { content: state.reasoning.content + delta, active: true },
    footer: 'thinking',
  }
}

function startTool(state: RunState, id: string, name: string, input: unknown, sourceId?: string): RunState {
  const tool: ToolEntry = { id, name, input, status: 'running' }
  return {
    ...state,
    blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool, ...(sourceId ? { sourceId } : {}) }],
    reasoning: { ...state.reasoning, active: false },
    footer: 'tool_running',
  }
}

function completeTool(state: RunState, id: string, output: string, isError: boolean): RunState {
  const blocks = state.blocks.map((b) => {
    if (b.kind !== 'tool' || b.tool.id !== id) return b
    return {
      ...b,
      tool: { ...b.tool, status: isError ? ('error' as const) : ('done' as const), output },
    }
  })
  return { ...state, blocks }
}

function replaceAssistantSnapshot(state: RunState, sourceId: string, blocks: Block[], thinking: string): RunState {
  const oldIndexes = state.blocks
    .map((block, index) => block.sourceId === sourceId ? index : -1)
    .filter((index) => index >= 0)
  const insertAt = oldIndexes[0] ?? state.blocks.length
  const oldIndexSet = new Set(oldIndexes)
  const remaining = state.blocks.filter((_block, index) => !oldIndexSet.has(index))
  const before = remaining.slice(0, Math.min(insertAt, remaining.length))
  const after = remaining.slice(Math.min(insertAt, remaining.length))
  const assistantSourceOrder = state.assistantSourceOrder?.includes(sourceId)
    ? state.assistantSourceOrder
    : [...(state.assistantSourceOrder ?? []), sourceId]
  const assistantThinking = { ...(state.assistantThinking ?? {}), [sourceId]: thinking }
  return {
    ...state,
    blocks: [...before, ...blocks, ...after],
    assistantSourceOrder,
    assistantThinking,
    reasoning: {
      content: assistantSourceOrder.map((id) => assistantThinking[id] ?? '').join(''),
      active: thinking.length > 0,
    },
    footer: blocks.some((block) => block.kind === 'tool') ? 'tool_running' : 'streaming',
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: string }).text === 'string') {
          return (c as { text: string }).text
        }
        try {
          return JSON.stringify(c)
        } catch {
          return String(c)
        }
      })
      .join('\n')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

export function reduce(state: RunState, payload: AgentStreamPayload): RunState {
  if (payload.kind === 'sdk_message') {
    const msg = payload.message

    if (msg.type === 'assistant') {
      const am = msg as SDKAssistantMessage
      let next = state
      if (am.message?.model && !next.meta.model) {
        next = { ...next, meta: { ...next.meta, model: am.message.model } }
      }
      // assistant 消息上若携带顶层 error 字段，直接转为 error 终态
      // （SDK 偶尔会在 assistant 帧带 error，不走 result 路径）
      if (am.error?.message) {
        return markError(state, am.error.message)
      }

      const rawAssistant = am as unknown as Record<string, unknown>
      const sourceId = typeof am.uuid === 'string' && am.uuid.length > 0 ? am.uuid : undefined
      const isPartialSnapshot = rawAssistant._partial === true
      // Pi 的 partial assistant 帧携带累计全文，final 帧通常复用同一个 uuid。
      // 这类消息必须按快照替换；否则每次更新都会把已有前缀再次拼进卡片。
      if (sourceId && (isPartialSnapshot || state.blocks.some((block) => block.sourceId === sourceId))) {
        const snapshotBlocks: Block[] = []
        let thinking = ''
        for (const block of am.message?.content ?? []) {
          if (block.type === 'text') {
            const text = (block as { text?: unknown }).text
            if (typeof text === 'string' && text) {
              const last = snapshotBlocks[snapshotBlocks.length - 1]
              if (last?.kind === 'text') {
                snapshotBlocks[snapshotBlocks.length - 1] = { ...last, content: last.content + text }
              } else {
                snapshotBlocks.push({ kind: 'text', content: text, streaming: true, sourceId })
              }
            }
          } else if (block.type === 'thinking') {
            const value = (block as { thinking?: unknown }).thinking
            if (typeof value === 'string') thinking += value
          } else if (block.type === 'tool_use') {
            const tb = block as { id?: unknown; name?: unknown; input?: unknown }
            if (typeof tb.id === 'string' && typeof tb.name === 'string') {
              snapshotBlocks.push({
                kind: 'tool',
                tool: { id: tb.id, name: tb.name, input: tb.input, status: 'running' },
                sourceId,
              })
            }
          }
        }
        return replaceAssistantSnapshot(next, sourceId, snapshotBlocks, thinking)
      }

      for (const block of am.message?.content ?? []) {
        if (block.type === 'text') {
          const text = (block as { text?: unknown }).text
          if (typeof text === 'string' && text) next = appendText(next, text, sourceId)
        } else if (block.type === 'thinking') {
          const thinking = (block as { thinking?: unknown }).thinking
          if (typeof thinking === 'string' && thinking) next = appendThinking(next, thinking)
        } else if (block.type === 'tool_use') {
          const tb = block as { id?: unknown; name?: unknown; input?: unknown }
          if (typeof tb.id === 'string' && typeof tb.name === 'string') {
            next = startTool(next, tb.id, tb.name, tb.input, sourceId)
          }
        }
      }
      return next
    }

    if (msg.type === 'user') {
      const um = msg as SDKUserMessage
      let next = state
      for (const block of um.message?.content ?? []) {
        if (block.type === 'tool_result') {
          const trb = block as { tool_use_id?: unknown; content?: unknown; is_error?: unknown }
          if (typeof trb.tool_use_id === 'string') {
            const output = stringifyToolResult(trb.content)
            next = completeTool(next, trb.tool_use_id, output, trb.is_error === true)
          }
        }
      }
      return next
    }

    if (msg.type === 'result') {
      const rm = msg as SDKResultMessage
      const meta = {
        ...state.meta,
        durationMs: Date.now() - state.startedAt,
        inputTokens: rm.usage?.input_tokens,
        outputTokens: rm.usage?.output_tokens,
        costUsd: rm.total_cost_usd,
      }
      // result.subtype 以 'error' 开头视为错误（含 error / error_max_turns /
      // error_max_budget_usd / error_during_execution）
      const isError = typeof rm.subtype === 'string' && rm.subtype.startsWith('error')
      if (isError) {
        const errMsg = rm.errors?.[0] ?? rm.subtype ?? 'Agent 运行出错'
        return {
          ...state,
          blocks: closeStreamingText(state.blocks),
          reasoning: { ...state.reasoning, active: false },
          terminal: 'error',
          footer: null,
          errorMsg: errMsg,
          meta,
        }
      }
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: 'done',
        footer: null,
        meta,
      }
    }

    return state
  }

  if (payload.kind === 'profer_event') {
    const evt = payload.event
    if (evt.type === 'model_resolved') {
      return { ...state, meta: { ...state.meta, model: evt.model } }
    }
    return state
  }

  return state
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  }
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  }
}

export function markError(state: RunState, message: string): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'error',
    footer: null,
    errorMsg: message,
  }
}

/** 当外部确认 run 已结束但 state 仍是 running 时，兜底收尾。 */
export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  }
}
