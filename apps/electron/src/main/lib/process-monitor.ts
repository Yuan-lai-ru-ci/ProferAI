/**
 * process-monitor — 会话运行进程采集（期一 / M1b-M2）
 *
 * 用 PowerShell（Get-CimInstance / Get-NetTCPConnection，Windows 先行）枚举真实
 * OS 进程 + 端口映射，并把 SDK 后台任务（type:'shell'）的 command 匹配到真实 PID。
 *
 * 设计原则：
 *  - 零第三方依赖；统一走 powershell.exe。⚠️ 实测 tasklist/netstat 在本进程 spawn
 *    ETIMEDOUT。**所有采集均为异步，优先复用长驻 PowerShell 管道，绝不用
 *    execFileSync**，避免阻塞主进程 / 冻结 UI。
 *  - pid 无转世：项带 startTime（CreationDate），kill 前 {pid,startTime} 双因子（isSameProcess）。
 *  - 接口预留跨平台：Windows 实装；mac/linux TODO（ps + ss|lsof）。
 *  - 超时给足 8s（PowerShell 冷启动 + 大表扫描）。
 */

import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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

/**
 * 复用单个长驻 powershell.exe 的 stdin/stdout 管道。命令以换行写入 stdin，每条
 * 命令末尾追加一条唯一 token 的 Write-Output 作响应边界；stdout 按 FIFO 顺序
 * 匹配 token 切分，返回每条命令自己的完整输出。管道启动失败/进程退出/单条超时
 * 时重建通道，保证功能不降级。
 */
const PIPE_CMD_TIMEOUT_MS = 10_000

interface PendingCommand {
  command: string
  token: string
  written: boolean
  resolve: (out: string) => void
  timer: ReturnType<typeof setTimeout>
}

class PowerShellPipe {
  private proc: ChildProcessWithoutNullStreams | null = null
  private outBuf = ''
  /** 已入队待执行的命令，FIFO 排列；写入与解析都以队列顺序为准 */
  private pending: PendingCommand[] = []

  /** 发送一条命令，返回 stdout 直到本次 token 标记的响应（不含标记行与换行） */
  send(command: string): Promise<string> {
    if (!this.proc || this.proc.exitCode !== null) {
      this.reset()
      if (!this.spawn()) return Promise.resolve('')
    }
    const token = `__PROFER_PS_END_${Date.now()}_${Math.random().toString(36).slice(2)}__`
    return new Promise<string>((resolve) => {
      const pending: PendingCommand = {
        command: `${command}\nWrite-Output ${JSON.stringify(token)}\n`,
        token,
        written: false,
        resolve,
        timer: setTimeout(() => {
          // 超时：整管失效，丢弃所有未完成命令并重建通道，避免后续输出错位。
          this.reset()
          resolve('')
        }, PIPE_CMD_TIMEOUT_MS),
      }
      this.pending.push(pending)
      this.writePending()
    })
  }

  private spawn(): boolean {
    try {
      const p = spawn(
        PS,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      this.proc = p
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', (chunk: string) => { this.outBuf += chunk; this.processOut() })
      p.stderr.on('data', () => { /* 忽略错误流 */ })
      p.on('error', () => this.reset())
      p.on('exit', () => this.reset())
      return true
    } catch {
      this.reset()
      return false
    }
  }

  /** 把所有尚未写入的命令依序写入 stdin（Node 的 stdin.write 顺序缓冲，天然保序） */
  private writePending(): void {
    if (!this.proc || this.proc.exitCode !== null) return
    for (const pending of this.pending) {
      if (pending.written) continue
      try {
        this.proc.stdin.write(pending.command)
        pending.written = true
      } catch {
        this.reset()
        return
      }
    }
  }

  private processOut(): void {
    // FIFO：只要队首能在缓冲中找到其 token，就完成它（后续命令输出必然排在其后）
    while (this.pending.length > 0) {
      const head = this.pending[0]!
      const endPos = this.outBuf.indexOf(head.token)
      if (endPos < 0) break
      const output = this.outBuf.slice(0, endPos)
      this.outBuf = this.outBuf.slice(endPos + head.token.length).replace(/^\r?\n/, '')
      clearTimeout(head.timer)
      this.pending.shift()
      head.resolve(output)
    }
  }

  /** 重建通道：销毁进程并清空未完成命令队列 */
  private reset(): void {
    const leftovers = this.pending
    this.pending = []
    if (this.proc) { try { this.proc.kill() } catch { /* best effort */ } this.proc = null }
    this.outBuf = ''
    for (const p of leftovers) { try { clearTimeout(p.timer) } catch { /* noop */ } }
  }
}

/** 单例：进程内所有 PowerShell 采集共享一个长驻通道 */
const pipe = new PowerShellPipe()

/** 异步执行 PowerShell：复用长驻管道（单次 ≤ 几十 ms），通道失效时重建 */
function psAsync(cmd: string): Promise<string> {
  return pipe.send(cmd)
}

/**
 * 用 netstat -ano 采集「监听端口 → pid」映射。实测替代 Get-NetTCPConnection（~3.3s）
 * 后降到 ~360ms。
 */
const PS_PORT_CMD = `netstat -ano -p TCP | Select-String 'LISTENING' | ForEach-Object { $t = ($_ -split "\\s+") | Where-Object { $_ }; if ($t.Count -ge 5) { $mp = [regex]::Match($t[1], ':([0-9]+)$'); if ($mp.Success) { [PSCustomObject]@{ Port=[int]$mp.Groups[1].Value; PID=[int]$t[-1] } } } } | Group-Object Port | ForEach-Object { [PSCustomObject]@{ Port=[int]$_.Name; PIDs=@($_.Group | ForEach-Object { $_.PID } | Select-Object -Unique) } } | ConvertTo-Json -Compress`

/** 端口 → 监听 pid 映射（netstat -ano -p TCP） */
export async function listPortPidMapWin(): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>()
  const out = await psAsync(PS_PORT_CMD)
  if (!out) return map
  try {
    const arr = JSON.parse(out)
    const items = Array.isArray(arr) ? arr : [arr]
    for (const it of items) {
      const port = Number(it.Port)
      const pids = Array.isArray(it.PIDs) ? it.PIDs : [it.PIDs]
      if (Number.isNaN(port) || port <= 0) continue
      const list = map.get(port) ?? []
      for (const pidRaw of pids) {
        const pid = Number(pidRaw)
        if (!Number.isNaN(pid) && pid > 0 && !list.includes(pid)) list.push(pid)
      }
      if (list.length > 0) map.set(port, list)
    }
  } catch { /* 忽略 */ }
  return map
}

