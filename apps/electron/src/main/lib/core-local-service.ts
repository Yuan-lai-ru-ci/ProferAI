import type { LocalCoreState } from '../../types/core-connection'

let status: LocalCoreState['status'] = 'starting'
let failure: string | undefined
export function updateLocalCoreStatus(next: LocalCoreState['status'], error?: string): void { status = next; failure = error }
export function getLocalCoreState(): LocalCoreState {
  return { status: failure ? 'failed' : status, ...(failure ? { error: failure } : {}) }
}
let restart: (() => Promise<void>) | undefined
let retrying: Promise<LocalCoreState> | undefined
export function configureLocalCoreRetry(callback: () => Promise<void>): void { restart = callback }
export async function retryLocalCore(): Promise<LocalCoreState> {
  if (retrying) return retrying
  if (getLocalCoreState().status === 'running') return getLocalCoreState()
  if (!restart) throw new Error('本机 Core 恢复入口尚未初始化')
  updateLocalCoreStatus('starting')
  retrying = restart().then(() => getLocalCoreState()).catch(error => {
    updateLocalCoreStatus('failed', error instanceof Error ? error.message : String(error))
    throw error
  }).finally(() => { retrying = undefined })
  return retrying
}
