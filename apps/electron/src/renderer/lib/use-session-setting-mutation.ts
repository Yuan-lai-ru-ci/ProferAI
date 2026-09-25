import * as React from 'react'

export interface SessionSettingMutationInput<T> {
  execute: (expectedRevision?: number) => Promise<T>
  applyOptimistic?: () => void
  applyAuthoritative: (value: T) => void
  rollback: () => void
  onError?: (error: unknown) => void
}

export function useSessionSettingMutation(): {
  pending: boolean
  mutate: <T>(input: SessionSettingMutationInput<T>, expectedRevision?: number) => Promise<T | undefined>
} {
  const requestSequenceRef = React.useRef(0)
  const [pending, setPending] = React.useState(false)

  const mutate = React.useCallback(async <T,>(input: SessionSettingMutationInput<T>, expectedRevision?: number): Promise<T | undefined> => {
    const requestSequence = ++requestSequenceRef.current
    setPending(true)
    input.applyOptimistic?.()
    try {
      const updated = await input.execute(expectedRevision)
      if (requestSequence !== requestSequenceRef.current) return undefined
      input.applyAuthoritative(updated)
      return updated
    } catch (error) {
      if (requestSequence !== requestSequenceRef.current) return undefined
      input.rollback()
      input.onError?.(error)
      return undefined
    } finally {
      if (requestSequence === requestSequenceRef.current) setPending(false)
    }
  }, [])

  return { pending, mutate }
}

/** 只有最新的本地设置请求可以提交回执；旧回执必须被丢弃。 */
export function isLatestSessionSettingRequest(sequence: number, latest: number): boolean {
  return sequence === latest
}
