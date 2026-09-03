import { describe, expect, test } from 'bun:test'
import { createIsolatedModelRuntimeOptions, IsolatedInMemoryCredentialStore } from './pi-model-runtime-options'

describe('Pi ModelRuntime 全局目录隔离', () => {
  test('Given 未指定凭据存储 When 创建配置 Then 凭据与模型缓存都只使用内存', () => {
    const options = createIsolatedModelRuntimeOptions()

    expect(options.credentials).toBeInstanceOf(IsolatedInMemoryCredentialStore)
    expect(options.modelsPath).toBeNull()
    expect(options.allowModelNetwork).toBe(false)
  })

  test('Given OAuth 专用内存存储 When 创建配置 Then 保留该存储且禁用全局模型缓存', () => {
    const credentials = new IsolatedInMemoryCredentialStore()

    expect(createIsolatedModelRuntimeOptions(credentials)).toEqual({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    })
  })

  test('Given 同一 provider 的并发写入 When 修改凭据 Then 按提交顺序序列化', async () => {
    const credentials = new IsolatedInMemoryCredentialStore()
    const first = credentials.modify('provider', async () => ({ type: 'api_key', key: 'first' }))
    const second = credentials.modify('provider', async (current) => ({
      type: 'api_key',
      key: `${current?.type === 'api_key' ? current.key : ''}-second`,
    }))

    await expect(first).resolves.toMatchObject({ key: 'first' })
    await expect(second).resolves.toMatchObject({ key: 'first-second' })
    await expect(credentials.read('provider')).resolves.toMatchObject({ key: 'first-second' })
  })
})
