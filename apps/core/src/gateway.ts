import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { AgentRuntimeEvent } from '@profer/agent-runtime'
import type { CoreAgentRuntime } from './runtime'
import { CoreEventWindow } from './event-window'
import { randomUUID } from 'node:crypto'
import type { DesktopHostResponse } from './host-bridge'
import { parseCoreMessageOptions } from './message-input'

export interface CoreGatewayOptions { server: Server; runtime: CoreAgentRuntime; token: string }

function tokenFromUpgrade(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length)
  const queryToken = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
  if (queryToken) return queryToken
  return request.headers['sec-websocket-protocol']
    ?.split(',')
    .map(value => value.trim())
    .find(value => value.startsWith('profer.'))
    ?.slice('profer.'.length)
}

function eventPayload(event: AgentRuntimeEvent): unknown {
  if (event.type === 'message') return { kind: 'sdk_message', message: event.message }
  if (event.type === 'host_event') return { kind: 'profer_event', event: event.event }
  if (event.type === 'runtime_finished') {
    const outcome = event.outcome
    return {
      kind: 'profer_event',
      event: {
        type: 'run_completed',
        sessionId: event.sessionId,
        runId: event.runId,
        taskId: event.taskId,
        triggerId: event.triggerId,
        outcomeStatus: outcome.status,
        stopReason: outcome.status === 'stopped' ? outcome.stopReason : undefined,
        stoppedByUser: outcome.status === 'stopped',
        resultSubtype: outcome.status === 'completed' ? 'success' : outcome.status === 'failed' ? 'error_during_execution' : undefined,
        resultErrors: outcome.status === 'failed' ? [outcome.error] : undefined,
      },
    }
  }
  return { kind: 'profer_event', event }
}

function isRunCompletedFrame(value: unknown): value is { kind: 'profer_event'; event: { type: 'run_completed'; startedAt?: number; [key: string]: unknown } } {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { kind?: unknown; event?: unknown }
  if (candidate.kind !== 'profer_event' || !candidate.event || typeof candidate.event !== 'object') return false
  return (candidate.event as { type?: unknown }).type === 'run_completed'
}

