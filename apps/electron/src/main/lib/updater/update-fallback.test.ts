import { describe, expect, test } from 'bun:test'
import { runWithUpdateSourceFallback } from './update-fallback'
import { getUpdateSources } from './update-sources'

describe('更新源回退', () => {
  test('国内双源失败后继续尝试 GitHub', async () => {
    const attempted: string[] = []
    const result = await runWithUpdateSourceFallback(
      getUpdateSources(undefined),
      async (source) => {
        attempted.push(source.id)
        if (source.id === 'domestic' || source.id === 'domestic-fallback') throw new Error('ECONNRESET')
        return source.id
      },
    )

    expect(attempted).toEqual(['domestic', 'domestic-fallback', 'github'])
    expect(result).toBe('github')
  })

  test('国内源返回旧版本时继续尝试 GitHub', async () => {
    const attempted: string[] = []
    const result = await runWithUpdateSourceFallback(
      getUpdateSources(undefined),
      async (source) => {
        attempted.push(source.id)
        if (source.id === 'domestic' || source.id === 'domestic-fallback') return false
        return source.id
      },
    )

    expect(attempted).toEqual(['domestic', 'domestic-fallback', 'github'])
    expect(result).toBe('github')
  })

  test('所有源都没有新版本时返回 false', async () => {
    const result = await runWithUpdateSourceFallback(
      getUpdateSources(undefined),
      async () => false,
    )

    expect(result).toBe(false)
  })

  test('所有源失败才返回聚合错误', async () => {
    await expect(runWithUpdateSourceFallback(
      getUpdateSources(undefined),
      async (source) => { throw new Error(`${source.id} unavailable`) },
    )).rejects.toThrow('国内更新服务器: domestic unavailable；备用国内更新源: domestic-fallback unavailable；GitHub Releases: github unavailable')
  })
})
