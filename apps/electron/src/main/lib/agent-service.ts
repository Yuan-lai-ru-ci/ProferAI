/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 AgentOrchestrator / EventBus / Adapter 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * 所有业务逻辑已委托给 AgentOrchestrator。
 */

import { join, dirname, basename, sep } from 'node:path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE } from '@profer/shared'
import type {
  AgentSendInput,
  AgentMessage,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentQueueMessageInput,
  ProferPermissionMode,
  AgentExternalRunSource,
} from '@profer/shared'
import { ClaudeAgentAdapter, scanAndKillOrphanedClaudeSubprocesses } from './adapters/claude-agent-adapter'
import { PiAgentAdapter } from './adapters/pi-agent-adapter'
import { RuntimeRoutingAgentAdapter } from './adapters/runtime-routing-agent-adapter'
import { AgentEventBus } from './agent-event-bus'
import { AgentOrchestrator, serializeErrorDetail } from './agent-orchestrator'
import { forwardHeadlessAgentCompletion, setHeadlessAgentRunner, type HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { getAgentSessionWorkspacePath, getWorkspaceFilesDir } from './config-paths'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { AgentRuntimeContextStore } from './agent-runtime-context'

// ===== 实例创建 =====

const eventBus = new AgentEventBus()
const claudeAdapter = new ClaudeAgentAdapter()
const piAdapter = new PiAgentAdapter()
// Both runtimes remain behind the same orchestrator, credential gate, P0 lifecycle and Plan-mode boundary.
const adapter = new RuntimeRoutingAgentAdapter({ claude: claudeAdapter, pi: piAdapter })
const orchestrator = new AgentOrchestrator(adapter, eventBus)
const runtimeContextStore = new AgentRuntimeContextStore()

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }

/**
 * 返回当前活跃会话的运行时上下文窗口快照，供 Pocket 在首次连接/重连时水合。
 * 该数据不持久化，run_idle 到达后会立刻清除，避免向历史会话注入旧窗口。
 */
export function listActiveAgentRuntimeContexts(sessionIds?: readonly string[]) {
  return runtimeContextStore.list(sessionIds)
}

/**
 * 会话 → webContents 映射
 *
 * EventBus IPC 转发中间件通过此映射找到目标 webContents。
 * runAgent 开始时注册，结束时清理。
 */
const sessionWebContents = new Map<string, WebContents>()

/**
 * 当前活跃 run 的可回放事件。renderer 刷新会丢掉 Jotai 内存，但 main 中的
 * orchestrator 仍在运行；保存本轮已发出的事件可让新 renderer 重建相同 UI 状态。
 * 最终历史仍由 session JSONL 保存，故这里只保留 active run，结束立即释放。
 */
const activeStreamEventBacklogs = new Map<string, AgentStreamPayload[]>()

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册 sessionId → webContents 映射，并在 webContents 销毁时自动清理所有相关条目。
 *
 * 仅依赖 finally 块清理无法覆盖窗口关闭、渲染进程崩溃、headless 路径主窗口被替换等
 * webContents 提前销毁的场景——destroyed 事件兜底。
 */
export function registerWebContents(sessionId: string, wc: WebContents): void {
  // 同一 sessionId 切换 webContents 时直接覆盖；旧 wc 的 destroyed 钩子仍由 WeakSet 持有，
  // 触发时会扫描 sessionWebContents 清理所有指向旧 wc 的条目（见下方实现）。
  sessionWebContents.set(sessionId, wc)
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 单个 wc 可能映射到多个 sessionId（同窗口多 tab），需要清理所有指向它的条目
    for (const [sid, mappedWc] of sessionWebContents) {
      if (mappedWc === wc) sessionWebContents.delete(sid)
    }
  })
}

/**
 * 从 session → webContents 映射中移除指定会话。
 * 用于子会话 headless runner 完成后的清理，避免映射残留。
 */
