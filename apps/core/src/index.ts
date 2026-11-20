import { closeCoreServer, createCoreServer, listenCoreServer } from './server'
import { parseCoreConfig } from './config'
import { createCoreAgentRuntime } from './runtime'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = '0.1.2'
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
  const config = parseCoreConfig({ argv })
  const coreId = stableCoreId(config.configDir, config.coreId)
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1' && !config.apiKey) {
    throw new Error('PROFER_CORE_API_KEY is required when listening on a non-loopback address')
  }
  const runtime = createCoreAgentRuntime({ ...config, coreId })
  const startedAt = Date.now()
  const server = createCoreServer({
    version: VERSION, runtime, apiKey: config.apiKey, coreId,
    ...(config.debug ? { debug: { configDir: config.configDir, workspaceRoot: config.workspaceRoot, mockAgent: config.mockAgent === true, startedAt } } : {}),
  })

  let shutdownPromise: Promise<void> | undefined
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise
    process.stdout.write(`[Core] 收到 ${signal}，正在关闭\n`)
    shutdownPromise = (async () => {
      await closeCoreServer(server)
      await runtime.shutdown()
    })()
    return shutdownPromise
  }
  const onSignal = (signal: string): void => {
    void shutdown(signal).then(() => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      process.exitCode = 0
    }).catch((error: unknown) => {
      console.error('[Core] 关闭失败', error)
      process.exitCode = 1
    })
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await listenCoreServer(server, config.host, config.port)
  } catch (error) {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    runtime.dispose()
    throw error
  }

  process.stdout.write(`[Core] listening on http://${config.host}:${config.port}\n`)
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
