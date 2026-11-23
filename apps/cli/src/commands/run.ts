import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { clearLine, cursorTo } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { stripVTControlCharacters } from 'node:util'
import type { AgentSessionMeta, AgentWorkspace, AskUserRequest, ExitPlanModeRequest, PendingRequestsSnapshot, PermissionRequest } from '@profer/shared'
import { boolFlag, strFlag } from '../args'
import { connectLocalCore } from '../local-core'
import { emitJson, emitText, EXIT_ERROR, EXIT_OK, info, UsageError } from '../output'
import { register, type CommandContext } from '../registry'

const PRINTABLE_TTY = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g
const terminalText = (text: string) => stripVTControlCharacters(text).replace(PRINTABLE_TTY, '')

type LocalCore = Awaited<ReturnType<typeof connectLocalCore>>
type Session = Pick<AgentSessionMeta, 'id' | 'workspaceId' | 'updatedAt' | 'archived' | 'draft'>
type Interaction = { type: 'permission_request'; request: PermissionRequest }
  | { type: 'ask_user_request'; request: AskUserRequest }
  | { type: 'exit_plan_mode_request'; request: ExitPlanModeRequest }
type InteractionResolution = { type: 'permission_resolved' | 'ask_user_resolved' | 'exit_plan_mode_resolved'; requestId: string }
type RuntimeFrame = {
  type?: string; triggerId?: string; runId?: string
  event?: Interaction | InteractionResolution
  message?: { type?: string; uuid?: string; _partial?: boolean; _provenance?: { messageId?: string; runId?: string }; message?: { content?: Array<{ type: string; text?: string }> } }
  outcome?: { status?: string; error?: string; stopReason?: string }
}
type Terminal = { signal: AbortSignal; ask: (prompt: string, signal?: AbortSignal) => Promise<string | undefined> }
type CoreRunSnapshot = {
  runs?: Array<{ id: string; sessionRef?: string; status: string; finishedAt?: number; failureReason?: string }>
  pending?: Array<PendingRequestsSnapshot & { sessionId: string }>
}

const textOf = (message: NonNullable<RuntimeFrame['message']>) =>
  message.message?.content?.filter(item => item.type === 'text').map(item => item.text ?? '').join('') ?? ''

function belongsTo(path: string, root: string): boolean {
  const diff = relative(root, path)
  return diff === '' || (!isAbsolute(diff) && diff !== '..' && !diff.startsWith(`..${sep}`))
}

async function selectSession(core: LocalCore, flags: CommandContext['args']['flags']): Promise<Session> {
  const resume = strFlag(flags, 'resume')
  const continueLatest = boolFlag(flags, 'continue')
  const workspaceRef = strFlag(flags, 'workspace')
  const listWorkspaces = async () => (await core.json<{ workspaces: AgentWorkspace[] }>('/workspaces')).workspaces
  const findWorkspace = (items: AgentWorkspace[]) => items.find(item => item.id === workspaceRef) ?? items.find(item => item.slug === workspaceRef)
  if (resume) {
    const { session } = await core.json<{ session: Session }>(`/sessions/${encodeURIComponent(resume)}/detail`)
    if (workspaceRef && session.workspaceId !== workspaceRef) {
      const workspace = findWorkspace(await listWorkspaces())
      if (!workspace || session.workspaceId !== workspace.id) throw new Error('会话不属于指定工作区')
    }
    return session
  }
  const available = (await listWorkspaces()).filter(item => !item.archived && !item.isDeleted)
  const cwd = process.cwd()
  const workspace = workspaceRef ? findWorkspace(available) : available
    .flatMap(item => item.rootPath && belongsTo(cwd, resolve(item.rootPath)) ? [{ item, length: resolve(item.rootPath).length }] : [])
    .sort((a, b) => b.length - a.length)[0]?.item
  if (!workspace) throw new Error(workspaceRef ? '找不到指定的工作区' : available.some(item => item.slug === 'default')
    ? '当前目录未绑定 Core 工作区；请进入已绑定项目，或使用 --workspace default'
    : '当前目录未绑定 Core 工作区；请进入已绑定项目或使用 --workspace ID')
  if (continueLatest) {
    const { sessions } = await core.json<{ sessions: Session[] }>('/sessions')
    const latest = sessions.filter(item => item.workspaceId === workspace.id && !item.archived && !item.draft)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!latest) throw new Error('当前工作区没有可续接的会话')
    return latest
  }
  return core.json<Session>('/sessions/configured', {
    workspaceId: workspace.id,
    channelId: strFlag(flags, 'channel'),
    modelId: strFlag(flags, 'model'),
    runtime: strFlag(flags, 'runtime'),
  })
}

