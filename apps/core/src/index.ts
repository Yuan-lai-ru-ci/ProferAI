import { closeCoreServer, createCoreServer, listenCoreServer } from './server'
import { acquireCoreExecutionLock, acquireLocalCoreOwner, requireLocalCoreOwnerPlatform } from '@profer/session-store/execution-lock'
import { CoreConnectionHost } from './connection-host'
import { parseCoreConfig } from './config'
import { createCoreAgentRuntime } from './runtime'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = '0.1.7'
const CORE_ID_FILE = 'core-id'

function stableCoreId(configDir: string, configured?: string): string {
  if (configured?.trim()) return configured.trim()
  const path = join(configDir, CORE_ID_FILE)
  try { return readFileSync(path, 'utf8').trim() }
  catch {
    const id = randomUUID()
    mkdirSync(configDir, { recursive: true })
    writeFileSync(path, id, { mode: 0o600 })
    return id
  }
}

export async function startCore(argv = process.argv.slice(2)): Promise<void> {
  const independent = argv.includes('--desktop-independent')
  const config = parseCoreConfig({ argv })
  if (independent) {
    requireLocalCoreOwnerPlatform()
    if (config.host !== '127.0.0.1') throw new Error('独立本机 Core owner 必须监听 127.0.0.1')
    config.workspaceRoot = join(config.configDir, 'agent-workspaces')
    config.desktopWorkspaceIndexPath = join(config.configDir, 'agent-workspaces.json')
    config.desktopWorkspaceIndexWritable = true
    config.desktopAutomationTimeZone ??= Intl.DateTimeFormat().resolvedOptions().timeZone
    config.apiKey ??= randomUUID()
  }
  const owner = independent ? await acquireLocalCoreOwner(config.configDir, {
    runtimeDir: process.env.PROFER_CORE_RUNTIME_DIR,
    onLockLost: () => { console.error('[Core] 原生写锁丢失，立即停止 writer'); process.exit(1) },
  }) : undefined
  const release = owner ? () => owner.release() : acquireCoreExecutionLock(config.configDir)
  try { await startOwnedCore(config, release, independent, owner) }
  catch (error) { await release(); throw error }
}

async function startOwnedCore(config: ReturnType<typeof parseCoreConfig>, release: () => void | Promise<void>, independent: boolean, owner?: Awaited<ReturnType<typeof acquireLocalCoreOwner>>): Promise<void> {
  const coreId = stableCoreId(config.configDir, config.coreId)
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1' && !config.apiKey) {
    throw new Error('PROFER_CORE_API_KEY is required when listening on a non-loopback address')
  }
  const runtime = createCoreAgentRuntime({ ...config, coreId }, { independent })
  const startedAt = Date.now()
  let connection: CoreConnectionHost
  try { connection = await CoreConnectionHost.open(config.configDir, coreId, { version: VERSION, runtime, apiKey: config.apiKey, coreId }, independent ? () => finishShutdown('owner request') : undefined) }
  catch (error) { await runtime.shutdown(); throw error }
  const server = createCoreServer({
    connectionHandler: connection.handleOwner,
    version: VERSION, runtime, apiKey: config.apiKey, coreId,
    ...(config.debug ? { debug: { configDir: config.configDir, workspaceRoot: config.workspaceRoot, mockAgent: config.mockAgent === true, startedAt } } : {}),
  })

  let shutdownPromise: Promise<void> | undefined
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    process.stdout.write(`[Core] 收到 ${signal}，正在关闭\n`)
    shutdownPromise = (async () => {
      try { await owner?.remove() } catch (error) { console.error('[Core] 无法撤下本机连接文件', error) }
      await connection.close()
      await closeCoreServer(server)
      await runtime.shutdown()
      await release()
    })()
    return shutdownPromise
  }
  function finishShutdown(signal: string): void {
    void shutdown(signal).then(() => {
      process.removeListener('SIGINT', finishShutdown)
      process.removeListener('SIGTERM', finishShutdown)
      process.exitCode = 0
    }).catch((error: unknown) => {
      console.error('[Core] 关闭失败', error)
      process.exitCode = 1
    })
  }

  process.on('SIGINT', finishShutdown)
  process.on('SIGTERM', finishShutdown)

  let boundPort = config.port
  try {
    await listenCoreServer(server, config.host, config.port)
    const address = server.address()
    if (address && typeof address !== 'string') boundPort = address.port
    if (independent && !shutdownPromise) await owner!.publish({ version: 1, pid: process.pid, port: boundPort, coreId, token: config.apiKey! })
  } catch (error) {
    process.removeListener('SIGINT', finishShutdown)
    process.removeListener('SIGTERM', finishShutdown)
    await connection.close()
    await closeCoreServer(server)
    await runtime.shutdown()
    throw error
  }

  process.stdout.write(`[Core] listening on http://${config.host}:${boundPort}\n`)
  process.stdout.write(`[Core] config directory: ${config.configDir}\n`)
  if (config.debug) {
    process.stdout.write('[Core] debug routes enabled: GET /debug/state, POST /debug/reset\n')
    if (config.mockAgent) process.stdout.write('[Core] mock agent enabled: replies are synthetic, no provider call\n')
  }
}

if (import.meta.main) {
  startCore().catch((error: unknown) => {
    console.error('[Core] failed to start', error)
    process.exitCode = 1
  })
}
