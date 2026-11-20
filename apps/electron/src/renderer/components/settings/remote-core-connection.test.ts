import { describe, expect, mock, test } from 'bun:test'
import { saveVerifiedConnection } from './remote-core-connection'

const input = { name: 'Linux', baseUrl: 'https://core.example.com', token: 'fixture-secret' }
const sameCore = { id: 'saved', kind: 'remote', coreId: 'core-a', name: '已保存', status: 'connected' } as const

function fixture(coreId = 'core-a') {
  const testCoreTarget = mock(async () => ({ coreId }))
  const addCoreTarget = mock(async () => {})
  return { testCoreTarget, addCoreTarget }
}

describe('验证并保存远程内核', () => {
  test('验证后绑定已验证的身份，不选择运行环境', async () => {
    const api = fixture()
    expect(await saveVerifiedConnection(api, input, [], async () => true)).toBe(true)
    expect(api.testCoreTarget).toHaveBeenCalledWith(input)
    expect(api.addCoreTarget).toHaveBeenCalledWith({ ...input, expectedCoreId: 'core-a' })
  })

  test('相同 Core 的新地址需征得确认才保存', async () => {
    const api = fixture()
    const confirm = mock(async () => false)
    expect(await saveVerifiedConnection(api, input, [sameCore], confirm)).toBe(false)
    expect(confirm).toHaveBeenCalledWith(sameCore)
    expect(api.addCoreTarget).not.toHaveBeenCalled()
  })

  test('确认添加第二条线路后仍绑定同一身份', async () => {
    const api = fixture()
    expect(await saveVerifiedConnection(api, input, [sameCore], async () => true)).toBe(true)
    expect(api.addCoreTarget).toHaveBeenCalledWith({ ...input, expectedCoreId: sameCore.coreId })
  })

  test('已保存地址返回不同身份时不替换', async () => {
    const api = fixture('other-core')
    const targets = [{ ...sameCore, baseUrl: input.baseUrl }]
    await expect(saveVerifiedConnection(api, input, targets, async () => true)).rejects.toThrow('不同的 Core')
    expect(api.addCoreTarget).not.toHaveBeenCalled()
  })

  test('所有版本允许 loopback HTTP 隧道，公网 HTTP 和 URL 凭据始终拒绝', async () => {
    const api = fixture()
    expect(await saveVerifiedConnection(api, { ...input, baseUrl: 'http://127.0.0.1:17788' }, [], async () => true)).toBe(true)
    expect(api.testCoreTarget).toHaveBeenCalledWith({ ...input, baseUrl: 'http://127.0.0.1:17788' })
    for (const baseUrl of ['http://core.example.com', 'http://192.168.1.10:17788']) {
      await expect(saveVerifiedConnection(api, { ...input, baseUrl }, [], async () => true)).rejects.toThrow('HTTPS')
    }
  })

  test('拒绝带凭据的 HTTPS 地址，不发起验证', async () => {
    const api = fixture()
    await expect(saveVerifiedConnection(api, { ...input, baseUrl: 'https://user:pass@core.example.com' }, [], async () => true)).rejects.toThrow('HTTPS')
    expect(api.testCoreTarget).not.toHaveBeenCalled()
  })

  test('验证错误保留诊断，不保存', async () => {
    const api = { ...fixture(), testCoreTarget: async () => { throw new Error('TLS 证书校验失败') } }
    await expect(saveVerifiedConnection(api, input, [], async () => true)).rejects.toThrow('TLS 证书校验失败')
    expect(api.addCoreTarget).not.toHaveBeenCalled()
  })
})
