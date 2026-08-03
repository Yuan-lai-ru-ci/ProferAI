/**
 * process-monitor — 会话运行进程采集（期一 / M1b-M2）
 *
 * 用 PowerShell（Get-CimInstance / Get-NetTCPConnection，Windows 先行）枚举真实
 * OS 进程 + 端口映射，并把 SDK 后台任务（type:'shell'）的 command 匹配到真实 PID。
 *
 * 设计原则：
 *  - 零第三方依赖；统一走 powershell.exe。⚠️ 实测 tasklist/netstat 在本进程 spawn
 *    ETIMEDOUT；PowerShell 通道稳定但 Get-NetTCPConnection 单次约 4-5s、Get-CimInstance
 *    约 1.6s。**所有采集均为异步（execFile），绝不用 execFileSync**，避免阻塞主进程/冻结 UI。
 *  - pid 无转世：项带 startTime（CreationDate），kill 前 {pid,startTime} 双因子（isSameProcess）。
 *  - 接口预留跨平台：Windows 实装；mac/linux TODO（ps + ss|lsof）。
 *  - 超时给足 8s（PowerShell 冷启动 + 大表扫描）。
 */

import { execFile, execFileSync } from 'node:child_process'
import type { SDKBackgroundTaskSummary } from '@profer/shared'

const EXEC_TIMEOUT_MS = 8000
const PS = 'powershell.exe'

/**
 * 从命令字符串提取「显式请求的监听端口」；支持常见形态：
 *   --port 5177 / -p 5177 / --port=5177 / -p=5177 / :5177（URL/冒号后缀）
 * 只接受 1-65535 的合法端口，且尽量锚定到参数/URL 位置，避免把命令中任意出现的
 * 2-5 位数字（如 pid、重试次数、日志计数）误当成端口。
 */
export function extractRequestedPort(command: string): number | undefined {
  const c = (command ?? '').trim()
  if (!c) return undefined
  // 优先参数形态：--port <n>、--port=<n>、-p <n>、-p=<n>（右侧需为单词边界/行尾）
  const param = c.match(/(?:--port|-p)\s*=?\s*(\d{1,5})(?:\b|$)/i)
  let port = param ? Number(param[1]) : undefined
  // 参数形态缺位时，回退到 URL/冒号形式（主机名:port），如 http://host:8080、localhost:5177。
  // 要求冒号前是主机名字符集，避免把路径中的裸数字当端口。
  if (port === undefined) {
    const portOnly = c.match(/(?:https?:\/\/[^\s/:]*|localhost|[a-z0-9.-]+):(\d{1,5})(?:\/|\b|$)/i)
    port = portOnly ? Number(portOnly[1]) : undefined
  }
  return port !== undefined && Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

export interface MonitoredProcess {
  pid: number
  name: string
  cmd: string
  startTime?: number
  ports: number[]
  sessionId?: string
  sdkTaskId?: string
}

/** 异步执行 PowerShell，失败/超时返回空串（不抛） */
function psAsync(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        PS,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(err ? '' : (stdout ?? '')),
      )
    } catch {
      resolve('')
    }
  })
}

/** 端口 → 监听 pid 映射（Get-NetTCPConnection -State Listen） */
export async function listPortPidMapWin(): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>()
  const out = await psAsync(
    'Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress',
  )
  if (!out) return map
  try {
    const arr = JSON.parse(out)
    const items = Array.isArray(arr) ? arr : [arr]
    for (const it of items) {
      const port = Number(it.LocalPort)
      const pid = Number(it.OwningProcess)
      if (!Number.isNaN(port) && !Number.isNaN(pid) && pid > 0) {
        const list = map.get(port) ?? []
        if (!list.includes(pid)) list.push(pid)
        map.set(port, list)
      }
    }
  } catch { /* 忽略 */ }
  return map
}