// Core 每条 SSE 帧为单行 JSON。以行缓冲处理 TCP 分段，不把半条事件视为完整消息。
async function* coreEvents(body: ReadableStream<Uint8Array>) {
  let buffer = ''
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data: ')) yield JSON.parse(line.slice(6)) as { type: string; sessionId?: string; payload?: RuntimeFrame }
    }
  }
}

async function runTurn(core: LocalCore, sessionId: string, prompt: string | undefined, format: 'text' | 'json' | 'stream-json', terminal?: Terminal): Promise<number> {
  const disconnect = terminal?.signal
  const path = `/sessions/${encodeURIComponent(sessionId)}`
  const uuid = randomUUID()
  const triggerId = `message:${sessionId}:${uuid}`
  const eventsAbort = new AbortController()
  const connectTimeout = setTimeout(() => eventsAbort.abort(), 5000)
  let runId: string | undefined
  const attachingSince = Date.now()
  let terminalFromSnapshot: RuntimeFrame | undefined
  const finalText = new Map<string, string>()
  let previewVisible = false
  const clearPreview = () => {
    if (!previewVisible) return
    clearLine(process.stderr, 0)
    cursorTo(process.stderr, 0)
    previewVisible = false
  }
  const showPreview = (text: string) => {
    if (!terminal || !process.stderr.isTTY) return
    // Partial 是可替换的完整快照，不一定是最终正文的前缀。用一行预览而非追加到 transcript。
    const limit = Math.max(1, Math.floor(((process.stderr.columns || 80) - 5) / 2))
    const tail = [...terminalText(text).replace(/\s+/g, ' ')].slice(-limit).join('')
    clearPreview()
    process.stderr.write(`… ${tail}`)
    previewVisible = true
  }
  const stream = (type: string, data: object = {}) => {
    if (format === 'stream-json') process.stdout.write(JSON.stringify({ type, sessionId, runId, ...data }) + '\n')
  }
  const queue = new Map<string, Interaction>()
  const seen = new Set<string>()
  const enqueue = (item: Interaction) => {
    const { requestId, runId: ownerRun, sessionId: ownerSession } = item.request
    if (runId && ownerRun === runId && ownerSession === sessionId && !seen.has(requestId)) {
      seen.add(requestId)
      queue.set(requestId, item)
    }
  }
  let asking: { id: string; cancel: AbortController; done: Promise<{ kind: 'answer'; error?: unknown }> } | undefined
  try {
    const signal = disconnect ? AbortSignal.any([disconnect, eventsAbort.signal]) : eventsAbort.signal
    const response = await core.request(`${path}/events`, { signal })
    if (!response.body) throw new Error('Core 未返回事件流')
    const events = coreEvents(response.body)
    const ready = await events.next()
    if (ready.done || ready.value.type !== 'ready' || ready.value.sessionId !== sessionId) throw new Error('Core 事件流未就绪')
    clearTimeout(connectTimeout)
    if (prompt === undefined) {
      // 先订阅再快照：快照期间结束的轮次或新增的请求仍会进入事件流。
      const snapshot = await core.command({ type: 'core_snapshot' }, signal) as CoreRunSnapshot
      const runs = snapshot.runs?.filter(item => item.sessionRef === sessionId) ?? []
      const active = runs.findLast(item => item.status === 'running' || item.status === 'waiting')
      // 如在订阅/查快照期间已结束，直接用这一轮终态，避免错过最后一帧后卡住或显示旧轮。
      const finished = active ? undefined : runs.filter(item => (item.finishedAt ?? 0) >= attachingSince
        && ['completed', 'failed', 'stopped'].includes(item.status)).at(-1)
      const run = active ?? finished
      if (!run) return EXIT_OK
      runId = run.id
      info(`已接回运行：${runId}（未发送新消息）`)
      if (finished) terminalFromSnapshot = { type: 'runtime_finished', runId, outcome: { status: finished.status, error: finished.failureReason } }
      if (active) {
        const pending = snapshot.pending?.find(item => item.sessionId === sessionId)
        for (const request of pending?.permissions ?? []) enqueue({ type: 'permission_request', request })
        for (const request of pending?.askUsers ?? []) enqueue({ type: 'ask_user_request', request })
        for (const request of pending?.exitPlans ?? []) enqueue({ type: 'exit_plan_mode_request', request })
      }
    } else {
      info(`会话：${sessionId}`)
      const submissionSignal = AbortSignal.any([signal, AbortSignal.timeout(60000)])
      await core.json(`${path}/messages`, { prompt, uuid, context: { trigger: {
        schemaVersion: 1, id: triggerId, kind: 'user_message', actor: { type: 'user' }, createdAt: Date.now(),
        authorization: { kind: 'direct', sourceRef: { type: 'message', id: uuid } },
      } } }, submissionSignal)
    }
    const read = () => {
      if (!terminalFromSnapshot) return events.next().then(value => ({ kind: 'event' as const, value }))
      const payload = terminalFromSnapshot
      terminalFromSnapshot = undefined
      return Promise.resolve({ kind: 'event' as const, value: { done: false as const, value: { type: 'runtime', sessionId, payload } } })
    }
    let next = read()
    while (true) {
      if (!asking && queue.size) {
        const item = queue.values().next().value!
        const id = item.request.requestId
        queue.delete(id)
        if (!terminal) throw new Error(`该轮需要用户操作（${item.type}）；请用桌面打开会话 ${sessionId}，或在交互终端使用 --resume`)
        clearPreview()
        const cancel = new AbortController()
        const inputSignal = AbortSignal.any([signal, cancel.signal])
        const done = answerInteraction(core, item, terminal.ask, inputSignal).then(
          () => ({ kind: 'answer' as const }),
          (error: unknown) => cancel.signal.aborted ? { kind: 'answer' as const } : { kind: 'answer' as const, error },
        )
        asking = { id, cancel, done }
      }
      const incoming = await (asking ? Promise.race([next, asking.done]) : next)
      if (incoming.kind === 'answer') {
        asking = undefined
        if (incoming.error) throw incoming.error
        continue
      }
      if (incoming.value.done) break
      const frame = incoming.value.value
      const event = frame.payload
      // 保留唯一的在途读取；审批时仍能看到其他端解决请求或本轮结束。
      if (frame.sessionId !== sessionId || !event) { next = read(); continue }
      if (prompt !== undefined && !runId && event.triggerId === triggerId && event.runId) {
        runId = event.runId
        stream('start')
      }
      const interaction = event.event
      if (interaction?.type === 'permission_request' || interaction?.type === 'ask_user_request' || interaction?.type === 'exit_plan_mode_request') enqueue(interaction)
      if (interaction && 'requestId' in interaction && interaction.type.endsWith('_resolved')) {
        seen.add(interaction.requestId)
        queue.delete(interaction.requestId)
        if (asking?.id === interaction.requestId) asking.cancel.abort()
      }
      if (!runId || event.runId !== runId) { next = read(); continue }
      if (event.type === 'message' && event.message?.type === 'assistant') {
        const message = event.message
        const text = textOf(message)
        if (!text) { next = read(); continue }
        const messageId = message._provenance?.messageId ?? message.uuid
        if (message._partial) showPreview(text)
        else {
          clearPreview()
          if (messageId) finalText.set(messageId, text)
        }
        stream('assistant', { messageId, partial: message._partial === true, text })
      }
      if (event.type !== 'runtime_finished') { next = read(); continue }
      if (asking) { asking.cancel.abort(); await asking.done; asking = undefined }
      if (prompt === undefined) {
        const { messages } = await core.json<{ messages: Array<NonNullable<RuntimeFrame['message']>> }>(`${path}/messages`, undefined, AbortSignal.any([signal, AbortSignal.timeout(5000)]))
        const persisted: typeof finalText = new Map()
        for (const message of messages) {
          const messageId = message._provenance?.messageId ?? message.uuid
          if (message.type === 'assistant' && !message._partial && messageId && message._provenance?.runId === runId) {
            const text = textOf(message)
            if (text) persisted.set(messageId, text)
          }
        }
        for (const [id, text] of finalText) if (!persisted.has(id)) persisted.set(id, text)
        finalText.clear()
        for (const [id, text] of persisted) finalText.set(id, text)
      }
      const status = event.outcome?.status
      if (status !== 'completed' && status !== 'stopped' && status !== 'failed') throw new Error('Core 返回了未知运行终态')
      const error = event.outcome?.error ?? event.outcome?.stopReason
      const result = { status, text: [...finalText.values()].join('\n'), ...(error ? { error } : {}) }
      clearPreview()
      if (format === 'json') emitJson({ sessionId, runId, ...result })
      else if (format === 'stream-json') stream('result', result)
      else if (result.text) emitText(process.stdout.isTTY ? terminalText(result.text) : result.text)
      if (status !== 'completed') info(error ? terminalText(error) : `运行已${status === 'stopped' ? '停止' : '失败'}`)
      return status === 'completed' ? EXIT_OK : EXIT_ERROR
    }
    throw new Error(`Core 事件流已断开，运行结果未确认；可用 --resume ${sessionId} 接续，不会自动重发`)
  } finally {
    if (asking) { asking.cancel.abort(); await asking.done }
    clearPreview()
    clearTimeout(connectTimeout)
    eventsAbort.abort()
  }
}

