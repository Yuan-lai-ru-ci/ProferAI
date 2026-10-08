import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = mkdtempSync(join(tmpdir(), 'profer-identity-fixture-'))
const originalConfigDir = process.env.PROFER_CONFIG_DIR
process.env.PROFER_CONFIG_DIR = configDir
const writes: string[] = []
let reads = 0
mock.module('./device-durable-store', () => ({
  readDurableDeviceId: () => { reads += 1; return 'fixture-durable-device' },
  writeDurableDeviceId: (id: string) => writes.push(id),
}))
const { getOrCreateDeviceIdentity, updateDeviceName } = await import('./identity-service')

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.PROFER_CONFIG_DIR
  else process.env.PROFER_CONFIG_DIR = originalConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

test('Given 缓存与 OS fixture 身份不同 When 解析 Then OS 身份优先且保留设备元数据与缓存', () => {
  const identityPath = join(configDir, 'device.json')
  writeFileSync(identityPath, JSON.stringify({ deviceId: 'fixture-old-device', deviceName: 'Fixture device', registeredAt: 1 }))
  const identity = getOrCreateDeviceIdentity()
  expect(identity).toEqual({ deviceId: 'fixture-durable-device', deviceName: 'Fixture device', registeredAt: 1 })
  expect(JSON.parse(readFileSync(identityPath, 'utf8'))).toEqual(identity)
  expect(getOrCreateDeviceIdentity()).toBe(identity)
  expect(reads).toBe(1)
  expect(writes).toEqual([])
  expect(updateDeviceName('Fixture renamed').deviceId).toBe('fixture-durable-device')
  expect(JSON.parse(readFileSync(identityPath, 'utf8')).deviceName).toBe('Fixture renamed')
})