export function unregisterWebContents(sessionId: string): void {
  sessionWebContents.delete(sessionId)
}

/**
 * renderer 刷新后的重连入口：先把当前 webContents 绑定为活跃 run 的接收方，
 * 再同步回放本轮事件。调用方必须先安装 STREAM_EVENT listener，避免回放丢失。
 */
export function restoreActiveAgentStreams(webContents: WebContents): string[] {
  const restored: string[] = []
  for (const [sessionId, backlog] of activeStreamEventBacklogs) {
    if (!orchestrator.isActive(sessionId)) continue
    registerWebContents(sessionId, webContents)
    restored.push(sessionId)
    for (const payload of backlog) {
      if (webContents.isDestroyed()) break
      webContents.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
    }
  }
  return restored
}

function isMainRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const url = win.webContents.getURL()
  if (!url) return false
  if (url.startsWith('data:')) return false
  return !url.includes('window=quick-task')
    && !url.includes('window=voice-dictation')
    && !url.includes('window=detached-preview')
}

export function getMainRendererWebContents(): WebContents | null {
  const win = BrowserWindow.getAllWindows().find(isMainRendererWindow)
  return win && !win.webContents.isDestroyed() ? win.webContents : null
}

// ===== EventBus IPC 转发中间件 =====

// 运行时上下文窗口是会话级状态，不应只依赖 Pocket 恰好在线时收到的瞬时事件。
// 在事件总线统一记录，覆盖桌面、远程、headless、Claude 与 Pi 的全部 Agent 入口。
eventBus.use((sessionId, payload, next) => {
  if (payload.kind === 'profer_event') {
    if (payload.event.type === 'context_window') {
      runtimeContextStore.setContextWindow(sessionId, payload.event.contextWindow)
    } else if (payload.event.type === 'run_idle') {
      runtimeContextStore.clear(sessionId)
    }
  }
  next()
})

// 必须先于 IPC 转发记录，确保刷新重连时能按原顺序回放所有已发生的实时事件。
eventBus.use((sessionId, payload, next) => {
  const backlog = activeStreamEventBacklogs.get(sessionId)
  if (backlog) backlog.push(payload)
  next()
})

eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)
  if (wc && !wc.isDestroyed()) {
    try {
      wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
    } catch (err) {
      console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
    }
  }
  next()
})

// ===== IPC 薄包装函数 =====

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Orchestrator。
 */
