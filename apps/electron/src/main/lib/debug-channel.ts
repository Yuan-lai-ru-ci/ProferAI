/**
 * 开发版调试通道（自动调试入口 V0）。
 *
 * 为什么需要它：回退这类操作的真实效果只有「主进程跑一遍」才看得见——会话截断要动
 * 内存里的 SDK 消息与 resume 边界，文件回退要走采集队列。靠点界面验证既不可重复，
 * 也没法交给自动化。这里给本地工具（脚本、未来的自动调试器）一条最小可控的入口。
 *
 * 安全边界（缺一不可）：
 * - 只在 `!app.isPackaged` 时启动，打包版没有这段代码；
 * - 只监听 127.0.0.1，不随 remote-service 暴露到局域网；
 * - 每次启动生成随机 token，写入 `<configDir>/debug-channel.json`（0600），
 *   请求必须带 `x-profer-debug-token`；token 每次重启都换；
 * - 路径白名单，没有任意文件读写、没有任意命令执行。
 *
 * 刻意不做成 MCP：这条通道是「本机进程 → 运行中的 dev 实例」，不依赖 Agent 运行时；
 * 等无障碍自动调试落地后，它再决定是否升级成正式协议。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeAgentRuntime, type AgentSendInput, type ProferPermissionMode, type RewindMode, type RewindTarget } from '@profer/shared'
import { readShadowTurnAttributions } from '@profer/session-store'
import { app } from 'electron'
import { createAgentSession, getAgentSessionMeta, listAgentSessions, updateAgentSessionMeta } from './agent-session-manager'
import { runAgentHeadless } from './agent-service'
import { executeAgentRewind, prepareAgentRewind, type RewindCaller } from './agent-rewind-gateway'
import { getConfigDir } from './config-root'
import { getWorkspaceShadowDir } from './workspace-shadow-git'
import { restoreWorkspaceShadowTurn } from './workspace-shadow-restore'

const PORT = 7791
const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 64 * 1024
/**
 * 调试通道就在本机上，语义等同桌面自己动手（不是远程设备），因此用 desktop 调用方：
 * 文件回退在远程路径上需要额外授权，绕过去不如用对身份。
 */
const CALLER: RewindCaller = { kind: 'desktop' }

let server: Server | null = null
let token = ''

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`缺少 ${field}`)
  return value
}

function parseTarget(value: unknown): RewindTarget {
  if (!value || typeof value !== 'object') throw new Error('缺少 target')
  const target = value as Record<string, unknown>
  if (target.kind === 'session-start') return { kind: 'session-start' }
  if (target.kind === 'message') return { kind: 'message', messageUuid: requireString(target.messageUuid, 'target.messageUuid') }
  if (target.kind === 'before-turn' || target.kind === 'after-turn') {
    return { kind: target.kind, turnId: requireString(target.turnId, 'target.turnId') }
  }
  throw new Error('target.kind 无效')
}

function parseMode(value: unknown): RewindMode {
  if (value === undefined) return 'both'
  if (value === 'conversation' || value === 'files' || value === 'both') return value
  throw new Error('mode 无效')
}

/**
 * 读一个会话的归属记录。
 *
 * 早期会话的 `workspaceId` 是 `default` 这类非 uuid 旧标识，目录名校验会拒绝；
 * 这类会话本来就没有工作区历史，当成「没有记录」而不是让整张列表 500。
 */
function shadowRecords(workspaceId: string | undefined, sessionId: string) {
  if (!workspaceId) return []
  try {
    return readShadowTurnAttributions(getWorkspaceShadowDir(workspaceId), { sessionId })
  } catch {
    return []
  }
}

/** 会话列表：带上该会话在工作区历史里有多少轮记录，方便自动化挑目标。 */
function listSessions() {
  return listAgentSessions(true).map((session) => {
    const workspaceId = session.workspaceId
    const records = shadowRecords(workspaceId, session.id)
    return {
      id: session.id,
      title: session.title,
      workspaceId,
      runtime: session.agentRuntime,
      updatedAt: session.updatedAt,
      shadowTurns: records.length,
      lastTurnId: records.at(-1)?.turnId,
      lastTurnChanges: records.at(-1)?.changes.length ?? 0,
    }
  }).filter((session) => session.shadowTurns > 0)
}

function attributionsFor(sessionId: string) {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta?.workspaceId) throw new Error('会话不存在或没有绑定工作区')
  const records = shadowRecords(meta.workspaceId, sessionId)
  return {
    sessionId,
    workspaceId: meta.workspaceId,
    turns: records.map((record) => ({
      turnId: record.turnId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      turnIdSource: record.turnIdSource,
      partial: record.partial === true,
      beforeCommitId: record.beforeCommitId,
      afterCommitId: record.afterCommitId,
      changes: record.changes.map((change) => ({
        path: change.path,
        absolutePath: change.absolutePath,
        status: change.status,
        attribution: change.attribution,
        rootIntroduced: change.rootIntroduced === true,
      })),
    })),
  }
}

async function handleRewind(body: Record<string, unknown>) {
  const sessionId = requireString(body.sessionId, 'sessionId')
  const target = parseTarget(body.target)
  const mode = parseMode(body.mode)
  const prepared = await prepareAgentRewind({ sessionId, mode, target }, CALLER)
  if (body.execute !== true) {
    return { prepared: true, plan: prepared.plan }
  }
  const result = await executeAgentRewind(
    { sessionId, planId: prepared.plan.planId, expectedRevision: prepared.plan.revision },
    CALLER,
  )
  return { prepared: true, plan: prepared.plan, result }
}