/** 枚举全部进程（pid → name/cmd/startTime） */
export async function listProcessesWin(): Promise<Map<number, { name: string; cmd: string; startTime?: number }>> {
  const map = new Map<number, { name: string; cmd: string; startTime?: number }>()
  const out = await psAsync(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,@{N="cts";E={$_.CreationDate.ToString("o")}} | ConvertTo-Json -Compress',
  )
  if (!out) return map
  try {
    const arr = JSON.parse(out)
    const items = Array.isArray(arr) ? arr : [arr]
    for (const it of items) {
      const pid = Number(it.ProcessId)
      if (Number.isNaN(pid) || pid <= 0) continue
      let startTime: number | undefined
      if (it.cts) {
        const t = Math.floor(new Date(it.cts).getTime())
        if (!Number.isNaN(t)) startTime = t
      }
      map.set(pid, { name: it.Name ?? '', cmd: it.CommandLine ?? '', startTime })
    }
  } catch { /* 忽略 */ }
  return map
}

/** pid + startTime 双因子（防 PID 转世）。startTime 缺失 → 拒绝（false）。容差 2s。 */
export async function isSameProcess(pid: number, expectStartTime?: number): Promise<boolean> {
  if (!expectStartTime) return false
  const out = await psAsync(
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){ $p | Select-Object @{N='cts';E={$p.CreationDate.ToString('o')}} | ConvertTo-Json -Compress }`,
  )
  if (!out) return false
  try {
    const it = JSON.parse(out)
    const cd = it && it.cts ? Math.floor(new Date(it.cts).getTime()) : undefined
    if (typeof cd !== 'number') return false
    return Math.abs(cd - expectStartTime) < 2000
  } catch {
    return false
  }
}

/**
 * 按会话工作目录枚举该目录下运行中的真实进程（不依赖 SDK background_tasks）。
 *
 * 用 Get-CimInstance 枚举全部进程，筛掉本进程自身与无关项，保留满足以下任一条件的：
 *  - CommandLine 包含 sessionPath（dev server 等工作目录在会话内）
 *  - 或监听端口（后续可并入端口信息）
 * 用后台任务/tool 无关，纯 OS 视角，能补到 SDK 未标记为后台的真实 dev server。
 */
export async function listSessionDirProcesses(sessionPath: string): Promise<MonitoredProcess[]> {
  if (!sessionPath) return []
  const portPids = await listPortPidMapWin()
  const out = await psAsync(
    'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,@{N="cts";E={$_.CreationDate.ToString("o")}} | ConvertTo-Json -Compress',
  )
  if (!out) return []
  const results: MonitoredProcess[] = []
  try {
    const arr = JSON.parse(out)
    const items = Array.isArray(arr) ? arr : [arr]
    const normPath = sessionPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    for (const it of items) {
      const pid = Number(it.ProcessId)
      if (Number.isNaN(pid) || pid <= 0 || pid === process.pid) continue
      const cmd = it.CommandLine ?? ''
      const lowCmd = cmd.replace(/\\/g, '/').toLowerCase()
      // 只关心与开发/脚本相关的进程，避免把系统进程都列进来
      if (!lowCmd.includes(normPath)) continue
      // 排除本应用自身进程（Profer node/electron）避免噪音
      if (lowCmd.includes('claude-agent-sdk') && !lowCmd.includes(normPath)) continue
      let startTime: number | undefined
      if (it.cts) {
        const t = Math.floor(new Date(it.cts).getTime())
        if (!Number.isNaN(t)) startTime = t
      }
      // 该进程监听的端口
      const ports: number[] = []
      for (const [port, pids] of portPids) {
        if (pids.includes(pid)) ports.push(port)
      }
      results.push({ pid, name: it.Name ?? '', cmd, startTime, ports })
    }
  } catch {
    /* 忽略 */
  }
  return results
}

/**
 * 把 SDK 后台任务（type:'shell'）匹配到真实 OS 进程。
 * 优先「端口命中」（command 含端口 → 该端口监听 pid），端口缺失退化为命令首关键字+node 匹配。
 */
export async function mapSdkShellTasks(
  sessionId: string,
  sdkTasks: SDKBackgroundTaskSummary[],
): Promise<MonitoredProcess[]> {
  const tasks = (sdkTasks ?? []).filter((t) => t.type === 'shell')
  if (tasks.length === 0) return []
  const [portPids, procs] = await Promise.all([listPortPidMapWin(), listProcessesWin()])
  const results: MonitoredProcess[] = []

  for (const task of tasks) {
    const cmd = task.command ?? ''
    const port = extractRequestedPort(cmd)

    let found: MonitoredProcess | undefined
    if (port && portPids.has(port)) {
      for (const pid of portPids.get(port)!) {
        const info = procs.get(pid)
        if (!info) continue
        const lowCmd = info.cmd.toLowerCase()
        const lowTask = cmd.toLowerCase()
        const similar =
          info.name.toLowerCase().includes('node') ||
          (lowCmd.length > 8 && lowTask.length > 8 && lowCmd.includes(lowTask.slice(0, 8)))
        if (similar || lowCmd.includes(`:${port}`)) {
          found = { pid, name: info.name, cmd: info.cmd, startTime: info.startTime, ports: [port], sessionId, sdkTaskId: task.id }
          break
        }
      }
    }
    if (!found && cmd.trim().length > 0) {
      const key = cmd.trim().split(/\s+/)[0]?.toLowerCase()
      if (key) {
        for (const [pid, info] of procs) {
          const lowCmd = info.cmd.toLowerCase()
          if (info.name.toLowerCase().includes('node') && lowCmd.includes(key)) {
            found = { pid, name: info.name, cmd: info.cmd, startTime: info.startTime, ports: [], sessionId, sdkTaskId: task.id }
            break
          }
        }
      }
    }
    if (found) results.push(found)
  }
  return results
}

/** 获取单进程信息（展示 / kill 前 double-check） */
export async function getProcessInfo(pid: number): Promise<MonitoredProcess | null> {
  const out = await psAsync(
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){ $p | Select-Object ProcessId,Name,CommandLine,@{N='cts';E={$p.CreationDate.ToString('o')}} | ConvertTo-Json -Compress }`,
  )
  if (!out) return null
  try {
    const it = JSON.parse(out)
    if (!it || it.ProcessId == null) return null
    const cd = it.cts ? Math.floor(new Date(it.cts).getTime()) : undefined
    return { pid: Number(it.ProcessId), name: it.Name ?? '', cmd: it.CommandLine ?? '', startTime: cd, ports: [] }
  } catch {
    return null
  }
}