export async function runAgent(
  input: AgentSendInput,
  webContents: WebContents,
  onDraftPromoted?: (session: import('@profer/shared').AgentSessionMeta) => void | Promise<void>,
): Promise<void> {
  // 更新 webContents 映射（允许覆盖 — 由 orchestrator.activeSessions 处理真正的并发保护）
  registerWebContents(input.sessionId, webContents)
  // 被 active-run 并发保护拒绝的请求不能清空已有 run 的恢复记录。
  if (!orchestrator.isActive(input.sessionId)) activeStreamEventBacklogs.set(input.sessionId, [])
  // 开始新一轮执行时清除"完成未确认"标记
  try {
    updateAgentSessionMeta(input.sessionId, { completedButUnconfirmed: false })
  } catch { /* 新会话可能尚未写入索引 */ }
  try {
    await orchestrator.sendMessage(input, {
      onError: (error) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: input.sessionId,
            error,
          })
        }
      },
      onComplete: (messages, opts) => {
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
            sessionId: input.sessionId,
            messages,
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
            endReason: opts?.endReason,
            endReasonLabel: opts?.endReasonLabel,
          })
        }
      },
      onTitleUpdated: (title) => {
        eventBus.emit(input.sessionId, {
          kind: 'profer_event',
          event: { type: 'title_updated', title },
        })
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
      onRunStarted: async () => {
        const beforePromotion = getAgentSessionMeta(input.sessionId)
        const session = beforePromotion?.draft
          ? updateAgentSessionMeta(input.sessionId, { draft: false })
          : beforePromotion
        if (beforePromotion?.draft && session) {
          await onDraftPromoted?.(session)
          if (!webContents.isDestroyed()) {
            webContents.send(AGENT_IPC_CHANNELS.SESSION_UPDATED, { session })
          }
        }
      },
    })
  } catch (err) {
    console.error(`[Agent 服务] ══════════ runAgent 未处理异常 ══════════`)
    console.error(`[Agent 服务] sessionId: ${input.sessionId}`)
    console.error(`[Agent 服务] raw error 详细诊断:\n${serializeErrorDetail(err)}`)
    console.error(`[Agent 服务] err instanceof Error: ${err instanceof Error}`)
    console.error(`[Agent 服务] typeof err: ${typeof err}`)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    console.error(`[Agent 服务] errorMessage: ${errorMessage || '(空)'}`)
    console.error(`[Agent 服务] ══════════ runAgent 未处理异常 结束 ══════════`)
    if (!webContents.isDestroyed()) {
      webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId: input.sessionId,
        error: errorMessage,
      })
      webContents.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
        sessionId: input.sessionId,
        messages: [],
        stoppedByUser: false,
      })
    }
  } finally {
    // 仅在 orchestrator 已完成此会话时清理映射
    // 避免被拒绝的请求误删仍在运行的会话映射
    if (!orchestrator.isActive(input.sessionId)) {
      runtimeContextStore.clear(input.sessionId)
      sessionWebContents.delete(input.sessionId)
      activeStreamEventBacklogs.delete(input.sessionId)
    }
  }
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: HeadlessAgentRunCallbacks,
): Promise<void> {
  // 尝试注册主窗口 webContents，让流式事件同步推送到桌面端
  const wc = getMainRendererWebContents()
  const runInput: AgentSendInput = input.startedAt != null ? input : { ...input, startedAt: Date.now() }
  const startedAt = runInput.startedAt!
  if (wc) {
    registerWebContents(runInput.sessionId, wc)
  }
  // 同理：外部入口的重复请求不得覆盖仍在运行的会话快照。
  if (!orchestrator.isActive(runInput.sessionId)) activeStreamEventBacklogs.set(runInput.sessionId, [])

  try {
    await orchestrator.sendMessage(runInput, {
      onError: (error) => {
        callbacks.onError(error)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: runInput.sessionId,
            error,
          })
        }
      },
      onComplete: (messages, opts) => {
        forwardHeadlessAgentCompletion({
          callbacks,
          messages,
          opts,
          forwardToRenderer: (completionMessages, completionOpts) => {
            // 同步到渲染进程
            if (wc && !wc.isDestroyed()) {
              wc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
                sessionId: runInput.sessionId,
                messages: completionMessages,
                stoppedByUser: completionOpts?.stoppedByUser ?? false,
                startedAt: completionOpts?.startedAt,
                resultSubtype: completionOpts?.resultSubtype,
                resultErrors: completionOpts?.resultErrors,
                backgroundTasksPending: completionOpts?.backgroundTasksPending,
                endReason: completionOpts?.endReason,
                endReasonLabel: completionOpts?.endReasonLabel,
              })
            }
          },
        })
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        eventBus.emit(runInput.sessionId, {
          kind: 'profer_event',
          event: { type: 'title_updated', title },
        })
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onRunStarted: ({ startedAt: persistedStartedAt }) => {
        // draft 晋升（与 runAgent.onRunStarted 对齐）：对话真正开始后草稿会话转为正式，
        // 否则 ensureProjectDraftAgentSession 永远复用旧草稿——
        // 平板（runAgentHeadless 路径）点击项目将不会像桌面那样产生新对话（“点击项目仍指向刚才的对话”）。
        const beforePromotion = getAgentSessionMeta(runInput.sessionId)
        const session = beforePromotion?.draft
          ? updateAgentSessionMeta(runInput.sessionId, { draft: false })
          : beforePromotion
        if (beforePromotion?.draft && session && wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.SESSION_UPDATED, { session })
        }
        eventBus.emit(runInput.sessionId, {
          kind: 'profer_event',
          event: {
            type: 'external_run_started',
            source: callbacks.source ?? 'bridge',
            sessionId: runInput.sessionId,
            title: session?.title,
            workspaceId: runInput.workspaceId ?? session?.workspaceId,
            modelId: runInput.modelId,
            startedAt: persistedStartedAt,
            session,
          },
        })
      },
    })
  } catch (err) {
    console.error(`[Agent 服务] ══════════ runAgentHeadless 未处理异常 ══════════`)
    console.error(`[Agent 服务] sessionId: ${runInput.sessionId}`)
    console.error(`[Agent 服务] raw error 详细诊断:\n${serializeErrorDetail(err)}`)
    console.error(`[Agent 服务] err instanceof Error: ${err instanceof Error}`)
    console.error(`[Agent 服务] typeof err: ${typeof err}`)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    console.error(`[Agent 服务] errorMessage: ${errorMessage || '(空)'}`)
    console.error(`[Agent 服务] ══════════ runAgentHeadless 未处理异常 结束 ══════════`)
    callbacks.onError(errorMessage)
    const completion = { stoppedByUser: false, startedAt, endReason: 'error' as const, endReasonLabel: '执行出错' }
    callbacks.onComplete([], completion)
    if (wc && !wc.isDestroyed()) {
      wc.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId: runInput.sessionId, error: errorMessage })
      wc.send(AGENT_IPC_CHANNELS.STREAM_COMPLETE, { sessionId: runInput.sessionId, messages: [], ...completion })
    }
  } finally {
    if (!orchestrator.isActive(runInput.sessionId)) {
      runtimeContextStore.clear(runInput.sessionId)
      sessionWebContents.delete(runInput.sessionId)
      activeStreamEventBacklogs.delete(runInput.sessionId)
    }
  }
}