async function answerInteraction(core: LocalCore, interaction: Interaction, ask: Terminal['ask'], signal: AbortSignal) {
  const { requestId, sessionId, runId } = interaction.request
  const scope = { requestId, sessionId, runId }
  let command: object
  if (interaction.type === 'permission_request') {
    const { toolName, toolInput } = interaction.request
    info(terminalText(`工具权限：${toolName}\n${JSON.stringify(toolInput, null, 2)}`))
    const answer = await ask('仅允许本次？[y/N] ', signal)
    if (answer === undefined) throw new Error('未回答；请求保留在 Core，可在桌面继续处理')
    command = { ...scope, type: 'respond_permission', behavior: /^(y|yes)$/i.test(answer.trim()) ? 'allow' : 'deny' }
  } else if (interaction.type === 'ask_user_request') {
    const answers: Array<[string, string]> = []
    for (const question of interaction.request.questions) {
      info(terminalText(question.question))
      for (const option of question.options) info(terminalText(`  - ${option.label}${option.description ? `：${option.description}` : ''}`))
      const answer = await ask(question.multiSelect ? '回答（多选用逗号分隔）：' : '回答：', signal)
      if (answer === undefined) throw new Error('未回答；请求保留在 Core，可在桌面继续处理')
      answers.push([question.question, answer])
    }
    command = { ...scope, type: 'respond_ask_user', answers: Object.fromEntries(answers) }
  } else {
    // 在终端没有显示完整计划时不能批准；将审批交给能查看同一计划的客户端。
    throw new Error(`请在桌面查看完整计划并处理审批：${sessionId}`)
  }
  signal.throwIfAborted()
  if (await core.command(command, signal) !== true) info('这条请求已失效或已处理，继续等待本轮结果。')
}