/**
 * 建会话 + 发一条消息。
 *
 * 这是「自己完成验证」缺的最后一块：回退的真实效果需要一次真实的 Agent turn 才有
 * 可回退的边界；靠人手点一条消息，自动调试就没法跑。
 */
async function handleSend(body: Record<string, unknown>) {
  const sessionId = requireString(body.sessionId, 'sessionId')
  const userMessage = requireString(body.userMessage, 'userMessage')
  const channelId = requireString(body.channelId, 'channelId')
  const input: AgentSendInput = {
    sessionId,
    userMessage,
    channelId,
    startedAt: Date.now(),
    initiator: 'user',
    uuid: requireString(body.uuid ?? randomUUID(), 'uuid'),
    ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
    ...(typeof body.workspaceId === 'string' ? { workspaceId: body.workspaceId } : {}),
    // 无人值守入口必须显式给权限模式：automation 与飞书 bridge 都这么做，
    // 只有这里漏了，于是每次工具调用都停成「等待批准」，而 headless 没有界面可点。
    permissionModeOverride: (typeof body.permissionMode === 'string'
      ? body.permissionMode
      : 'bypassPermissions') as ProferPermissionMode,
  }
  // 不 await 整轮运行：谁来等由调用方按归属记录轮询决定，渠道卡住也不会挂住这个请求。
  void runAgentHeadless(input, {
    source: 'bridge',
    onError: (error) => console.warn('[Debug Channel] 运行失败:', error),
    onComplete: () => {},
    onTitleUpdated: () => {},
  })
  return { accepted: true, sessionId, uuid: input.uuid }
}

async function handleCreateSession(body: Record<string, unknown>) {
  const meta = createAgentSession(
    typeof body.title === 'string' ? body.title : '自动调试回退验证',
    requireString(body.channelId, 'channelId'),
    requireString(body.workspaceId, 'workspaceId'),
    typeof body.modelId === 'string' ? body.modelId : undefined,
    normalizeAgentRuntime(typeof body.runtime === 'string' ? body.runtime : undefined),
    false,
    undefined,
  )
  // 调试通道建出来的会话要能无人值守跑完一轮：默认权限模式下每次工具调用都在等
  // 「批准」，而 headless 没有界面可点，run 会一直挂在那里（真实踩到过）。
  // 这里显式落一个权限模式；调用方仍可按需覆盖。
  const permissionMode = typeof body.permissionMode === 'string'
    ? body.permissionMode as ProferPermissionMode
    : 'bypassPermissions' as ProferPermissionMode
  updateAgentSessionMeta(meta.id, { permissionMode })
  return { sessionId: meta.id, workspaceId: meta.workspaceId, runtime: meta.agentRuntime, permissionMode }
}

async function handleRestoreShadow(body: Record<string, unknown>) {
  return restoreWorkspaceShadowTurn({
    workspaceId: requireString(body.workspaceId, 'workspaceId'),
    sessionId: requireString(body.sessionId, 'sessionId'),
    turnId: requireString(body.turnId, 'turnId'),
    dryRun: body.dryRun === true,
  })
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${HOST}`)
  if (request.headers['x-profer-debug-token'] !== token) {
    send(response, 401, { ok: false, error: 'token 无效' })
    return
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    send(response, 200, { ok: true, pid: process.pid, packaged: app.isPackaged })
    return
  }
  if (request.method === 'GET' && url.pathname === '/sessions') {
    send(response, 200, { ok: true, sessions: listSessions() })
    return
  }
  if (request.method === 'GET' && url.pathname === '/attributions') {
    const sessionId = requireString(url.searchParams.get('sessionId'), 'sessionId')
    send(response, 200, { ok: true, ...attributionsFor(sessionId) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/rewind') {
    send(response, 200, { ok: true, ...(await handleRewind(await readJsonBody(request))) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/sessions') {
    send(response, 200, { ok: true, ...(await handleCreateSession(await readJsonBody(request))) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/send') {
    send(response, 200, { ok: true, ...(await handleSend(await readJsonBody(request))) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/restore-shadow') {
    // 结果自身带 ok（可能为 false），不要在外面再加一个会覆盖它的 ok。
    send(response, 200, await handleRestoreShadow(await readJsonBody(request)))
    return
  }
  send(response, 404, { ok: false, error: '未知路径' })
}

export function startDebugChannel(): void {
  // 打包版没有任何调试入口：这段代码在正式产物里不会执行。
  if (app.isPackaged || server) return
  token = randomBytes(24).toString('hex')
  server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[Debug Channel] 请求失败:', message)
      if (!response.headersSent) send(response, 400, { ok: false, error: message })
    })
  })
  server.on('error', (error) => {
    console.warn('[Debug Channel] 启动失败:', error.message)
    server = null
  })
  server.listen(PORT, HOST, () => {
    const file = join(getConfigDir(), 'debug-channel.json')
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ port: PORT, token, startedAt: Date.now(), pid: process.pid }), { mode: 0o600 })
      chmodSync(file, 0o600)
    } catch (error) {
      console.warn('[Debug Channel] 写入 token 文件失败:', error instanceof Error ? error.message : error)
    }
    console.log(`[Debug Channel] 已监听 http://${HOST}:${PORT}（token 见 ${file}）`)
  })
}

export function stopDebugChannel(): void {
  server?.close()
  server = null
}
