import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteJson } from './atomic-write'

let root = ''
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

async function setup() {
  root = await mkdtemp(join(tmpdir(), 'profer-atomic-write-'))
  return root
}

test('writes JSON atomically and creates missing parent directories', async () => {
  const dir = await setup()
  const target = join(dir, 'deep', 'nested', 'value.json')
  await atomicWriteJson(target, { hello: '世界' })
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ hello: '世界' })
})

test('overwrites existing content without leaving temp files behind', async () => {
  const dir = await setup()
  const target = join(dir, 'state.json')
  await atomicWriteJson(target, { version: 1 })
  await atomicWriteJson(target, { version: 2 })
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ version: 2 })
  expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
})

// Windows 上目录句柄 fsync 永远 EPERM：rename 已完成时必须仍视为写入成功。
test('directory fsync being unsupported does not fail the write', async () => {
  const dir = await setup()
  const target = join(dir, 'manifest.json')
  await expect(atomicWriteJson(target, { ok: true }, 0o600)).resolves.toBeUndefined()
  await expect(atomicWriteFile(join(dir, 'blob'), Buffer.from('payload'), 0o600)).resolves.toBeUndefined()
})

test('rename failure rejects and cleans up the temp file', async () => {
  const dir = await setup()
  const target = join(dir, 'occupied')
  await mkdir(target)
  await expect(atomicWriteJson(target, { ok: true })).rejects.toThrow()
  expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
})