/**
 * Prefer a graceful console/process-tree termination, then force-kill only if
 * the recorded PID is still the same process after the grace window.
 */
export async function terminateProcessTreeGracefully(
  pid: number,
  startTime: number,
  graceMs = 2_500,
): Promise<{ ok: boolean; message: string; forced: boolean }> {
  await new Promise<void>((resolve) => {
    try {
      execFile('taskkill.exe', ['/pid', String(pid), '/T'], { windowsHide: true }, () => resolve())
    } catch { resolve() }
  })
  await new Promise((resolve) => setTimeout(resolve, graceMs))
  if (!await isSameProcess(pid, startTime)) {
    return { ok: true, message: `已优雅结束进程 ${pid}`, forced: false }
  }
  const forced = killProcessTree(pid)
  return { ok: forced.ok, message: forced.ok ? `优雅停止超时，已强制结束进程树 ${pid}` : forced.message, forced: true }
}

/** kill 进程树（Windows taskkill /T /F 杀整棵子树；posix 预留） */
export function killProcessTree(pid: number): { ok: boolean; message: string } {
  try {
    execFileSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore', timeout: EXEC_TIMEOUT_MS, windowsHide: true,
    })
    return { ok: true, message: `killed ${pid}` }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return { ok: false, message: e?.message ?? 'kill failed' }
  }
}
