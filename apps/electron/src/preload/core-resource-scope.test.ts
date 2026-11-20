import { AGENT_IPC_CHANNELS, AGENT_PRESET_IPC_CHANNELS, GLOBAL_SKILL_IPC_CHANNELS, SKILL_MASTER_IPC_CHANNELS } from '@profer/shared'
import { CORE_CHAT_CHANNELS } from '../lib/core-chat-channels'
import { CORE_RESOURCE_OPERATIONS } from '../lib/core-resource-channels'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

interface Scope { targetId: string; generation: number }
interface Snapshot { currentId: string; generation: number }
function fixture(list: () => Promise<Snapshot>, result: () => Promise<unknown> = async () => 'ok') {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('let resourceTarget:')
  const end = source.indexOf('\nimport type { CustomNotificationSound', start)
  if (start < 0 || end < start) throw new Error('未找到实际preload资源helper')
  const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))
  const calls: Array<{ channel: string; args: unknown[] }> = []
  let listener: ((_event: unknown, snapshot: Snapshot) => void) | undefined
  const ipcRenderer = {
    on: (_name: string, callback: typeof listener) => { listener = callback },
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === 'target:list') return list()
      calls.push({ channel, args }); return result()
    },
  }
  const invoke = new Function('ipcRenderer', 'CORE_TARGET_IPC_CHANNELS', 'CORE_RESOURCE_OPERATIONS', 'CORE_CHAT_CHANNELS', `${script}\nreturn invokeScopedCoreResource`)(ipcRenderer, { LIST: 'target:list' }, { 'resource:save': 'save' }, CORE_CHAT_CHANNELS) as (channel: string, ...args: unknown[]) => Promise<unknown>
  return { calls, invoke, changed: (scope: Scope) => listener?.({}, { currentId: scope.targetId, generation: scope.generation }) }
}

test('所有资源preload入口（含多行正文/卡片）必须使用scope，不允许裸invoke', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const channels = [...source.matchAll(/ipcRenderer\.invoke\(\s*(AGENT_IPC_CHANNELS|AGENT_PRESET_IPC_CHANNELS|GLOBAL_SKILL_IPC_CHANNELS|SKILL_MASTER_IPC_CHANNELS)\.([A-Z_]+)/g)]
  const groups: Record<string, Readonly<Record<string, string>>> = {
    AGENT_IPC_CHANNELS, AGENT_PRESET_IPC_CHANNELS, GLOBAL_SKILL_IPC_CHANNELS, SKILL_MASTER_IPC_CHANNELS,
  }
  const offending = channels.filter(match => {
    const channel = groups[match[1]!]?.[match[2]!]
    return channel && CORE_RESOURCE_OPERATIONS[channel]
  }).map(match => `${match[1]}.${match[2]}`)
  expect(offending).toEqual([])
})

test('首次资源请求初始化目标后成功带scope，不要求先收到广播', async () => {
  const f = fixture(async () => ({ currentId: 'core-a', generation: 1 }))
  expect(await f.invoke('resource:save', 'same', undefined)).toBe('ok')
  expect(f.calls).toEqual([{ channel: 'resource:save', args: ['same', { __proferCoreResourceScope: { targetId: 'core-a', generation: 1 } }] }])
})

test('首次LIST迟到不能覆盖已选新Core或把旧请求发给新目标', async () => {
  let resolve!: (snapshot: Snapshot) => void
  const pending = new Promise<Snapshot>(done => { resolve = done })
  const f = fixture(() => pending)
  const first = f.invoke('resource:save', 'same')
  f.changed({ targetId: 'core-b', generation: 2 })
  resolve({ currentId: 'core-a', generation: 1 })
  await expect(first).rejects.toThrow('Core')
  expect(f.calls).toEqual([])
  expect(await f.invoke('resource:save', 'same')).toBe('ok')
  expect(f.calls[0]?.args).toEqual(['same', { __proferCoreResourceScope: { targetId: 'core-b', generation: 2 } }])
})

test('响应晚到在preload拒绝，捕获原目标和代次不替换请求', async () => {
  let resolve!: (value: unknown) => void
  const f = fixture(async () => ({ currentId: 'core-a', generation: 1 }), () => new Promise(done => { resolve = done }))
  f.changed({ targetId: 'core-a', generation: 1 })
  const first = f.invoke('resource:save', 'same', undefined, true)
  f.changed({ targetId: 'core-b', generation: 2 })
  resolve('late')
  await expect(first).rejects.toThrow('Core')
  expect(f.calls[0]?.args).toEqual(['same', undefined, true, { __proferCoreResourceScope: { targetId: 'core-a', generation: 1 } }])
})

 test('Given Chat入口 When 扫描preload和composer Then 所有Chat通道都携带目标scope', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const composer = readFileSync(new URL('./composer-api.ts', import.meta.url), 'utf8')
  expect(source.match(/ipcRenderer\.invoke\(\s*CHAT_IPC_CHANNELS\./g)).toBeNull()
  expect(composer.match(/ipcRenderer\.invoke\(\s*CHAT_IPC_CHANNELS\./g)).toBeNull()
 })
 test('Given Chat资源 When 切换目标后旧回执返回 Then 拒绝且不改写原始scope', async () => {
  let resolve!: (value: unknown) => void
  const f = fixture(async () => ({ currentId: 'local', generation: 0 }), () => new Promise(done => { resolve = done }))
  f.changed({ targetId: 'local', generation: 0 })
  const request = f.invoke('chat:list-conversations')
  f.changed({ targetId: 'linux', generation: 1 })
  resolve([])
  await expect(request).rejects.toThrow('Core')
  expect(f.calls[0]?.args).toEqual([{ __proferCoreResourceScope: { targetId: 'local', generation: 0 } }])
 })