/** 一次 PowerShell 调用同时返回「端口→pid」与「pid→进程详情（含 startTime）」，替代两次查询 */
export async function captureOsSnapshotWin(): Promise<{
  portPids: Map<number, number[]>
  processes: Map<number, { name: string; cmd: string; startTime?: number }>
}> {
  const portPids = new Map<number, number[]>()
  const processes = new Map<number, { name: string; cmd: string; startTime?: number }>()
  // netstat 端口 + Get-CimInstance 进程，一次往返（管道内 ~380ms）
  const mergedCmd = `
$pids = @{}
netstat -ano -p TCP | Select-String 'LISTENING' | ForEach-Object {
  $t = ($_ -split \"\\s+\") | Where-Object { $_ }
  if ($t.Count -ge 5) {
    $mp = [regex]::Match($t[1], ':([0-9]+)$')
    if ($mp.Success) {
      $prt=[int]$mp.Groups[1].Value
      $pod=[int]$t[-1]
      if ($prt -gt 0 -and $pod -gt 0) {
        if (-not $pids.ContainsKey($prt)) { $pids[$prt] = @() }
        $pids[$prt] = @($pids[$prt] + $pod)
      }
    }
  }
}
$portsOut = @(); foreach ($k in $pids.Keys) { $portsOut += [PSCustomObject]@{ Port=$k; PIDs=@($pids[$k] | Select-Object -Unique) } }

$procOut = @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,@{N=\"c\";E={$_.CreationDate.ToString('o')}})
[PSCustomObject]@{ Ports=$portsOut; Procs=$procOut } | ConvertTo-Json -Compress -Depth 4
`
  const out = await psAsync(mergedCmd)
  if (out) {
    try {
      const parsed = JSON.parse(out)
      const portsArr = Array.isArray(parsed.Ports) ? parsed.Ports : (parsed.Ports ? [parsed.Ports] : [])
      for (const it of portsArr) {
        const port = Number(it && it.Port)
        if (!Number.isNaN(port) && port > 0) {
          const pidsRaw = Array.isArray(it.PIDs) ? it.PIDs : (it.PIDs != null ? [it.PIDs] : [])
          const list: number[] = []
          for (const r of pidsRaw) { const p = Number(r); if (!Number.isNaN(p) && p > 0 && !list.includes(p)) list.push(p) }
          if (list.length > 0) portPids.set(port, list)
        }
      }
      const procsArr = Array.isArray(parsed.Procs) ? parsed.Procs : (parsed.Procs ? [parsed.Procs] : [])
      for (const it of procsArr) {
        const pid = Number(it && it.ProcessId)
        if (Number.isNaN(pid) || pid <= 0) continue
        let startTime: number | undefined
        if (it.c) { const t = Math.floor(new Date(it.c).getTime()); if (!Number.isNaN(t)) startTime = t }
        processes.set(pid, { name: it.Name ?? '', cmd: it.CommandLine ?? '', startTime })
      }
    } catch { /* 忽略 */ }
  }
  return { portPids, processes }
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
  const { portPids, processes } = await captureOsSnapshotWin()
  const results: MonitoredProcess[] = []
  const normPath = sessionPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const [pid, info] of processes) {
    if (pid === process.pid) continue
    const cmd = info.cmd
    const lowCmd = cmd.toLowerCase()
    if (!lowCmd.includes(normPath)) continue
    if (lowCmd.includes('claude-agent-sdk') && !lowCmd.includes(normPath)) continue
    const ports: number[] = []
    for (const [port, pids] of portPids) {
      if (pids.includes(pid)) ports.push(port)
    }
    results.push({ pid, name: info.name, cmd, startTime: info.startTime, ports })
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
  const { portPids, processes: procs } = await captureOsSnapshotWin()
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