register({
  name: 'run',
  summary: '在当前工作区开始终端会话；--print 运行一轮后退出',
  usage: 'run [-p PROMPT] [--continue | --resume ID] [--workspace ID|SLUG] [--channel ID] [--model MODEL] [--runtime pi|claude] [--output-format text|json|stream-json]',
  async run({ args, pathOpts, json }) {
    const { flags } = args
    const prompt = args.positionals.join(' ').trim() || strFlag(flags, 'print')?.trim() || ''
    const print = flags.print !== undefined
    const interactive = !print && !!process.stdin.isTTY && !!process.stdout.isTTY
    if (!interactive && !prompt) throw new UsageError('请输入提示词（例如 profer -p "你好"）')
    const selectionFlags = ['channel', 'model', 'runtime']
    for (const flag of ['resume', 'workspace', 'output-format', 'config-dir', ...selectionFlags]) {
      if (flags[flag] === true || flags[flag] === '') throw new UsageError(`--${flag} 缺少值`)
    }
    const resume = strFlag(flags, 'resume')
    const continueLatest = boolFlag(flags, 'continue')
    if (resume && continueLatest) throw new UsageError('--resume 和 --continue 不能同时使用')
    if ((resume || continueLatest) && selectionFlags.some(flag => Object.hasOwn(flags, flag))) {
      throw new UsageError('续接沿用原会话配置；--channel、--model 和 --runtime 只用于新会话')
    }
    const runtime = strFlag(flags, 'runtime')
    if (runtime !== undefined && runtime !== 'pi' && runtime !== 'claude') throw new UsageError('--runtime 只支持 pi 或 claude')
    const format = strFlag(flags, 'output-format') ?? (json ? 'json' : 'text')
    if (format !== 'text' && format !== 'json' && format !== 'stream-json') throw new UsageError('无效的 --output-format')
    if (interactive && format !== 'text') throw new UsageError('机器输出格式需要 --print')
    const core = await connectLocalCore(pathOpts, { autoStart: true })
    if (!interactive) {
      const session = await selectSession(core, flags)
      return runTurn(core, session.id, prompt, format)
    }
    // 读取第一条非空输入才创建会话；直接退出不会留下空历史。
    const input = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    const disconnect = new AbortController()
    const closedInput = new AbortController()
    let session: Session | undefined
    input.once('close', () => { closedInput.abort() })
    input.on('SIGINT', () => { disconnect.abort(); input.close() })
    const nextLine = async (prompt: string, signal?: AbortSignal) => {
      const readSignal = signal ? AbortSignal.any([signal, closedInput.signal]) : closedInput.signal
      try { return await input.question(prompt, { signal: readSignal }) }
      catch (error) { if (!closedInput.signal.aborted) throw error }
    }
    const terminal = { signal: AbortSignal.any([disconnect.signal, closedInput.signal]), ask: nextLine }
    const turn = async (text: string) => {
      session ??= await selectSession(core, flags)
      return runTurn(core, session.id, text, 'text', terminal)
    }
    try {
      info('输入 /exit 或 Ctrl-D 退出。')
      if (!prompt && (strFlag(flags, 'resume') || boolFlag(flags, 'continue'))) {
        session = await selectSession(core, flags)
        await runTurn(core, session.id, undefined, 'text', terminal)
      }
      let line: string | undefined = prompt || undefined
      while (!closedInput.signal.aborted) {
        line ??= await nextLine('profer> ')
        if (line === undefined || line.trim() === '/exit') break
        const text = line.trim()
        if (text && await turn(text) !== EXIT_OK) return EXIT_ERROR
        line = undefined
      }
      return disconnect.signal.aborted ? 130 : EXIT_OK
    } catch (error) {
      if (closedInput.signal.aborted && !disconnect.signal.aborted) return EXIT_OK
      if (!disconnect.signal.aborted) throw error
      info('已退出终端；已提交的运行不会因此停止。')
      return 130
    } finally { input.close() }
  },
})
