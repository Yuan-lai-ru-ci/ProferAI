import { expect, test } from 'bun:test'
import { acquireCoreExecutionLock, publishLocalCoreOwner } from '@profer/session-store/execution-lock'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const list = (root: string, ...args: string[]) => Bun.spawnSync({
  cmd: [process.execPath, join(import.meta.dir, '../index.ts'), 'session', 'list', '--config-dir', root, '--json', ...args],
})

test.skipIf(!['darwin', 'linux'].includes(process.platform))('显式 Core 缺少描述符时报错，不回退磁盘；旧命令仍读磁盘', () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-cli-list-'))
  try {
    writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({ sessions: [{ id: 'disk-fixture', type: 'session', title: 'Disk' }] }))
    const offline = list(root)
    expect(offline.exitCode).toBe(0)
    expect(JSON.parse(offline.stdout.toString())).toMatchObject([{ id: 'disk-fixture', title: 'Disk' }])
    const live = list(root, '--core')
    expect(live.exitCode).not.toBe(0)
    expect(live.stdout.toString()).toBe('')
    expect(live.stderr.toString()).toContain('.core-owner.json')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.skipIf(!['darwin', 'linux'].includes(process.platform))('Core 身份匹配后使用鉴权 API；筛选后排序并限量，身份不符不请求会话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profer-cli-owner-'))
  const release = acquireCoreExecutionLock(root)
  const seen: string[] = []
  let identity = 'fixture'
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    if (req.headers.get('authorization') !== 'Bearer fixture-owner') return new Response(null, { status: 401 })
    const path = new URL(req.url).pathname
    seen.push(path)
    if (path === '/identity') return Response.json({ coreId: identity, protocolVersion: 1 })
    return Response.json({ sessions: [
      { id: 'older', updatedAt: 1, workspaceId: 'w' },
      { id: 'other', updatedAt: 3, workspaceId: 'x' },
      { id: 'wanted', title: 'Core', updatedAt: 2, workspaceId: 'w', archived: true },
    ] })
  } })
  const remove = publishLocalCoreOwner(root, { version: 1, port: server.port!, pid: process.pid, coreId: 'fixture', token: 'fixture-owner' })
  const run = async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts'), 'list', '--config-dir', root, '--json', '--core', '--workspace', 'w', '--limit', '1'], { stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([proc.exited, proc.stdout.text(), proc.stderr.text()])
    return { code, stdout, stderr }
  }
  try {
    const live = await run()
    expect(live.code).toBe(0)
    expect(JSON.parse(live.stdout)).toEqual([{ id: 'wanted', title: 'Core', updatedAt: 2, workspaceId: 'w', archived: true }])
    identity = 'other'
    const wrong = await run()
    expect(wrong.code).not.toBe(0)
    expect(wrong.stdout).toBe('')
    expect(wrong.stderr).toContain('身份')
    expect(seen).toEqual(['/identity', '/sessions', '/identity'])
  } finally { server.stop(true); remove(); release(); rmSync(root, { recursive: true, force: true }) }
})
