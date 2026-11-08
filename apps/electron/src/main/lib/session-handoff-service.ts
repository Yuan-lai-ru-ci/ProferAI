/**
 * 会话交接服务
 *
 * 把「继续聊下去会越来越糟的会话」换成「一个拿着交接文档重新开始的会话」。
 * 与 80% 上下文自动压缩是互补关系：压缩让当前会话能继续跑，交接让下一个会话
 * 从干净上下文接手，且交接内容是**任务导向**的（做了什么、否决了什么、下一步），
 * 而不是转录摘要。
 *
 * 两个刻意的设计决定：
 *
 * 1. **不让模型写文件，只让它输出文档正文**。写文件会踩两件事：目标路径在会话
 *    cwd 之外（写入授权不覆盖），以及低权限模式下弹审批把整个流程挂住。改成
 *    「模型输出 Markdown → 主进程落盘」后，权限、路径、编码全部由宿主掌握，
 *    校验也变成「能不能从转录里取到一段足够长的助手回复」。
 * 2. **失败一定有兜底**。模型超时、报错、输出太短时，用 `@profer/session-core`
 *    的确定性转录渲染兜底，功能不会走进死路——只是文档质量降级。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  groupIntoTurns,
  renderTranscriptMarkdown,
  selectTurns,
  toTranscript,
  type TranscriptTurn,
} from '@profer/session-core'
import { normalizeAgentRuntime, type AgentSessionHandoffResult, type AgentSessionMeta } from '@profer/shared'
import { getAgentHandoffDir } from './config-paths'
import { runRegisteredHeadlessAgent } from './agent-headless-runner-registry'
import {
  createAgentSession,
  getAgentSessionMeta,
  getAgentSessionSDKMessages,
  updateAgentSessionMeta,
} from './agent-session-manager'

/** 取转录尾部多少条消息用于提炼（够覆盖最近若干轮，又不至于整份大文件读盘） */
const HANDOFF_TAIL_MESSAGES = 60
/** 兜底摘要取最近多少轮 */
const HANDOFF_FALLBACK_TURNS = 12
/** 少于这个长度视为模型没真正写出文档，走兜底 */
const HANDOFF_MIN_DOC_CHARS = 200
/** 文档上限：超长截断，避免把一份巨型文档塞进新会话首轮 */
const HANDOFF_MAX_DOC_CHARS = 60_000
/** 等模型写文档的上限；超时后用当前已产出的内容（不够就兜底） */
const HANDOFF_AGENT_TIMEOUT_MS = 240_000

/**
 * 交给源会话的撰写指令。
 *
 * 刻意使用「封闭字段」而不是「总结一下这段对话」：到该换会话的时候，源会话的
 * 上下文已经不干净了，自由摘要退化得最快；固定字段（尤其「已否决」）反而能保住
 * 最容易丢失、也最值钱的信息。
 */
export const HANDOFF_DOCUMENT_PROMPT = `<profer_session_handoff>
请为这个会话写一份交接文档，供一个**全新的、没有任何上下文的** Agent 会话接手。

硬要求：
- 直接把文档正文作为回复输出，不要写文件、不要调用任何工具、不要加任何前言或收尾语。
- 用中文，Markdown，控制在 1200 字以内；只写接手者需要的信息，不要复述对话过程。
- 不确定的内容宁可不写，也不要编造；文件路径用相对路径。

严格按以下结构输出（没有内容的字段写「无」）：

## 目标
这个会话要达成的目标，一两句话。

## 已完成
已经落地并验证过的事项，逐条列出。

## 关键决策
做过的、会影响后续实现的选择，以及为什么。

## 已否决
试过但放弃的方向，以及放弃的原因。这一节最重要：接手者重复踩坑的代价最高。

## 改动过的文件
涉及的代码/文件，一句话说明各自的作用或改动。

## 未完成
明确还没做完的部分，以及当前卡在哪。

## 下一步
建议接手者先做什么，按优先级排列。

## 约束与注意事项
权限、环境、命令、约定等不该被忽略的前提。
</profer_session_handoff>`

interface HandoffDocument {
  body: string
  source: 'agent' | 'transcript'
}

/** 读取会话转录（尾部若干条即可，避免大会话整份读盘） */
function readTranscriptTurns(sessionId: string): TranscriptTurn[] {
  const page = getAgentSessionSDKMessages(sessionId, { tail: HANDOFF_TAIL_MESSAGES })
  const messages = Array.isArray(page) ? page : page.messages
  return toTranscript(groupIntoTurns(messages))
}

/** 取最后一次「长得像交接文档」的助手回复，作为模型撰写的正文 */
function captureAgentDocument(turns: TranscriptTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    if (!turn || turn.role !== 'assistant') continue
    const text = turn.text.trim()
    // 光有长度不够：模型可能只是道了个歉或复述了一句话。要求带 Markdown 小节标题，
    // 才算真的按模板产出了文档，否则宁可走兜底。
    if (text.length >= HANDOFF_MIN_DOC_CHARS && text.includes('## ')) return text
  }
  return null
}

/**
 * 落盘有 worker 线程的持久化队列，run 结束时最后一条回复可能还没写进 JSONL。
 * 直接读会读到旧内容（表现为「模型明明写完了却走了兜底」），所以留一小段重试窗口。
 */
