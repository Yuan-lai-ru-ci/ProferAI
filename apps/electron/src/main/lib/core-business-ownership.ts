import { getLocalCoreClient } from './core-local-bridge'

let localCoreClaimed = false

/** 本进程接管是单向的；断连不是把业务写权退还桌面的授权。 */
export function localCoreOwnsBusinessData(): boolean {
  if (process.env.PROFER_CORE_LOCAL === '1' || getLocalCoreClient() !== null) localCoreClaimed = true
  return localCoreClaimed
}