// headless run 的渲染进程 completion 必须与普通桌面 run 走同一 service 转发，
// 不能由协作层另行构造字段不完整的 STREAM_COMPLETE。
setHeadlessAgentRunner((input, callbacks) => runAgentHeadless(input, callbacks))

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return orchestrator.generateTitle(input)
}

/**
 * 中止指定会话的 Agent 执行
 */
export function stopAgent(sessionId: string): void {
  orchestrator.stop(sessionId)
}

export function getAgentRuntimeCapabilities(runtime: import('@profer/shared').AgentRuntime): import('@profer/shared').AgentRuntimeCapabilities {
  return adapter.getRuntimeCapabilities(runtime)
}

export function getAgentTaskOutput(sessionId: string, taskId: string, options?: { block?: boolean; timeoutMs?: number }): Promise<import('@profer/shared').GetTaskOutputResult> {
  return adapter.getTaskOutput(sessionId, taskId, options)
}

export async function stopAgentTask(sessionId: string, taskId: string, type?: 'agent' | 'shell'): Promise<void> {
  // SDK 后台任务（包含 shell）必须由产生它的 runtime adapter 停止；Pi 没有
  // Claude Task API 等价物时由 adapter 明确拒绝。长期 Pi 服务进程继续使用
  // KILL_PROCESS 的 ownership registry + PID/startTime 双因子路径，避免把不同
  // 命名空间的 taskId 与服务记录 id 错配后误杀进程。
  await adapter.stopTask(sessionId, taskId, type)
}

/** 删除运行中会话前停止并等待其真实运行生命周期结束。 */
export async function stopAgentAndWait(sessionId: string): Promise<void> {
  await orchestrator.stopAndWait(sessionId)
}

/** 标记/解除会话删除锁，覆盖 UI、队列和 headless 等所有编排入口。 */
export function beginAgentSessionDeletion(sessionId: string): void {
  orchestrator.beginDeletion(sessionId)
}

