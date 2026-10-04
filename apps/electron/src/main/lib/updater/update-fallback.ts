import type { UpdateSource } from './update-sources'

export async function runWithUpdateSourceFallback<T>(
  sources: readonly UpdateSource[],
  attempt: (source: UpdateSource) => Promise<T>,
  onFailure?: (source: UpdateSource, error: unknown) => void,
): Promise<T> {
  const failures: string[] = []
  let hasSuccessfulNoUpdate = false

  for (const source of sources) {
    try {
      const result = await attempt(source)
      // `false` means the source is reachable but has no applicable update.
      // Continue so a stale domestic mirror cannot hide a newer fallback release.
      if (result === false) {
        hasSuccessfulNoUpdate = true
        continue
      }
      return result
    } catch (error) {
      failures.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`)
      onFailure?.(source, error)
    }
  }

  if (hasSuccessfulNoUpdate) return false as T
  throw new Error(failures.join('；') || '所有更新源均不可用')
}
