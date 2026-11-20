import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 8_000
const MAX_BUFFER = 16 * 1024 * 1024

export interface PosixProcessInfo {
  pid: number
  ppid: number
  name: string
  cmd: string
  startTime?: number
}

export interface PosixSnapshot {
  portPids: Map<number, number[]>
  processes: Map<number, PosixProcessInfo>
}

/** Parse `ps -axo pid=,ppid=,lstart=,comm=,args=` output. */
export function parsePsOutput(output: string): PosixProcessInfo[] {
  const result: PosixProcessInfo[] = []
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    // pid, ppid, five lstart fields, comm, args...
    if (fields.length < 8) continue
    const pid = Number(fields[0])
    const ppid = Number(fields[1])
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue
    const startTime = Date.parse(fields.slice(2, 7).join(' '))
    const name = fields[7] ?? ''
    const cmd = fields.slice(8).join(' ') || name
    result.push({
      pid,
      ppid,
      name,
      cmd,
      ...(Number.isNaN(startTime) ? {} : { startTime }),
    })
  }
  return result
}

/** Parse `lsof -F pnPc` output into a port-to-PID map. */
export function parseLsofListenOutput(output: string): Map<number, number[]> {
  const result = new Map<number, number[]>()
  let pid: number | undefined
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1))
      pid = Number.isInteger(value) && value > 0 ? value : undefined
      continue
    }
    if (!line.startsWith('n') || pid === undefined) continue
    const match = line.match(/:(\d+)(?:\s|$)/)
    if (!match) continue
    const port = Number(match[1])
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    const pids = result.get(port) ?? []
    if (!pids.includes(pid)) pids.push(pid)
    result.set(port, pids)
  }
  return result
}

async function run(command: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    })
    return result.stdout
  } catch {
    return ''
  }
}

async function queryProcesses(): Promise<Map<number, PosixProcessInfo>> {
  const output = await run('ps', ['-axo', 'pid=,ppid=,lstart=,comm=,args='])
  return new Map(parsePsOutput(output).map((info) => [info.pid, info]))
}

export async function listPortPidMapPosix(): Promise<Map<number, number[]>> {
  return parseLsofListenOutput(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pnPc']))
}

export async function captureOsSnapshotPosix(): Promise<PosixSnapshot> {
  const [processes, portPids] = await Promise.all([
    queryProcesses(),
    listPortPidMapPosix(),
  ])
  return { portPids, processes }
}

export async function listProcessesPosix(): Promise<Map<number, PosixProcessInfo>> {
  return queryProcesses()
}

export async function getProcessInfoPosix(pid: number): Promise<PosixProcessInfo | null> {
  const processes = await queryProcesses()
  return processes.get(pid) ?? null
}

export async function isSameProcessPosix(pid: number, expectStartTime?: number): Promise<boolean> {
  if (!expectStartTime) return false
  const info = await getProcessInfoPosix(pid)
  return info?.startTime !== undefined && Math.abs(info.startTime - expectStartTime) < 2_000
}

export async function listProcessTreePosix(rootPid: number, maxDepth = 8): Promise<Map<number, PosixProcessInfo>> {
  const processes = await queryProcesses()
  const result = new Map<number, PosixProcessInfo>()
  const seen = new Set<number>([rootPid])
  let frontier = [rootPid]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = []
    for (const info of processes.values()) {
      if (seen.has(info.pid) || !frontier.includes(info.ppid)) continue
      seen.add(info.pid)
      result.set(info.pid, info)
      next.push(info.pid)
    }
    frontier = next
  }
  return result
}