async function captureAgentDocumentWithRetry(sessionId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const captured = captureAgentDocument(readTranscriptTurns(sessionId))
    if (captured) return captured
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

/** 确定性兜底：把最近若干轮渲染成 Markdown，质量低于模型撰写但不会失败 */
function buildTranscriptDocument(sessionId: string, turns: TranscriptTurn[]): string {
  const recent = selectTurns(turns, { tail: HANDOFF_FALLBACK_TURNS })
  return [
    '> 本文件由主进程按会话转录自动生成（模型撰写未成功）。',
    '> 它只保留最近若干轮的原始对话，请据此自行判断哪些信息仍然有效。',
    '',
    // 文件头由 composeDocumentFile 统一给出，这里不要再渲染一份
    renderTranscriptMarkdown(recent, { sessionId, header: false }),
  ].join('\n')
}

/** 拼出落盘内容：带来源头，便于以后回溯这份文档是怎么来的 */
function composeDocumentFile(meta: AgentSessionMeta, document: HandoffDocument): string {
  const body = document.body.length > HANDOFF_MAX_DOC_CHARS
    ? `${document.body.slice(0, HANDOFF_MAX_DOC_CHARS)}\n\n…（超长已截断）`
    : document.body
  return [
    '# 会话交接文档',
    '',
    `- 源会话：${meta.title}（${meta.id}）`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 文档来源：${document.source === 'agent' ? '源会话模型撰写' : '转录自动摘要（兜底）'}`,
    '',
    '---',
    '',
    body,
    '',
  ].join('\n')
}

/**
 * 让源会话产出交接文档正文。
 *
 * 失败一律不外抛：交接按钮不应该因为一次模型调用失败就变成死路，
 * 调用方按「拿不到就兜底」处理。
 */
async function generateDocumentWithAgent(meta: AgentSessionMeta): Promise<string | null> {
  const run = runRegisteredHeadlessAgent(
    {
      sessionId: meta.id,
      userMessage: HANDOFF_DOCUMENT_PROMPT,
      // 气泡里只显示这句话：完整的模板块留在 prompt 里，不把 XML 噪音写进用户转录。
      rawUserMessage: '帮我整理一份会话交接文档',
      channelId: meta.channelId ?? '',
      modelId: meta.modelId,
      workspaceId: meta.workspaceId,
      // 不当作一次用户提问：不清未读、不参与轮次统计。
      triggeredBy: 'automation',
      startedAt: Date.now(),
    },
    {
      source: 'automation',
      onError: (error) => { console.warn('[会话交接] 模型撰写交接文档失败:', error) },
      onComplete: () => {},
      onTitleUpdated: () => {},
    },
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn('[会话交接] 模型撰写交接文档超时，改用已有内容或兜底摘要')
      resolve()
    }, HANDOFF_AGENT_TIMEOUT_MS)
  })
  try {
    await Promise.race([run, timeout])
  } catch (error) {
    console.warn('[会话交接] 模型撰写交接文档异常:', error)
  } finally {
    if (timer) clearTimeout(timer)
  }

  return captureAgentDocumentWithRetry(meta.id)
}

function buildHandoffTitle(sourceTitle: string): string {
  const base = sourceTitle.trim() || '新 Agent 会话'
  return `${base} · 交接`
}

/** 新会话要沿用源会话的执行前提，否则接手者第一轮就会「权限不对、找不到文件」 */
function inheritExecutionContext(source: AgentSessionMeta) {
  const patch: Parameters<typeof updateAgentSessionMeta>[1] = {}
  if (source.permissionMode !== undefined) patch.permissionMode = source.permissionMode
  if (source.attachedDirectories?.length) patch.attachedDirectories = [...source.attachedDirectories]
  if (source.attachedFiles?.length) patch.attachedFiles = [...source.attachedFiles]
  return patch
}

/**
 * 执行一次会话交接：撰写文档 → 落盘 → 新建会话并沿用执行前提。
 *
 * 注意：新会话不写入任何消息。首轮 prompt 由渲染层用 `agentPendingPrompt` 发出，
 * 这样它才是一条正常的 run（写 `type:'user'` 进 JSONL 会锁死 runtime，
 * 也不会真的进入模型上下文）。
 */
export async function createHandoffSession(sessionId: string): Promise<AgentSessionHandoffResult> {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) throw new Error(`Agent 会话不存在: ${sessionId}`)

  const agentBody = await generateDocumentWithAgent(meta)
  const document: HandoffDocument = agentBody
    ? { body: agentBody, source: 'agent' }
    : { body: buildTranscriptDocument(sessionId, readTranscriptTurns(sessionId)), source: 'transcript' }

  const handoffDir = getAgentHandoffDir()
  const handoffPath = join(handoffDir, `${sessionId}-${Date.now()}.md`)
  writeFileSync(handoffPath, composeDocumentFile(meta, document), 'utf-8')

  const created = createAgentSession(
    buildHandoffTitle(meta.title),
    meta.channelId,
    meta.workspaceId,
    meta.modelId,
    normalizeAgentRuntime(meta.agentRuntime),
    false,
    meta.presetId,
  )
  const session = updateAgentSessionMeta(created.id, inheritExecutionContext(meta))

  console.log(
    `[会话交接] ${sessionId} → ${session.id}（文档来源: ${document.source}，${handoffPath}）`,
  )

  return {
    session,
    fromSessionId: sessionId,
    handoffPath,
    handoffDir,
    handoffSource: document.source,
  }
}
