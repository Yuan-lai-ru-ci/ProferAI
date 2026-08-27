import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { getRuntimeProcessesPath } from './config-paths'
import { extractRequestedPort, listAliveProcesses, listPortPidMap, listProcessTree, type MonitoredProcess } from './process-monitor'

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
  const likelyService = isLongRunningServiceCommand(command)
  // 只登记长期运行的服务命令；短命令/工具命令（git diff、测试等）不进登记表、不落盘、不调度巡检。
  if (!likelyService) return undefined
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
  // 低频巡检：不随每次命令立即扫描，统一由 30s 全局巡检确认服务进程；
  // 无活跃记录时巡检自动停止，新登记会重新唤醒。
  scheduleInspection()
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

/**
 * 低频全局巡检（30s 节奏）。相比旧实现（每命令 2s 后全量 OS 快照 ×3 轮），
 * 本巡检：
 *  - 只处理登记过的服务记录，不扫全系统；
 *  - pending 匹配走 shellPid 子进程树遍历（每次 ~几十 ms）；
 *  - 已确认记录只做批量单点存活校验（~20ms/批）；
 *  - 端口证据仅在命令含显式端口时按需查询，且一次调用合并所有需要端口的记录。
 */
const INSPECT_INTERVAL_MS = 30_000
let inspectTimer: ReturnType<typeof setTimeout> | null = null
let inspectInFlight = false

function scheduleInspection(): void {
  if (inspectTimer) return
  const timer = setTimeout(() => {
    inspectTimer = null
    void inspectOnce()
  }, INSPECT_INTERVAL_MS)
  // 不阻止进程退出：长会话期间孤儿定时器不应阻碍 Electron 收尾。
  if (typeof timer.ref === 'function' && typeof timer.unref === 'function') timer.unref()
  inspectTimer = timer
}

/**
 * 在 shellPid 子进程树内匹配 pending 记录（端口证据优先，其次树内命令关键字）。
 * 输入是 shell 的实际后代，不含全系统进程。
 */
export function matchRecordInTree(
  record: RuntimeProcessRecord,
  tree: Map<number, MonitoredProcess> | undefined,
  portMap: Map<number, number[]> | null,
): { pid: number; startTime?: number; ports: number[] } | undefined {
  if (!tree || tree.size === 0) return undefined
  const port = requestedPort(record.command)
  // 显式端口是最强的归属证据：其子命令可能不含项目路径，且避免误选同目录 wrapper。
  if (port !== undefined && portMap) {
    for (const pid of portMap.get(port) ?? []) {
      const info = tree.get(pid)
      if (info && compatible(record, { ...info, ports: [port] })) {
        return { pid, startTime: info.startTime, ports: [port] }
      }
    }
  }
  // 无显式端口（或端口未命中）：树内按 cwd 内的命令关键字匹配。
  const normPath = record.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const [pid, info] of tree) {
    if (pid === process.pid) continue
    const lowCmd = info.cmd.replace(/\\/g, '/').toLowerCase()
    if (!lowCmd.includes(normPath)) continue
    if (lowCmd.includes('claude-agent-sdk') && !lowCmd.includes(normPath)) continue
    if (compatible(record, { ...info, ports: [] })) {
      return { pid, startTime: info.startTime, ports: [] }
    }
  }
  return undefined
}

/**
 * 兼容导出（仅测试使用）：按共享全量快照匹配 pending 记录。
 * 运行路径已改用 matchRecordInTree（shellPid 子进程树，不扫全系统）；
 * 本函数保留纯函数形态供单测覆盖匹配语义，不参与巡检。
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
  // 无显式端口时退化为 cwd 内命令关键字匹配。
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

/** 单轮巡检：处理全部非 exited 记录，返回是否有变更。 */
async function inspectOnce(): Promise<void> {
  if (inspectInFlight) return
  inspectInFlight = true
  try {
    const data = load()
    const now = Date.now()
    let changed = false
    const changedSessions = new Set<string>()
    const active = data.records.filter((r) => r.status !== 'exited')
    const pendingServices = active.filter((r) => r.status === 'pending' && r.likelyService)
    const confirmed = active.filter((r) => r.status === 'running' && r.pid && r.startTime)

    // 1) pending 服务：按 shellPid 分组，每棵树一次遍历。
    if (pendingServices.length > 0) {
      const needPort = pendingServices.some((r) => requestedPort(r.command) !== undefined)
      const portMap = needPort ? await listPortPidMap() : null
      const trees = new Map<number, Map<number, MonitoredProcess>>()
      for (const rec of pendingServices) {
        const root = rec.shellPid
        if (!root) continue // 无 shellPid 无法树遍历，保持 pending 至超时清理
        if (!trees.has(root)) trees.set(root, await listProcessTree(root))
        const found = matchRecordInTree(rec, trees.get(root), portMap)
        if (found) {
          rec.pid = found.pid
          rec.startTime = found.startTime
          rec.ports = found.ports
          rec.status = 'running'
          rec.lastObservedAt = now
          changed = true
          changedSessions.add(rec.sessionId)
        }
      }
    }

    // 2) confirmed：批量单点存活校验；老版本误升级的非服务记录立即退役。
    if (confirmed.length > 0) {
      const alive = await listAliveProcesses(confirmed.map((r) => r.pid!))
      for (const rec of confirmed) {
        if (!rec.likelyService) {
          rec.status = 'exited'
          rec.lastObservedAt = now
          changed = true
          changedSessions.add(rec.sessionId)
          continue
        }
        const info = alive.get(rec.pid!)
        const same = info != null && typeof info.startTime === 'number' && Math.abs(info.startTime - rec.startTime!) < 2000
        if (same) {
          rec.lastObservedAt = now
        } else {
          rec.status = 'exited'
          rec.lastObservedAt = now
          changed = true
          changedSessions.add(rec.sessionId)
        }
      }
    }

    // 3) 过期清理（沿用既有窗口：exited 7 天、pending 非服务 60s、pending 服务 10min）。
    const kept = data.records.filter((r) => {
      if (r.status === 'exited') return now - r.lastObservedAt < 7 * 24 * 60 * 60 * 1000
      if (r.status === 'pending' && !r.likelyService) return now - r.launchedAt < 60_000
      if (r.status === 'pending') return now - r.launchedAt < 10 * 60 * 1000
      return true
    })
    if (kept.length !== data.records.length) {
      data.records = kept
      changed = true
    }

    if (changed) {
      save(data)
      for (const sid of changedSessions) emitChanged(sid)
    }
    // 仍有活跃记录 → 保持 30s 巡检节奏；全部退出/过期后停止，新登记会重新唤醒。
    if (data.records.some((r) => r.status !== 'exited')) scheduleInspection()
  } finally {
    inspectInFlight = false
  }
}

/** Refresh records using only their launch-time cwd and command evidence; never scans arbitrary directories. */
export async function listOwnedRuntimeProcesses(sessionId: string): Promise<RuntimeProcessRecord[]> {
  // 面板手动刷新 = 立即触发一轮巡检（防并发由 inspectInFlight 保证），再返回当前状态。
  await inspectOnce()
  const data = load()
  return data.records.filter((r) => r.sessionId === sessionId && r.status !== 'exited' && r.likelyService)
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
