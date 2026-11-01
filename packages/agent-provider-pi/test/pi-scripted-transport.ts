/**
 * 可控模型传输替身（真实 Pi SDK + 脚本化模型响应）。
 *
 * 不是 mock 掉 adapter：真实 pi-coding-agent 负责 Session、工具装配、事件流、
 * abort 与 dispose；这里只把 ModelRuntime.streamSimple 换成脚本，从而在
 * 无凭据、无网络、无付费调用的前提下驱动完整生命周期。
 */

import type { AssistantMessage, AssistantMessageEvent, JsonObject, Model, ToolCall, Usage } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

export interface ScriptedToolCall {
  id: string
  name: string
  arguments?: Record<string, unknown>
}

export interface ScriptedTurn {
  /** 文本增量，按数组顺序作为 text_delta 推出。 */
  textChunks?: string[]
  /** 本轮的工具调用（可选，触发真实工具执行与下一轮模型请求）。 */
  toolCall?: ScriptedToolCall
  /** 立即以 error 终止（模拟上游错误）。 */
  errorMessage?: string
  /** 挂起等待取消：只有收到 abort 才以 aborted 终止。 */
  pending?: boolean
}

export interface ScriptedTransport {
  /** 注入到真实 ModelRuntime 实例上的脚本化 streamSimple。 */
  streamSimple(model: Model<never>, context: unknown, options?: { signal?: AbortSignal }): unknown
  /** 已发起的模型请求数、消息数及测试用的 system/user 文本快照。 */
  calls: Array<{ turn: number; messageCount: number; systemPrompt?: string; userTexts: string[] }>
  /** 手动释放 pending 轮（取消场景的兜底，避免测试悬挂）。 */
  releasePending(): void
  /** 剩余未消费脚本轮次。 */
  remaining(): number
}

function buildUsage(): Usage {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function buildBaseMessage(model: { api: string; provider: string; id: string }, stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: buildUsage(),
    stopReason,
    timestamp: Date.now(),
  }
}

/**
 * 把脚本轮次转成 AssistantMessageEventStream。
 * 事件顺序遵循 Pi 协议：start → (text_start/text_delta/text_end | toolcall_*) → done | error。
 */
export function createScriptedTransport(turns: ScriptedTurn[]): ScriptedTransport {
  const queue = [...turns]
  const calls: ScriptedTransport['calls'] = []
  let releasePending: (() => void) | undefined

  const streamSimple: ScriptedTransport['streamSimple'] = (model, context, options) => {
    const stream = createAssistantMessageEventStream()
    const turnIndex = calls.length
    const contextMessages = (context as { messages?: Array<{ role?: string; content?: unknown }> } | undefined)?.messages
    const systemMessage = contextMessages?.find(message => message.role === 'system')
    calls.push({
      turn: turnIndex,
      messageCount: Array.isArray(contextMessages) ? contextMessages.length : 0,
      ...(typeof systemMessage?.content === 'string' ? { systemPrompt: systemMessage.content } : {}),
      userTexts: (contextMessages ?? [])
        .filter(message => message.role === 'user')
        .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)),
    })
    const turn = queue.shift()

    const emitText = (partial: AssistantMessage, chunks: string[]): void => {
      stream.push({ type: 'start', partial })
      stream.push({ type: 'text_start', contentIndex: 0, partial })
      partial.content = [{ type: 'text', text: '' }]
      for (const chunk of chunks) {
        const block = partial.content[0]
        if (block?.type === 'text') block.text += chunk
        stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk, partial })
      }
      const finalText = chunks.join('')
      stream.push({ type: 'text_end', contentIndex: 0, content: finalText, partial })
    }

    const settle = (): void => {
      const partial = buildBaseMessage(model as never, 'stop')
      if (!turn) {
        // 脚本耗尽：以空文本正常结束，避免测试因缺轮次而悬挂。
        emitText(partial, [])
        stream.push({ type: 'done', reason: 'stop', message: partial })
        stream.end()
        return
      }
      if (turn.pending) {
        const abort = new AbortController().signal
        const finish = (): void => {
          const aborted = buildBaseMessage(model as never, 'aborted')
          aborted.errorMessage = 'Request was aborted'
          stream.push({ type: 'error', reason: 'aborted', error: aborted })
          stream.end()
        }
        releasePending = finish
        options?.signal?.addEventListener('abort', finish, { once: true })
        // 未被取消时由场景显式 release；也支持 signal 传空时的兜底。
        if (abort.aborted) finish()
        return
      }
      if (turn.errorMessage) {
        const failed = buildBaseMessage(model as never, 'error')
        failed.errorMessage = turn.errorMessage
        stream.push({ type: 'error', reason: 'error', error: failed })
        stream.end()
        return
      }
      if (turn.toolCall) {
        const toolCall: ToolCall = {
          type: 'toolCall',
          id: turn.toolCall.id,
          name: turn.toolCall.name,
          arguments: (turn.toolCall.arguments ?? {}) as JsonObject,
        }
        stream.push({ type: 'start', partial })
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
        stream.push({ type: 'toolcall_delta', contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial })
        partial.content = [toolCall]
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial })
        const finalMessage = { ...partial, stopReason: 'toolUse' as const }
        stream.push({ type: 'done', reason: 'toolUse', message: finalMessage })
        stream.end()
        return
      }
      emitText(partial, turn.textChunks ?? [])
      stream.push({ type: 'done', reason: 'stop', message: partial })
      stream.end()
    }

    // 与真实 provider 一致：事件在微任务中推出，调用方先拿到 stream。
    void Promise.resolve().then(settle)
    return stream
  }

  return {
    streamSimple,
    calls,
    releasePending() {
      const release = releasePending
      releasePending = undefined
      release?.()
    },
    remaining() {
      return queue.length
    },
  }
}

/** 把脚本传输挂到真实 ModelRuntime 实例上（只替换模型响应，其他能力保持真实）。 */
export function patchModelRuntime(runtime: unknown, transport: ScriptedTransport): void {
  if (!runtime || typeof runtime !== 'object') throw new Error('ModelRuntime 缺失：无法注入脚本传输')
  const target = runtime as Record<string, unknown>
  target.streamSimple = transport.streamSimple
  target.stream = transport.streamSimple
}

export type { AssistantMessageEvent }
