import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./core-connection-service.ts', import.meta.url), 'utf8')
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.replace(/^import .*$/gm, '').replace(/export /g, ''))
function harness(fail = false) {
  const calls: string[] = []
  const saved: Array<{ endpoints: string[]; tunnel?: boolean }> = []
  let forcedReconnect = false
  const deps = {
    safeStorage: { isEncryptionAvailable: () => true }, getLocalCoreState: () => ({}),
    decodeCoreInvitation: () => ({ name: 'Device', coreId: 'core', endpoints: ['https://host'], pin: { value: 'pin' } }),
    withCoreInvitationTunnel: (invitation: object, tunnelUrl?: string) => tunnelUrl ? { ...invitation, endpoints: [tunnelUrl] } : invitation,
    consumeCoreInvitation: async () => ({ bindingId: 'binding', credential: 'secret', expiresAt: 9999999999999 }),
    savePairedCoreTarget: async (input: { endpoints: string[] }) => { saved.push(input); calls.push('save'); return { id: 'exact-paired-id' } },
    listCoreTargets: () => ({ currentId: 'old', targets: [{ id: 'unrelated-first' }] }),
    selectCoreTarget: async (id: string, options?: { reconnect?: boolean }) => { forcedReconnect = options?.reconnect === true; calls.push(id); if (fail) throw new Error('secret transport details'); return { currentId: id } },
  }
  const api = new Function(...Object.keys(deps), `${script}; return { pairCoreInvitation, pairAndSelectCoreInvitation }`)(...Object.values(deps))
  return { api, calls, saved, forcedReconnect: () => forcedReconnect }
}
test('旧配对仅保存，新配对精确选择保存返回的目标', async () => {
  const { api, calls } = harness()
  expect((await api.pairCoreInvitation('invitation')).currentId).toBe('old')
  expect(calls).toEqual(['save'])
  expect((await api.pairAndSelectCoreInvitation('invitation')).currentId).toBe('exact-paired-id')
  expect(calls).toEqual(['save', 'save', 'exact-paired-id'])
})
test('隧道地址同时用于消费与保存，不把原局域网线路写回', async () => {
  const { api, saved, forcedReconnect } = harness()
  await api.pairAndSelectCoreInvitation('invitation', 'https://127.0.0.1:17788')
  expect(saved[0]?.endpoints).toEqual(['https://127.0.0.1:17788'])
  expect(saved[0]?.tunnel).toBe(true)
  expect(forcedReconnect()).toBe(true)
  await expect(api.pairAndSelectCoreInvitation('invitation', 123)).rejects.toThrow('隧道地址无效')
  expect(saved).toHaveLength(1)
})

test('配对成功但连接失败时保留已保存设备并抛出不含秘密的恢复提示', async () => {
  const { api, calls } = harness(true)
  await expect(api.pairAndSelectCoreInvitation('invitation')).rejects.toThrow('已配对，但连接失败，可在设备列表重试连接')
  expect(calls).toEqual(['save', 'exact-paired-id'])
})

test('保存配对设备即使所有业务探针离线也持久化，且不修改当前目标', async () => {
  const targetSource = readFileSync(new URL('./core-target-service.ts', import.meta.url), 'utf8')
  const start = targetSource.indexOf('export async function savePairedCoreTarget')
  const end = targetSource.indexOf('export function updateCoreTarget', start)
  const saveScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(targetSource.slice(start, end).replace('export ', ''))
  const store = { currentId: 'old', targets: [] as Array<{ id: string; coreId: string; endpoints: unknown[] }> }
  let written = false
  const deps = {
    validName: (name: string) => name, normalizeUrl: (url: string) => url,
    readStore: () => store, verifyEndpoint: async () => { throw new Error('offline') },
    serialize: (fn: () => unknown) => fn(), randomUUID: () => 'precise-id', encryptToken: () => 'encrypted',
    writeStore: () => { written = true }, publishSnapshot: () => {}, summaries: () => store.targets,
  }
  const save = new Function(...Object.keys(deps), `${saveScript}; return savePairedCoreTarget`)(...Object.values(deps))
  const result = await save({ name: 'Device', coreId: 'paired', endpoints: ['https://host:1'], identityPin: `sha256/${'A'.repeat(43)}=`, bindingId: 'binding', credential: 'secret', expiresAt: 9999999999999, tunnel: true })
  expect(result.id).toBe('precise-id')
  expect(result.expiresAt).toBe(9999999999999)
  expect(written).toBe(true)
  expect(store.currentId).toBe('old')
  expect(store.targets[0]?.endpoints).toEqual([expect.objectContaining({ encryptedToken: 'encrypted', bindingId: 'binding', label: '隧道', tunnel: true })])
  expect(JSON.stringify(store)).not.toContain('secret')
})

test('显式隧道失败不尝试LAN备用线路或UDP发现', async () => {
  const text = readFileSync(new URL('./core-target-service.ts', import.meta.url), 'utf8')
  const start = text.indexOf('async function connectTarget(')
  const end = text.indexOf('async function changeRemoteConnection', start)
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(text.slice(start, end))
  const attempts: string[] = []
  let discoveries = 0
  const target = { coreId: 'same', endpoints: [{ id: 'tunnel', identityPin: 'pin', tunnel: true }, { id: 'lan', identityPin: 'pin' }] }
  const deps = {
    selectedEndpoint: () => target.endpoints[0],
    changeRemoteConnection: async (_store: unknown, _target: unknown, endpoint: { id: string }) => { attempts.push(endpoint.id); throw new Error('offline') },
    PairedBindingRejected: class extends Error {}, discoverPairedCore: async () => { discoveries++; return undefined },
  }
  const connect = new Function(...Object.keys(deps), `${code};return connectTarget`)(...Object.values(deps))
  await expect(connect({}, target)).rejects.toThrow('offline')
  expect(attempts).toEqual(['tunnel'])
  expect(discoveries).toBe(0)
})
