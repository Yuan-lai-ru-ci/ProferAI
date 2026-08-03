import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { getRuntimeProcessesPath } from './config-paths'
import { isSameProcess, listPortPidMapWin, listProcessesWin, listSessionDirProcesses, type MonitoredProcess } from './process-monitor'

/**
 * Persisted ownership records for long-running services launched by a runtime.
 * A record is created at the shell launch point, never inferred from arbitrary
 * renderer input. PID is filled only when a later OS observation is compatible
 * with the recorded command/cwd/time window.
 */
export interface RuntimeProcessRecord {
  id: string
  sessionId: string
  runtime: 'pi'
  source: 'pi-owned'
  command: string
  cwd: string
  shellPid?: number
  pid?: number
  startTime?: number
  ports: number[]
  launchedAt: number
  lastObservedAt: number
  status: 'pending' | 'running' | 'exited'
}

interface RegistryFile {
  version: 1
  records: RuntimeProcessRecord[]
}

function load(): RegistryFile {
  const path = getRuntimeProcessesPath()
  try {
    if (!existsSync(path)) return { version: 1, records: [] }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RegistryFile>
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records.filter(isRecord) : [],
    }
  } catch {
    return { version: 1, records: [] }
  }
}

function isRecord(value: unknown): value is RuntimeProcessRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Partial<RuntimeProcessRecord>
  return typeof r.id === 'string' && typeof r.sessionId === 'string' && r.runtime === 'pi'
    && r.source === 'pi-owned' && typeof r.command === 'string' && typeof r.cwd === 'string'
    && typeof r.launchedAt === 'number' && Array.isArray(r.ports)
}

function save(data: RegistryFile): void {
  const path = getRuntimeProcessesPath()
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(temp, path)
  } finally {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* best effort */ }
  }
}

/** Conservative long-running service classifier: short shell commands never enter the registry. */
export function isLongRunningServiceCommand(command: string): boolean {
  const c = command.toLowerCase()
  return /\b(?:astro|vite|next|nuxt|webpack|parcel)\s+(?:dev|serve)\b/.test(c)
    || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|serve|start|watch)\b/.test(c)
    || /\b(?:nodemon|ts-node-dev|docker\s+compose\s+up)\b/.test(c)
}

/** Called synchronously from Pi's public BashSpawnHook, before Pi creates the shell. */
export function resolveServiceWorkingDirectory(command: string, fallbackCwd: string): string {
  // Bash commands often use `cd <project> && npm run dev`; Pi's tool cwd remains
  // the session directory, so capture the command's explicit project cwd instead.
  const match = command.match(/(?:^|[;&\n])\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*&&/i)
  const requested = match?.[1] ?? match?.[2] ?? match?.[3]
  return requested && /^[a-z]:[\\/]/i.test(requested) ? requested : fallbackCwd
}

export function registerPendingPiRuntimeProcess(sessionId: string, command: string, cwd: string): RuntimeProcessRecord | undefined {
  if (!isLongRunningServiceCommand(command)) return undefined
  const serviceCwd = resolveServiceWorkingDirectory(command, cwd)
  const data = load()
  const now = Date.now()
  // Avoid duplicate records caused by a retry or duplicate tool event in a short window.
  const existing = data.records.find((r) => r.sessionId === sessionId && r.command === command && r.cwd === serviceCwd
    && r.status !== 'exited' && now - r.launchedAt < 15_000)
  if (existing) return existing
  const record: RuntimeProcessRecord = {
    id: randomUUID(), sessionId, runtime: 'pi', source: 'pi-owned', command, cwd: serviceCwd,
    ports: [], launchedAt: now, lastObservedAt: now, status: 'pending',
  }
  data.records.push(record)
  save(data)
  return record
}

function commandTokens(command: string): string[] {
  return command.toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => token.length >= 3)
    .filter((token) => !['npm', 'pnpm', 'yarn', 'bun', 'run'].includes(token)).slice(0, 4)
}

function requestedPort(command: string): number | undefined {
  const match = command.match(/(?:--port|-p)\s+(\d{2,5})\b/i)
  const port = match ? Number(match[1]) : undefined
  return port && port > 0 && port <= 65535 ? port : undefined
}

function compatible(record: RuntimeProcessRecord, process: MonitoredProcess): boolean {
  if (process.startTime && process.startTime < record.launchedAt - 3_000) return false
  const port = requestedPort(record.command)
  // An explicit port is stronger evidence than wrapper command text: Astro/Vite
  // may replace the invoked CLI with a node child whose command line lacks `astro`.
  if (port && process.ports.includes(port)) return true
  const cmd = process.cmd.toLowerCase()
  const tokens = commandTokens(record.command)
  return tokens.length === 0 || tokens.some((token) => cmd.includes(token))
}

/** Refresh records using only their launch-time cwd and command evidence; never scans arbitrary directories. */
export async function listOwnedRuntimeProcesses(sessionId: string): Promise<RuntimeProcessRecord[]> {
  const data = load()
  const now = Date.now()
  let changed = false
  for (const record of data.records.filter((r) => r.sessionId === sessionId && r.status !== 'exited')) {
    if (record.pid && record.startTime && await isSameProcess(record.pid, record.startTime)) {
      record.lastObservedAt = now
      continue
    }
    const [candidates, portPids, processes] = await Promise.all([
      listSessionDirProcesses(record.cwd), listPortPidMapWin(), listProcessesWin(),
    ])
    const port = requestedPort(record.command)
    // A listener on the explicitly requested port is direct ownership evidence.
    // Its child command may not contain the project path, so obtain it from the
    // global PID map instead of accidentally selecting a same-directory wrapper.
    const listener = port === undefined ? undefined : (portPids.get(port) ?? [])
      .map((pid) => {
        const info = processes.get(pid)
        return info ? { pid, ...info, ports: [port] } satisfies MonitoredProcess : undefined
      })
      .find((p): p is MonitoredProcess => p !== undefined && compatible(record, p))
    // If the caller requested a port, do not fall back to fuzzy command matches:
    // a concurrently running agent command can contain the same tokens.
    const found = port === undefined ? candidates.find((p) => compatible(record, p)) : listener
    if (found) {
      record.pid = found.pid
      record.startTime = found.startTime
      record.ports = found.ports
      record.status = 'running'
      record.lastObservedAt = now
      changed = true
    } else if (record.pid) {
      record.status = 'exited'
      record.lastObservedAt = now
      changed = true
    }
  }
  // pending records are retained for 10 minutes: services sometimes daemonize after a shell exits.
  const kept = data.records.filter((r) => r.status !== 'exited' || now - r.lastObservedAt < 7 * 24 * 60 * 60 * 1000)
  if (kept.length !== data.records.length) { data.records = kept; changed = true }
  if (changed) save(data)
  return data.records.filter((r) => r.sessionId === sessionId && r.status !== 'exited')
}

export function markOwnedRuntimeProcessExited(sessionId: string, pid: number, startTime?: number): void {
  const data = load()
  const record = data.records.find((r) => r.sessionId === sessionId && r.pid === pid && r.startTime === startTime && r.status !== 'exited')
  if (!record) return
  record.status = 'exited'
  record.lastObservedAt = Date.now()
  save(data)
}