export function endAgentSessionDeletion(sessionId: string): void {
  orchestrator.endDeletion(sessionId)
}

/**
 * 快照回退：回退到指定消息点，恢复文件 + 截断对话
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<import('@profer/shared').RewindSessionResult> {
  return orchestrator.rewindSession(sessionId, assistantMessageUuid)
}

/**
 * 检查指定会话是否正在运行
 */
export function isAgentSessionActive(sessionId: string): boolean {
  return orchestrator.isActive(sessionId)
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  orchestrator.stopAll()
}

/**
 * 退出前最后兜底：扫描并强杀所有孤儿 claude-agent-sdk 子进程
 *
 * 必须在 stopAllAgents() 之后调用。针对 pidMap 未覆盖、dispose 漏杀等极端场景。
 * 同步执行，不 await，确保 before-quit 能在 Electron 超时前完成。
 */
export function killOrphanedClaudeSubprocesses(): void {
  scanAndKillOrphanedClaudeSubprocesses()
}

/**
 * 运行中动态切换会话的权限模式
 *
 * 同时更新 Profer 侧（canUseTool 动态读取）和 SDK 侧（query.setPermissionMode）。
 */
export async function updateAgentPermissionMode(sessionId: string, mode: ProferPermissionMode): Promise<void> {
  await orchestrator.updateSessionPermissionMode(sessionId, mode)
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  return orchestrator.queueMessage(
    input.sessionId,
    input.userMessage,
    input.rawUserMessage,
    undefined,
    input.uuid,
    { interrupt: input.interrupt },
    input.mentionedSkills,
    input.mentionedMcpServers,
    input.mentionedSessionIds,
  )
}

// ===== 文件操作 =====

/**
 * 保存文件到 Agent session 工作目录
 *
 * 将 base64 编码的文件写入 session 的 cwd，供 Agent 通过 Read 工具读取。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    // 防御：文件名不能包含路径分隔符、.. 或为绝对路径，防止路径穿越
    const safeFilename = basename(file.filename)
    if (safeFilename !== file.filename || safeFilename === '..' || file.filename.includes(sep) || file.filename.includes('/')) {
      console.warn(`[Agent 服务] 文件名包含非法路径字符，已净化: ${file.filename} → ${safeFilename}`)
    }
    let targetPath = join(sessionDir, safeFilename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    // 防御性检查：base64 字符串长度估算是否超 100MB 限制
    // base64 编码膨胀率约 4/3，data.length * 0.75 ≈ 原始字节数
    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/**
 * 保存文件到工作区文件目录
 *
 * 将 base64 编码的文件写入工作区 workspace-files/ 目录，所有会话均可访问。
 */
export function saveFilesToWorkspaceFiles(input: AgentSaveWorkspaceFilesInput): AgentSavedFile[] {
  const wsFilesDir = getWorkspaceFilesDir(input.workspaceSlug)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    // 防御：文件名不能包含路径分隔符、.. 或为绝对路径，防止路径穿越
    const safeFilename = basename(file.filename)
    if (safeFilename !== file.filename || safeFilename === '..' || file.filename.includes(sep) || file.filename.includes('/')) {
      console.warn(`[Agent 服务] 工作区文件名包含非法路径字符，已净化: ${file.filename} → ${safeFilename}`)
    }
    let targetPath = join(wsFilesDir, safeFilename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = safeFilename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? safeFilename.slice(0, dotIdx) : safeFilename
      const ext = dotIdx > 0 ? safeFilename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(wsFilesDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(wsFilesDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    const buffer = typeof file.data === 'string'
      ? Buffer.from(file.data, 'base64')
      : Buffer.from(file.data)

    if (buffer.length > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 工作区文件超过 100MB 限制，跳过: ${file.filename} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(wsFilesDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}
