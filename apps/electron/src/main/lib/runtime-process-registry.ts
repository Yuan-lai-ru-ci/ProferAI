import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { getRuntimeProcessesPath } from './config-paths'
import { extractRequestedPort, isSameProcess, listPortPidMapWin, listProcessesWin, type MonitoredProcess } from './process-monitor'

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
  launcher: 'bash' | 'powershell'
  /** true when command matches a known long-running shape; unknown commands are still observed. */
  likelyService: boolean
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

const registryEvents = new EventEmitter()
export const RUNTIME_PROCESS_REGISTRY_CHANGED = 'runtime-process-registry-changed'
export function onRuntimeProcessRegistryChanged(listener: (sessionId: string) => void): () => void {
  registryEvents.on(RUNTIME_PROCESS_REGISTRY_CHANGED, listener)
  return () => registryEvents.off(RUNTIME_PROCESS_REGISTRY_CHANGED, listener)
}
function emitChanged(sessionId: string): void {
  registryEvents.emit(RUNTIME_PROCESS_REGISTRY_CHANGED, sessionId)
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
function normalizeShellWorkingDirectory(path: string): string | undefined {
  if (/^[a-z]:[\\/]/i.test(path)) return path
  // Git Bash exposes Windows drives as /d/project. Pi's BashSpawnHook reports
  // that form even when the actual child is a native Windows process.
  const gitBashDrivePath = path.match(/^\/([a-z])\/(.+)$/i)
  const [, drive, rest] = gitBashDrivePath ?? []
  return drive && rest ? `${drive.toUpperCase()}:/${rest}` : undefined
}

export function resolveServiceWorkingDirectory(command: string, fallbackCwd: string): string {
  // Bash commands often use `cd <project> && npm run dev`; Pi's tool cwd remains
  // the session directory, so capture the command's explicit project cwd instead.
  const match = command.match(/(?:^|[;&\n])\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*&&/i)
  const requested = match?.[1] ?? match?.[2] ?? match?.[3]
  return requested ? normalizeShellWorkingDirectory(requested) ?? fallbackCwd : fallbackCwd
}

export function registerPendingPiRuntimeProcess(
  sessionId: string,
  command: string,
  cwd: string,
  launcher: 'bash' | 'powershell' = 'bash',
  shellPid?: number,
): RuntimeProcessRecord | undefined {
  // All shell calls get a short-lived observation record. This prevents custom
  // scripts and unfamiliar frameworks from being invisible merely because they
  // are absent from a product-maintained command regexp.
  const likelyService = isLongRunningServiceCommand(command)
  const serviceCwd = resolveServiceWorkingDirectory(command, cwd)
  const data = load()
  const now = Date.now()
  // Avoid duplicate records caused by a retry or duplicate tool event in a short window.
  const existing = data.records.find((r) => r.sessionId === sessionId && r.command === command && r.cwd === serviceCwd && r.launcher === launcher
    && r.status !== 'exited' && now - r.launchedAt < 15_000)
  if (existing) {
    // A pre-spawn observation may already exist. Upgrade it as soon as Profer's
    // controlled launcher receives the real OS PID; do not create a duplicate.
    if (shellPid && existing.shellPid !== shellPid) {
      existing.shellPid = shellPid
      existing.lastObservedAt = now
      save(data)
      emitChanged(sessionId)
    }
    return existing
  }
  const record: RuntimeProcessRecord = {
    id: randomUUID(), sessionId, runtime: 'pi', source: 'pi-owned', launcher, likelyService, command, cwd: serviceCwd,
    ports: [], launchedAt: now, lastObservedAt: now, status: 'pending',
    ...(shellPid && { shellPid }),
  }
  data.records.push(record)
  save(data)
  emitChanged(sessionId)
  // A follow-up observation catches detached/nohup children even when the user
  // never opens the panel at precisely the right moment. Scheduling is coalesced
  // per session: high-frequency bash calls during a run create many observations
  // in a short window, but each is a full OS process scan (multiple PowerShell
  // queries). A single debounced timer per session refreshes all pending records
  // in one pass instead of launching N concurrent scans.
  scheduleNextObservation(sessionId)
  return record
}

/**
 * Records a PID obtained directly from Profer's own shell spawn. This is launch
 * evidence, not yet the managed service PID: package managers and `nohup &`
 * frequently fork the eventual listener, so the normal observer still confirms
 * `{pid,startTime,ports}` before enabling termination.
 */
export function registerPiRuntimeProcessShell(
  sessionId: string,
  command: string,
  cwd: string,
  shellPid: number,
  launcher: 'bash' | 'powershell' = 'bash',
): RuntimeProcessRecord | undefined {
  return registerPendingPiRuntimeProcess(sessionId, command, cwd, launcher, shellPid)
}

function commandTokens(command: string): string[] {
  return command.toLowerCase().split(/[^a-z0-9_-]+/).filter((token) => token.length >= 3)
    .filter((token) => !['npm', 'pnpm', 'yarn', 'bun', 'run'].includes(token)).slice(0, 4)
}

function requestedPort(command: string): number | undefined {
  // 统一走 process-monitor 的健壮端口提取（锚定 + 范围校验），避免两处端口解析策略分叉。
  return extractRequestedPort(command)
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

/** 每个 sessionId 的合并观测定时器；同一会话短窗口内多次登记只复用一个 timer。 */
const observationTimers = new Map<string, ReturnType<typeof setTimeout>>()
const OBSERVE_DELAY_MS = 2_000
/** 单次调度的最大追踪轮次，防止 pending 迟迟不确认时无限自续（不会并发，是串行节流）。 */
const MAX_TRACK_ATTEMPTS = 6

/**
 * 合并调度一次会话观测：同一 sessionId 的 pending 定时器幂等（短窗口内的
 * 多个 spawn 只触发一轮扫描）。timer 触发时一次性刷新该会话所有 pending 记录。
 * 若扫描后仍有未确认的 pending 记录，则有限次数地自续追踪（confirmed/likelyService
 * 才有必要跟踪 detached/nohup 子进程；纯短命令会被 60s 窗口自动清理）。
 */
function scheduleNextObservation(sessionId: string, tracks = 0): void {
  const existing = observationTimers.get(sessionId)
  if (existing) return // already scheduled; coalesce into the pending pass
  const timer = setTimeout(async () => {
    observationTimers.delete(sessionId)
    try {
      const pending = await listOwnedRuntimeProcesses(sessionId)
      // 只要还有未确认的服务型记录就继续有限追踪，捕获 detached/nohup 子进程。
      const stillTracking = pending.some((r) => r.status === 'pending' && r.likelyService)
      if (stillTracking && tracks + 1 < MAX_TRACK_ATTEMPTS) {
        scheduleNextObservation(sessionId, tracks + 1)
      }
    } catch {
      // 观测失败不抛：不注册表崩溃，也不影响后续手动刷新。
    }
  }, OBSERVE_DELAY_MS)
  // 不阻止进程退出，避免长会话期间的孤儿定时器阻碍 Electron 收尾。
  if (typeof timer.ref === 'function' && typeof timer.unref === 'function') timer.unref()
  observationTimers.set(sessionId, timer)
}

/**
 * 把一条 pending 记录与共享的 OS 进程快照匹配（端口证据优先，其次 cwd 内命令关键字）。
 * @param portPids  本次调用共享的「端口 → 监听 pid」映射（避免逐记录重复查询）
 * @param processes 本次调用共享的「pid → name/cmd/startTime」全量映射
 */
export function matchRecordAgainstSnapshot(
  record: RuntimeProcessRecord,
  portPids: Map<number, number[]>,
  processes: Map<number, { name: string; cmd: string; startTime?: number }>,
): { pid: number; startTime?: number; ports: number[] } | undefined {
  const port = requestedPort(record.command)
  // 显式端口是最强的归属证据：其子命令可能不含项目路径，且避免误选同目录 wrapper。
  if (port !== undefined) {
    for (const pid of portPids.get(port) ?? []) {
      const info = processes.get(pid)
      if (info && compatible(record, { pid, ...info, ports: [port] })) {
        return { pid, startTime: info.startTime, ports: [port] }
      }
    }
    return undefined
  }
  // 无显式端口时退化为 cwd 内命令关键字匹配（等价于按会话工作目录枚举，但复用共享快照）。
  const normPath = record.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const [pid, info] of processes) {
    if (pid === process.pid) continue // 排除本应用自身进程，避免噪音
    const lowCmd = info.cmd.replace(/\\/g, '/').toLowerCase()
    if (!lowCmd.includes(normPath)) continue
    if (lowCmd.includes('claude-agent-sdk') && !lowCmd.includes(normPath)) continue
    if (compatible(record, { pid, ...info, ports: [] })) {
      return { pid, startTime: info.startTime, ports: [] }
    }
  }
  return undefined
}

/** Refresh records using only their launch-time cwd and command evidence; never scans arbitrary directories. */
export async function listOwnedRuntimeProcesses(sessionId: string): Promise<RuntimeProcessRecord[]> {
  const data = load()
  const now = Date.now()
  const pending = data.records.filter(
    (r) => r.sessionId === sessionId && r.status !== 'exited',
  ).filter((r) => !(r.pid && r.startTime))
  // 已确认 pid 的记录：只做双因子防转世校验（单条 PowerShell/记录，无法合并）。
  const confirmed = data.records.filter((r) => r.sessionId === sessionId && r.pid && r.startTime && r.status !== 'exited')
  let changed = false

  // 尚未定位到 pid 的记录：一次性拉取共享快照（端口表 + 全量进程表），在 JS 内过滤。
  if (pending.length > 0) {
    const [portPids, processes] = await Promise.all([listPortPidMapWin(), listProcessesWin()])
    for (const record of pending) {
      const found = matchRecordAgainstSnapshot(record, portPids, processes)
      if (found) {
        record.pid = found.pid
        record.startTime = found.startTime
        record.ports = found.ports
        record.status = 'running'
        record.lastObservedAt = now
        changed = true
      }
    }
  }

  // 已确认 pid 且仍健在的记录：双因子校验通过则跳过；失效的收集后统一重匹配。
  // 先批量做 isSameProcess，再把所有失效记录用「一次共享快照」重匹配，避免多条失效
  // 记录各自拉一遍全量 PowerShell 快照（并发扩倍）。
  const deadOnes: { record: RuntimeProcessRecord }[] = []
  for (const record of confirmed) {
    if (await isSameProcess(record.pid!, record.startTime)) {
      record.lastObservedAt = now
    } else {
      deadOnes.push({ record })
    }
  }
  if (deadOnes.length > 0) {
    const [portPids, processes] = await Promise.all([listPortPidMapWin(), listProcessesWin()])
    for (const { record } of deadOnes) {
      const refound = matchRecordAgainstSnapshot(record, portPids, processes)
      if (refound) {
        record.pid = refound.pid
        record.startTime = refound.startTime
        record.ports = refound.ports
        record.status = 'running'
        record.lastObservedAt = now
        changed = true
      } else {
        record.status = 'exited'
        record.lastObservedAt = now
        changed = true
      }
    }
  }

  // Unknown/short commands are observations, not permanent UI clutter. Known
  // service commands get a longer window because they may daemonize slowly.
  const kept = data.records.filter((r) => {
    if (r.status === 'exited') return now - r.lastObservedAt < 7 * 24 * 60 * 60 * 1000
    if (r.status === 'pending' && !r.likelyService) return now - r.launchedAt < 60_000
    if (r.status === 'pending') return now - r.launchedAt < 10 * 60 * 1000
    return true
  })
  if (kept.length !== data.records.length) { data.records = kept; changed = true }
  if (changed) {
    save(data)
    emitChanged(sessionId)
  }
  return data.records.filter((r) => r.sessionId === sessionId && r.status !== 'exited')
}

export function markOwnedRuntimeProcessExited(sessionId: string, pid: number, startTime?: number): void {
  const data = load()
  const record = data.records.find((r) => r.sessionId === sessionId && r.pid === pid && r.startTime === startTime && r.status !== 'exited')
  if (!record) return
  record.status = 'exited'
  record.lastObservedAt = Date.now()
  save(data)
  emitChanged(sessionId)
}
