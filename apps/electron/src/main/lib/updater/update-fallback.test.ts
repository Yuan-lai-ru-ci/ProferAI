import { describe, expect, test } from 'bun:test'
import { runWithUpdateSourceFallback } from './update-fallback'
import { getUpdateSources } from './update-sources'

describe('更新源回退', () => {
  test('国内源下载失败后继续尝试 GitHub', async () => {
    const attempted: string[] = []
    const result = await runWithUpdateSourceFallback(
      getUpdateSources(undefined),
      async (source) => {
        attempted.push(source.id)
        if (source.id === 'domestic') throw new Error('ECONNRESET')
        return source.id
      },
    )

    expect(attempted).toEqual(['domestic', 'github'])
    expect(result).toBe('github')
  })

  test('所有源失败才返回聚合错误', async () => {
    await expect(runWithUpdateSourceFallback(
      getUpdateSources(undefined),
      async (source) => { throw new Error(`${source.id} unavailable`) },
    )).rejects.toThrow('国内更新服务器: domestic unavailable；GitHub Releases: github unavailable')
  })
})
