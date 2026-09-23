import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { buildWslBashArgs, ensureBashWorkingDirectory, executeLocalBashCommand, executeWslBashCommand, requireLocalBashShellPath, waitForLocalBashProcess, windowsPathToWslPath } from './pi-agent-adapter'

function fakeChild(pid = 4242) {
  return Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(this: { killed: boolean }) {
      this.killed = true
      return true
    },
  })
}

describe('Pi WSL Bash', () => {
  test('Given a Windows workspace path When building WSL Bash arguments Then uses its mounted Linux path', () => {
    expect(buildWslBashArgs(
      { wslDistro: 'Ubuntu-24.04' },
      'C:\\Users\\alice\\Workspace\\project',
      'pwd',
      undefined,
    )).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '/mnt/c/Users/alice/Workspace/project',
      '--exec',
      'bash',
      '-lc',
      'pwd',
    ])
  })

  test('Given a Linux path When converting for WSL Then leaves it unchanged', () => {
    expect(windowsPathToWslPath('/home/alice/project')).toBe('/home/alice/project')
  })

  test('Given a deleted session cwd When starting Bash Then recreates the directory before spawn', () => {
    const created: string[] = []
    ensureBashWorkingDirectory(
      '/Users/alice/.profer/session-1',
      () => false,
      (path) => { created.push(path) },
    )

    expect(created).toEqual(['/Users/alice/.profer/session-1'])
  })

  test('Given an empty cwd When starting Bash Then fails with a path-specific error', () => {
    expect(() => ensureBashWorkingDirectory('   ')).toThrow('Bash 工作目录为空')
  })

  test('Given no verified Bash path When starting Bash Then fails with shell_not_found', () => {
    let caughtError: NodeJS.ErrnoException | undefined
    try {
      requireLocalBashShellPath(undefined)
    } catch (error) {
      caughtError = error as NodeJS.ErrnoException
    }

    expect(caughtError?.code).toBe('shell_not_found')
    expect(caughtError?.message).toContain('未找到可用的 Bash')
  })

  test('Given a missing Bash executable When local execution starts Then returns shell_not_found evidence', async () => {
    if (process.platform === 'win32') return
    const result = await executeLocalBashCommand({
      command: 'printf should-not-run',
      cwd: process.cwd(),
      shell: '/definitely/missing/profer-bash',
    })

    expect(result).toMatchObject({
      exitCode: null,
      errorKind: 'shell_not_found',
      errorCode: 'ENOENT',
    })
    expect(result.stderr).toContain('profer-bash')
  })

  test('Given an unavailable working directory When local execution starts Then returns working_directory_error evidence', async () => {
    if (process.platform === 'win32') return
    const cwd = '/definitely/missing/profer-working-directory'
    const result = await executeLocalBashCommand({
      command: 'printf should-not-run',
      cwd,
      shell: '/bin/bash',
    })

    expect(result).toMatchObject({
      exitCode: null,
      errorKind: 'working_directory_error',
      errorCode: 'ENOENT',
      cwd,
    })
  })

  test('Given a WSL launcher emits a spawn error When execution completes Then returns spawn_error evidence', async () => {
    const child = fakeChild()
    const pending = executeWslBashCommand({
      runtimeEnv: { wslCommand: 'wsl.exe' },
      command: 'echo should-not-run',
      cwd: 'C:\\workspace',
      spawnProcess: (() => child) as never,
    })

    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    child.emit('error', error)
    const result = await pending

    expect(result).toMatchObject({
      exitCode: null,
      errorKind: 'spawn_error',
      errorCode: 'EACCES',
      stderr: 'permission denied',
    })
  })

  test('Given a child exits without close When both stdio streams end Then resolves with the exit code', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    const pending = waitForLocalBashProcess(child as never, 20)

    child.emit('exit', 7, null)
    child.stdout.write('tail output')
    child.stdout.end()
    child.stderr.end()

    await expect(pending).resolves.toBe(7)
  })

  test('Given a child exits but inherited stdio stays open When no more output arrives Then settles after the drain grace', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    const startedAt = Date.now()
    const pending = waitForLocalBashProcess(child as never, 25)
    child.emit('exit', 0, null)

    await expect(pending).resolves.toBe(0)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20)
  })

  test('Given a local Bash command writes both streams When it exits non-zero Then returns a structured execution result', async () => {
    if (process.platform === 'win32') return
    const streamedStdout: string[] = []
    const streamedStderr: string[] = []

    const result = await executeLocalBashCommand({
      command: "printf 'out'; printf 'err' >&2; exit 7",
      cwd: process.cwd(),
      shell: '/bin/bash',
    }, {
      onStdout: (data) => streamedStdout.push(data.toString()),
      onStderr: (data) => streamedStderr.push(data.toString()),
    })

    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(streamedStdout.join('')).toBe('out')
    expect(streamedStderr.join('')).toBe('err')
    expect(result.exitCode).toBe(7)
    expect(result.signal).toBeNull()
    expect(result.timedOut).toBeFalse()
    expect(result.aborted).toBeFalse()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.shell).toBe('/bin/bash')
    expect(result.cwd).toBe(process.cwd())
    expect(result.truncated).toBeFalse()
  })

  test('Given captured output exceeds the cap When Bash completes Then keeps bounded stream tails and marks truncation', async () => {
    if (process.platform === 'win32') return
    const result = await executeLocalBashCommand({
      command: "printf '1234567890'; printf 'abcdefghij' >&2",
      cwd: process.cwd(),
      shell: '/bin/bash',
      maxOutputBytes: 5,
    })

    expect(result.stdout).toBe('67890')
    expect(result.stderr).toBe('fghij')
    expect(result.truncated).toBeTrue()
  })

  test('Given a running Bash command exceeds its timeout When the process group is killed Then reports timeout and signal', async () => {
    if (process.platform === 'win32') return
    const result = await executeLocalBashCommand({
      command: 'sleep 1',
      cwd: process.cwd(),
      shell: '/bin/bash',
      timeoutMs: 25,
    })

    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGKILL')
    expect(result.timedOut).toBeTrue()
    expect(result.aborted).toBeFalse()
    expect(result.durationMs).toBeLessThan(500)
  })

  test('Given an already aborted signal When execution starts Then returns an aborted result without spawning', async () => {
    const controller = new AbortController()
    controller.abort()
    let spawned = false

    const result = await executeLocalBashCommand({
      command: 'echo should-not-run',
      cwd: process.cwd(),
      shell: '/bin/bash',
      signal: controller.signal,
    }, {
      onSpawn: () => { spawned = true },
    })

    expect(spawned).toBeFalse()
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBeFalse()
    expect(result.aborted).toBeTrue()
  })

  test('Given WSL Bash exits non-zero When execution completes Then returns structured output and invokes stream callbacks', async () => {
    const child = fakeChild()
    const streamedStdout: string[] = []
    const streamedStderr: string[] = []
    const spawned: number[] = []
    const pending = executeWslBashCommand({
      runtimeEnv: { wslCommand: 'wsl.exe', wslDistro: 'Ubuntu' },
      command: 'printf out; printf err >&2; exit 7',
      cwd: 'C:\\workspace',
      maxOutputBytes: 100,
      spawnProcess: (() => child) as never,
    }, {
      onSpawn: (pid) => spawned.push(pid),
      onStdout: (data) => streamedStdout.push(data.toString()),
      onStderr: (data) => streamedStderr.push(data.toString()),
    })

    child.stdout.write('out')
    child.stderr.write('err')
    child.emit('close', 7)
    const result = await pending

    expect(spawned).toEqual([4242])
    expect(streamedStdout.join('')).toBe('out')
    expect(streamedStderr.join('')).toBe('err')
    expect(result).toMatchObject({
      stdout: 'out',
      stderr: 'err',
      exitCode: 7,
      signal: null,
      timedOut: false,
      aborted: false,
      shell: 'bash',
      cwd: 'C:\\workspace',
      truncated: false,
    })
  })

  test('Given an already aborted WSL signal When execution starts Then does not spawn and returns aborted evidence', async () => {
    const controller = new AbortController()
    controller.abort()
    let spawned = false
    const result = await executeWslBashCommand({
      runtimeEnv: { wslCommand: 'wsl.exe' },
      command: 'echo should-not-run',
      cwd: 'C:\\workspace',
      signal: controller.signal,
      spawnProcess: (() => {
        spawned = true
        return fakeChild()
      }) as never,
    })

    expect(spawned).toBeFalse()
    expect(result).toMatchObject({ exitCode: null, timedOut: false, aborted: true, stdout: '', stderr: '' })
  })

  test('Given a WSL command exceeds its timeout When the launcher never closes Then force-settles with timeout evidence', async () => {
    const child = fakeChild()
    const pending = executeWslBashCommand({
      runtimeEnv: { wslCommand: 'wsl.exe' },
      command: 'sleep 10',
      cwd: 'C:\\workspace',
      timeoutMs: 5,
      forceKillGraceMs: 5,
      terminationGraceMs: 10,
      spawnProcess: (() => child) as never,
    })

    const result = await pending
    expect(result.timedOut).toBeTrue()
    expect(result.aborted).toBeFalse()
    expect(result.exitCode).toBeNull()
    expect(child.killed).toBeTrue()
  })

  test('Given inherited stdio keeps producing output after exit When the drain deadline expires Then settles without waiting for idle', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    const startedAt = Date.now()
    const pending = waitForLocalBashProcess(child as never, 25, 80)
    child.emit('exit', 0, null)

    const outputInterval = setInterval(() => child.stdout.write('still running\n'), 5)
    const safetyTimer = setTimeout(() => clearInterval(outputInterval), 300)
    try {
      await expect(pending).resolves.toBe(0)
    } finally {
      clearInterval(outputInterval)
      clearTimeout(safetyTimer)
    }

    const elapsedMs = Date.now() - startedAt
    expect(elapsedMs).toBeGreaterThanOrEqual(60)
    expect(elapsedMs).toBeLessThan(200)
  })
})