export function attachCoreWebSocketGateway(options: CoreGatewayOptions): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: protocols => [...protocols].find(protocol => protocol.startsWith('profer.')) ?? false,
  })
  const clients = new Set<WebSocket>()
  const window = new CoreEventWindow()
  const broadcast = (frame: import('./event-window').CoreEventFrame) => {
    const encoded = JSON.stringify(window.append(frame))
    for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(encoded)
  }
  const snapshot = () => ({
    chat: options.runtime.chat.snapshot(),
    deletionStatuses: options.runtime.deletions.statusSnapshots(),
    tombstones: options.runtime.deletions.snapshot().flatMap(record => record.sessions.map(meta => ({ sessionId: meta.id, revision: record.revision }))),
    sessions: options.runtime.sessions.list(), goals: options.runtime.goals.list(), automations: options.runtime.automations.list(),
    delegations: options.runtime.delegations.snapshot(), runs: options.runtime.listRuns(),
    pending: options.runtime.sessions.list().map(session => ({ sessionId: session.id,
      permissions: options.runtime.listPendingPermissions(session.id),
      askUsers: options.runtime.askUser.getPendingRequests().filter(request => request.sessionId === session.id),
      exitPlans: options.runtime.exitPlan.getPendingRequests().filter(request => request.sessionId === session.id),
    })),
    cursor: window.cursor,
  })
  /** 桌面端用 startedAt 区分新旧流；终态必须携带同一轮的开始时间，否则会被当成迟到终态丢弃。 */
  const startedAtBySession = new Map<string, number>()
  const unsubscribe = options.runtime.subscribe(event => {
    if (event.type === 'chat') {
      const data = event.payload as { channel: string; payload: unknown }
      broadcast({ kind: 'chat_event', conversationId: event.sessionId, channel: data.channel, payload: data.payload })
      return
    }
    if (event.type === 'workspace') {
      broadcast({ kind: 'workspace_event', payload: event.payload })
      return
    }
    if (event.type === 'planning' || event.type === 'automation') {
      broadcast({ kind: event.type === 'planning' ? 'planning_event' : 'automation_event', payload: event.payload })
      return
    }
    const runtimeEvent = event.payload as AgentRuntimeEvent | { error?: string } | undefined
    if (runtimeEvent && typeof runtimeEvent === 'object' && 'type' in runtimeEvent) {
      const typed = runtimeEvent as { type?: unknown; startedAt?: unknown }
      if (typed.type === 'runtime_started' && typeof typed.startedAt === 'number' && Number.isFinite(typed.startedAt)) {
        startedAtBySession.set(event.sessionId, typed.startedAt)
      }
    }
    const projected = event.type === 'error'
      ? { kind: 'run_error', error: typeof runtimeEvent === 'object' && runtimeEvent && 'error' in runtimeEvent ? String(runtimeEvent.error) : 'Agent execution failed' }
      : event.type === 'complete'
        ? { kind: 'profer_event', event: { type: 'run_completed', sessionId: event.sessionId, outcome: runtimeEvent } }
        : runtimeEvent && typeof runtimeEvent === 'object' && 'type' in runtimeEvent
          ? eventPayload(runtimeEvent as AgentRuntimeEvent)
          : runtimeEvent
    if (isRunCompletedFrame(projected)) {
      const startedAt = startedAtBySession.get(event.sessionId)
      startedAtBySession.delete(event.sessionId)
      if (startedAt !== undefined) projected.event.startedAt = startedAt
    }
    broadcast({ kind: 'agent_event', sessionId: event.sessionId, payload: projected })
  })
  wss.on('close', unsubscribe)
  options.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws') { socket.destroy(); return }
    if (tokenFromUpgrade(request) !== options.token) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  })
  wss.on('connection', ws => {
    const connectionId = randomUUID()
    let detachHost: (() => void) | undefined
    clients.add(ws)
    ws.send(JSON.stringify({ kind: 'hello', serverTime: Date.now() }))
    ws.on('close', () => { detachHost?.(); options.runtime.unbindDesktopHost(connectionId); clients.delete(ws) })
    ws.on('message', raw => {
      void (async () => {
        let commandId: unknown = null
        try {
          const command = JSON.parse(raw.toString()) as Record<string, unknown>
          commandId = command._cmdId ?? command.requestId ?? null
          const type = command.type
          let data: unknown
          if (type === 'register_desktop_host') {
            if (!detachHost) detachHost = options.runtime.desktopHosts.attach(connectionId, request => {
              if (ws.readyState !== WebSocket.OPEN) throw new Error('桌面宿主已断连')
              ws.send(JSON.stringify({ kind: 'host_request', request }))
            })
            if (Array.isArray(command.sessionIds)) for (const id of command.sessionIds) {
              if (typeof id === 'string') options.runtime.bindDesktopHost(id, connectionId)
            }
            data = { registered: true }
          } else if (type === 'bind_desktop_host') {
            if (typeof command.sessionId !== 'string') throw new Error('会话身份无效')
            options.runtime.bindDesktopHost(command.sessionId, connectionId)
            data = { bound: true }
          } else if (type === 'desktop_host_response') {
            data = { accepted: options.runtime.desktopHosts.respond(connectionId, command.response as DesktopHostResponse) }
          } else if (type === 'ping') { ws.send(JSON.stringify({ kind: 'pong', serverTime: Date.now() })); return }
          else if (type === 'resume_agent_events') {
            const resumed = window.resume(command.cursor)
            for (const frame of resumed.events) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...frame, replay: true }))
            data = { ...resumed, events: undefined, replayed: resumed.events.length, complete: true, snapshot: resumed.requiresSnapshot ? snapshot() : undefined }
          } else if (type === 'native_snapshot') {
            if (typeof command.sessionId !== 'string') throw new Error('会话身份无效')
            data = options.runtime.nativeOperations.snapshot(command.sessionId, typeof command.since === 'string' ? command.since : undefined)
          } else if (type === 'native_operation') {
            if (typeof command.sessionId !== 'string' || typeof command.operation !== 'string') throw new Error('原生操作身份无效')
            if (!command.input || typeof command.input !== 'object' || Array.isArray(command.input)) throw new Error('原生操作参数无效')
            data = await options.runtime.nativeOperations.operation(command.sessionId, command.operation, {
              ...(command.input as Record<string, unknown>), callerKey: 'authenticated-desktop',
            })
          } else if (type === 'delete_session') {
            if (typeof command.sessionId !== 'string' || !command.sessionId) throw new Error('session_id_required')
            data = options.runtime.deletions.request(command.sessionId)
          } else if (type === 'import_legacy_deletion') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            const sourceRequestId = typeof command.sourceRequestId === 'string' ? command.sourceRequestId : ''
            if (!Array.isArray(command.sessionIds) || command.sessionIds.some(id => typeof id !== 'string')) throw new Error('历史删除会话快照无效')
            if (command.workspaceId !== undefined && typeof command.workspaceId !== 'string') throw new Error('历史删除工作区无效')
            if (command.requestedAt !== undefined && typeof command.requestedAt !== 'number') throw new Error('历史删除时间无效')
            if (command.reason !== undefined && !['user', 'workspace', 'resume'].includes(String(command.reason))) throw new Error('历史删除原因无效')
            data = options.runtime.deletions.importLegacyRequest({ sourceRequestId, sessionId, sessionIds: command.sessionIds as string[],
              workspaceId: command.workspaceId as string | undefined, requestedAt: command.requestedAt as number | undefined,
              reason: command.reason as 'user' | 'workspace' | 'resume' | undefined })
          } else if (type === 'generate_title') {
            if (typeof command.channelId !== 'string' || typeof command.modelId !== 'string' || typeof command.userMessage !== 'string') throw new Error('invalid title input')
            data = await options.runtime.titles.generate({ channelId: command.channelId, modelId: command.modelId, userMessage: command.userMessage })
          } else if (type === 'regenerate_title') {
            if (typeof command.sessionId !== 'string' || !command.sessionId) throw new Error('session_id_required')
            await options.runtime.titles.regenerate(command.sessionId)
            data = options.runtime.sessions.getMeta(command.sessionId)
          } else if (type === 'get_task_output' || type === 'stop_task') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            const taskId = typeof command.taskId === 'string' ? command.taskId : ''
            if (!sessionId || !taskId || sessionId.length > 200 || taskId.length > 200) throw new Error('invalid task identity')
            if (type === 'get_task_output') {
              if (command.block !== undefined && typeof command.block !== 'boolean') throw new Error('invalid task blocking mode')
              if (command.timeoutMs !== undefined && (typeof command.timeoutMs !== 'number' || !Number.isFinite(command.timeoutMs) || command.timeoutMs < 0 || command.timeoutMs > 30_000)) throw new Error('invalid task timeout')
              data = await options.runtime.getTaskOutput(sessionId, taskId, { block: command.block as boolean | undefined, timeoutMs: command.timeoutMs as number | undefined })
            } else {
              if (command.taskType !== 'agent' && command.taskType !== 'shell') throw new Error('invalid task type')
              await options.runtime.stopTask(sessionId, taskId, command.taskType)
              data = true
            }
          } else if (type === 'session_ui_action') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            if (command.expectedRevision !== undefined && (!Number.isInteger(command.expectedRevision) || Number(command.expectedRevision) < 0)) throw new Error('invalid expected revision')
            data = await options.runtime.applySessionUiAction(sessionId, command.action as import('@profer/shared').AgentSessionUiAction, command.expectedRevision as number | undefined)
          } else if (type === 'desktop_channels_snapshot') {
            if (!Array.isArray(command.channels)) throw new Error('渠道快照无效')
            options.runtime.syncDesktopChannels(command.channels as import('./config').CoreChannelConfig[])
            data = true
          } else if (type === 'core_snapshot') data = snapshot()
          else if (type === 'list_sessions') data = options.runtime.sessions.list()
          else if (type === 'create_session') {
            const workspaceId = typeof command.workspaceId === 'string' ? command.workspaceId : ''
            if (!workspaceId || !options.runtime.workspaces.list().some(workspace => workspace.id === workspaceId)) throw new Error('会话必须显式指定合法Core工作区')
            const requestedRuntime = command.runtime === 'claude' || command.runtime === 'pi' ? command.runtime : undefined
            data = options.runtime.sessions.create({
              workspaceId,
              title: typeof command.title === 'string' ? command.title : 'New session',
              ...(requestedRuntime ? { runtime: requestedRuntime } : {}),
              modelId: typeof command.modelId === 'string' ? command.modelId : undefined,
              channelId: typeof command.channelId === 'string' ? command.channelId : undefined,
              permissionMode: command.permissionMode === 'auto' || command.permissionMode === 'plan' || command.permissionMode === 'bypassPermissions' ? command.permissionMode : undefined,
            })
          }
          else if (type === 'session_detail' || type === 'get_sdk_messages') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            const meta = options.runtime.sessions.getMeta(sessionId)
            if (!meta) throw new Error('session not found')
            data = type === 'session_detail' ? { meta, messages: options.runtime.sessions.readMessages(sessionId) } : options.runtime.sessions.readMessages(sessionId)
          } else if (type === 'send_message') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            const meta = options.runtime.sessions.getMeta(sessionId)
            const prompt = typeof command.userMessage === 'string' ? command.userMessage : typeof command.prompt === 'string' ? command.prompt : ''
            if (!meta || !prompt) throw new Error('session or message missing')
            options.runtime.assertAcceptingRuns()
            await options.runtime.goals.prepareUserTurn(sessionId)
            options.runtime.assertAcceptingRuns()
            let settleAdmission!: (failure?: string) => void
            const admission = new Promise<string | undefined>(resolve => { settleAdmission = resolve })
            const handle = options.runtime.coordinator.run({ ...options.runtime.createQuery(meta, prompt, parseCoreMessageOptions(command, true)), initiator: 'user' }, {
              onEvent() {}, onError() {},
              onRunStarted() { settleAdmission() },
              onPreparationFailure(failure) { settleAdmission(failure.message) },
              onComplete(outcome) { settleAdmission(outcome.status === 'failed' ? outcome.error : undefined) },
            })
            void handle.promise.then(outcome => settleAdmission(outcome.status === 'failed' ? outcome.error : undefined), error => settleAdmission(error instanceof Error ? error.message : String(error)))
            const preparationError = await admission
            if (preparationError) throw new Error(preparationError)
            data = { accepted: true, sessionId }
          } else if (type === 'queue_message') {
            const sessionId = String(command.sessionId ?? '')
            const prompt = typeof command.prompt === 'string' ? command.prompt : ''
            if (!prompt.trim()) throw new Error('追加消息不能为空')
            data = await options.runtime.queueMessage(sessionId, prompt, { uuid: typeof command.uuid === 'string' ? command.uuid : undefined,
              rawUserMessage: typeof command.rawUserMessage === 'string' ? command.rawUserMessage : undefined, interrupt: command.interrupt === true })
          } else if (type === 'list_pending_permissions') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            if (!options.runtime.sessions.getMeta(sessionId)) throw new Error('session not found')
            data = options.runtime.listPendingPermissions(sessionId)
          } else if (type === 'delegation_operation') {
            const session = options.runtime.sessions.getMeta(String(command.sessionId ?? ''))
            if (!session) throw new Error('委派父会话不存在')
            const ctx = { sessionId: session.id, workspaceId: session.workspaceId, channelId: session.channelId ?? '', modelId: session.modelId,
              agentRuntime: session.agentRuntime, permissionMode: options.runtime.permissions.getMode(session.id), operationId: String(command.operationId ?? commandId ?? '') }
            const input = command.input && typeof command.input === 'object' && !Array.isArray(command.input) ? command.input as Record<string, unknown> : {}
            const service = options.runtime.delegations
            if (command.operation === 'list') data = service.list(ctx, input)
            else if (command.operation === 'create') data = await service.delegate(ctx, input as unknown as import('@profer/agent-runtime/delegation-tool-operations').DelegateInput)
            else if (command.operation === 'create_batch') data = await service.delegateBatch(ctx, input as unknown as import('@profer/agent-runtime/delegation-tool-operations').DelegateBatchInput)
            else if (command.operation === 'models') data = service.listAvailableModels(ctx)
            else if (command.operation === 'results') data = service.getResults(ctx, input.delegationIds as string[])
            else if (command.operation === 'wait') data = await service.wait(ctx, input)
            else if (command.operation === 'stop') data = await service.stop(ctx, String(input.delegationId ?? ''))
            else if (command.operation === 'stop_many') data = await service.stopMany(ctx, input.delegationIds as string[] | undefined)
            else if (command.operation === 'answer') data = await service.answer(ctx, input as unknown as import('@profer/agent-runtime/delegation-tool-operations').DelegationAnswerInput)
            else if (command.operation === 'continue') data = await service.continue(ctx, input as unknown as { delegationId: string; message: string })
            else throw new Error('不支持的委派命令')
          } else if (type === 'automation_mirrors') {
            data = options.runtime.automations.projectMirrorStatuses()
          } else if (type === 'automation_mirror_inspect') {
            data = options.runtime.automations.inspectProjectMirror(String(command.workspaceId ?? ''))
          } else if (type === 'automation_mirror_restore') {
            data = options.runtime.automations.restoreProjectMirror(String(command.workspaceId ?? ''), String(command.expectedHash ?? ''))
          } else if (type === 'automation_mirror_resolve') {
            data = options.runtime.automations.resolveProjectMirrorWithCore(String(command.workspaceId ?? ''), String(command.expectedHash ?? ''))
            options.runtime.automations.retryProjectMirrors()
          } else if (type === 'automation_mirrors_retry') {
            options.runtime.automations.retryProjectMirrors()
            data = options.runtime.automations.projectMirrorStatuses()
          } else if (type === 'automation_outbox') {
            data = options.runtime.automations.notificationOutbox().map(({ automation, ...item }) => ({ ...item, automationName: automation.name }))
          } else if (type === 'automation_notification_retry') {
            data = options.runtime.automations.retryUncertainNotification(String(command.id ?? ''))
          } else if (type === 'automation_list') {
            data = options.runtime.automations.list()
          } else if (type === 'automation_create' || type === 'automation_update') {
            if (!command.input || typeof command.input !== 'object' || Array.isArray(command.input)) throw new Error('invalid Automation input')
            const input = command.input as Record<string, unknown>
            const { promptAuthor: _untrusted, ...fields } = input
            const trusted = { ...fields, ...(fields.prompt !== undefined ? { promptAuthor: { type: 'user' as const } } : {}) }
            data = options.runtime.automations.command(String(command.operationId ?? commandId ?? ''), type === 'automation_create' ? 'create' : 'update', trusted)
          } else if (type === 'automation_delete') {
            data = options.runtime.automations.command(String(command.operationId ?? commandId ?? ''), 'delete', { id: command.id })
          } else if (type === 'automation_run_now') {
            data = options.runtime.automations.command(String(command.operationId ?? commandId ?? ''), 'run_now', { id: command.id })
          } else if (type === 'goal_start') {
            data = await options.runtime.goals.start(String(command.sessionId ?? ''), String(command.goal ?? ''), (command.limits ?? { maxConsecutiveFailures: 3 }) as import('@profer/shared').AgentGoalLimits, command.contract as import('@profer/shared').AgentGoalContract | undefined)

          } else if (type === 'goal_list') {
            data = options.runtime.goals.list(typeof command.sessionId === 'string' ? command.sessionId : undefined)
          } else if (type === 'goal_history') {
            data = options.runtime.goals.history(typeof command.sessionId === 'string' ? command.sessionId : undefined)
          } else if (type === 'goal_update') {
            if (!command.patch || typeof command.patch !== 'object' || Array.isArray(command.patch)) throw new Error('invalid Goal patch')
            data = options.runtime.goals.update(String(command.goalId ?? ''), command.patch as Parameters<typeof options.runtime.goals.update>[1])
          } else if (type === 'goal_clear') {
            options.runtime.goals.clear(String(command.goalId ?? ''))
            data = true
          } else if (type === 'goal_pause' || type === 'goal_resume' || type === 'goal_stop') {
            const id = String(command.goalId ?? '')
            data = await (type === 'goal_pause' ? options.runtime.goals.pause(id) : type === 'goal_resume' ? options.runtime.goals.resume(id) : options.runtime.goals.stop(id))
          } else if (type === 'list_pending_requests') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            if (!options.runtime.sessions.getMeta(sessionId)) throw new Error('session not found')
            data = { permissions: options.runtime.listPendingPermissions(sessionId), askUsers: options.runtime.askUser.getPendingRequests().filter(request => request.sessionId === sessionId), exitPlans: options.runtime.exitPlan.getPendingRequests().filter(request => request.sessionId === sessionId), goalProposals: [] }
          } else if (type === 'respond_exit_plan_mode') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            const requestId = typeof command.requestId === 'string' ? command.requestId : ''
            if (!sessionId || !requestId || !['approve_auto', 'approve_edit', 'deny', 'feedback'].includes(String(command.action))) throw new Error('invalid plan response')
            data = await options.runtime.respondExitPlan({ sessionId, requestId, runId: typeof command.runId === 'string' ? command.runId : undefined,
              action: command.action as import('@profer/shared').ExitPlanModeAction, feedback: typeof command.feedback === 'string' ? command.feedback : undefined })
          } else if (type === 'respond_ask_user') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            const requestId = typeof command.requestId === 'string' ? command.requestId : ''
            const answers = command.answers
            if (!sessionId || !requestId || !answers || typeof answers !== 'object' || Array.isArray(answers) || Object.values(answers).some(value => typeof value !== 'string')) throw new Error('invalid AskUser response')
            data = !!await options.runtime.askUser.respondToAskUser(requestId, answers as Record<string, string>, { sessionId, runId: typeof command.runId === 'string' ? command.runId : undefined })
            if (data) options.runtime.publish({ type: 'runtime', sessionId, payload: { kind: 'profer_event', event: { type: 'ask_user_resolved', requestId } } })
          } else if (type === 'respond_permission') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            const requestId = typeof command.requestId === 'string' ? command.requestId : ''
            const behavior = command.behavior === 'allow' || command.behavior === 'deny' ? command.behavior : undefined
            if (!sessionId || !requestId || !behavior) throw new Error('invalid permission response')
            data = options.runtime.respondToPermission(sessionId, requestId, behavior, command.alwaysAllow === true, typeof command.runId === 'string' ? command.runId : undefined)
          } else if (type === 'stop_agent') {
            const sessionId = typeof command.sessionId === 'string' ? command.sessionId : ''
            if (!sessionId || !options.runtime.sessions.getMeta(sessionId) || options.runtime.deletions.isDeleting(sessionId)) throw new Error('session not found')
            const stopped = Boolean(options.runtime.coordinator.ownership.getOwner(sessionId))
              || options.runtime.goals.list(sessionId).some(goal => goal.status === 'active' || goal.status === 'stopping')
            await options.runtime.stopDelegationsForParent(sessionId)
            const paused = options.runtime.goals.pauseSessionForInterrupt(sessionId)
            if (paused) await paused
            else await options.runtime.coordinator.stopAndWait(sessionId)
            data = { sessionId, stopped }
          } else throw new Error(`unsupported command: ${String(type)}`)
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'command_result', requestId: commandId, commandId, ok: true, data }))
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ kind: 'command_result', requestId: commandId, commandId, ok: false, error: error instanceof Error ? error.message : String(error) }))
        }
      })()
    })
  })
  return wss
}
