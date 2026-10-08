import { describe, expect, test } from 'bun:test'
import { describeProbeOutcomes, orderSourcesByReachability } from './update-probe'
import { getUpdateSources, type UpdateSource } from './update-sources'

function ids(sources: readonly UpdateSource[]): string[] {
  return sources.map((source) => source.id)
}

describe('更新源探活排序', () => {
  test('可达源按延迟升序排列，不参与探测的 GitHub 保持在末尾', async () => {
    const ordered = await orderSourcesByReachability(
      getUpdateSources(undefined),
      async (source) => {
        if (source.id === 'domestic') {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return true
        }
        if (source.id === 'domestic-fallback') return true
        return false
      },
    )

    expect(ids(ordered)).toEqual(['domestic-fallback', 'domestic', 'github'])
  })

  test('探活不可达的源从尝试序列中摘掉，不再让它吃满 30s 请求超时', async () => {
    const ordered = await orderSourcesByReachability(
      getUpdateSources(undefined),
      async (source) => source.id === 'domestic',
    )

    expect(ids(ordered)).toEqual(['domestic', 'github'])
  })

  test('探活抛异常按不可达处理，不中断整体探测', async () => {
    const ordered = await orderSourcesByReachability(
      getUpdateSources(undefined),
      async (source) => {
        if (source.id === 'domestic') throw new Error('ECONNRESET')
        return true
      },
    )

    expect(ids(ordered)).toEqual(['domestic-fallback', 'github'])
  })

  test('全部不可达时退回原始声明顺序，不摘掉任何源', async () => {
    const ordered = await orderSourcesByReachability(
      getUpdateSources(undefined),
      async () => false,
    )

    expect(ids(ordered)).toEqual(['domestic', 'domestic-fallback', 'github'])
  })

  test('探活整体失败时不放弃所有源（探测可能被代理策略挡住而真实请求可通）', async () => {
    const ordered = await orderSourcesByReachability(
      getUpdateSources(undefined),
      async () => { throw new Error('probe blocked') },
    )

    expect(ids(ordered)).toEqual(['domestic', 'domestic-fallback', 'github'])
  })

  test('环境变量覆盖源同样参与探测', async () => {
    const ordered = await orderSourcesByReachability(
      getUpdateSources('https://updates.example.com/profer/'),
      async (source) => source.id === 'override' || source.id === 'domestic',
    )

    expect(ids(ordered)).toEqual(['override', 'domestic', 'github'])
  })

  test('描述串列出被跳过的源，便于排查', async () => {
    const declared = getUpdateSources(undefined)
    const ordered = await orderSourcesByReachability(declared, async (source) => source.id === 'domestic')

    const described = describeProbeOutcomes(declared, ordered)
    expect(described).toContain('domestic')
    expect(described).toContain('domestic-fallback')
    expect(described).toContain('跳过')
  })
})
