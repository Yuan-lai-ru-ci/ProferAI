import type { UpdateSource } from './update-sources'

export async function runWithUpdateSourceFallback<T>(
  sources: readonly UpdateSource[],
  attempt: (source: UpdateSource) => Promise<T>,
  onFailure?: (source: UpdateSource, error: unknown) => void,
): Promise<T> {
  const failures: string[] = []

  for (const source of sources) {
    try {
      return await attempt(source)
    } catch (error) {
      failures.push(`${source.label}: ${error instanceof Error ? error.message : String(error)}`)
      onFailure?.(source, error)
    }
  }

  throw new Error(failures.join('；') || '所有更新源均不可用')
}
