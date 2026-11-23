import { isIndependentLocalCore } from './core-local-mode'
import type { CoreClient } from './core-client'

type AccountClient = Pick<CoreClient, 'accountOperation'> & Partial<Pick<CoreClient, 'addAccountEventListener' | 'addWorkspaceEventListener'>> & { readonly isConnected?: boolean }

export interface LocalAccountSnapshot {
  status: { isLoggedIn: boolean; teamAccountId?: string; teamEmail?: string; commercialMode?: boolean; isAdmin?: boolean }
  auth: { baseUrl: string; token: string; proxyToken?: string; membershipTier?: string; teamEmail?: string; teamAccountId?: string } | null
}

/** 账号永远属于本机 owner；不跟随当前选中的远端执行目标。 */
export function createLocalAccountRouter(deps: { independent(): boolean; client(): AccountClient | null }) {
  let cached: { client: AccountClient; snapshot: LocalAccountSnapshot } | undefined
  let generation = 0
  let observedClient: AccountClient | undefined
  let unsubscribe: (() => void) | undefined
  let unsubscribeWorkspace: (() => void) | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let refreshQueued = false
  let ownOperation = false
  const capture = () => {
    const client = deps.client()
    if (!deps.independent() || !client || client.isConnected === false) {
      cached = undefined
      generation++
      throw new Error('本机 Core 账号服务未连接')
    }
    if (observedClient !== client) {
      unsubscribe?.()
      unsubscribeWorkspace?.()
      observedClient = client
      unsubscribe = client.addAccountEventListener?.(() => { if (!ownOperation) invalidate(client) })
      unsubscribeWorkspace = client.addWorkspaceEventListener?.(() => { if (!ownOperation) invalidate(client) })
    }
    return client
  }
  const invalidate = (client: AccountClient) => {
    if (deps.client() !== client || !deps.independent()) return
    cached = undefined
    generation++
    if (refreshQueued) return
    refreshQueued = true
    queue = queue.then(async () => {
      refreshQueued = false
      const current = deps.client()
      if (!current || !deps.independent() || current.isConnected === false) return
      await loadSnapshot(current)
    }).catch(() => { refreshQueued = false })
  }
  const check = (client: AccountClient, epoch: number) => {
    if (!deps.independent() || client.isConnected === false || deps.client() !== client || epoch !== generation) throw new Error('本机 Core 账号会话已切换，请重试')
  }
  const loadSnapshot = async (client: AccountClient) => {
    // HTTP完成后，同一操作的WS目录通知仍可能晚到；只重读快照，不重发登录等写操作。
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = generation
      const status = await client.accountOperation<LocalAccountSnapshot['status']>('status')
      if (!deps.independent() || client.isConnected === false || deps.client() !== client) check(client, epoch)
      if (epoch !== generation) continue
      const auth = await client.accountOperation<LocalAccountSnapshot['auth']>('teamAuth')
      if (!deps.independent() || client.isConnected === false || deps.client() !== client) check(client, epoch)
      if (epoch !== generation) continue
      cached = { client, snapshot: { status, auth } }
      return cached.snapshot
    }
    throw new Error('本机 Core 账号状态正在变化，请重试')
  }
  return {
    snapshot(): LocalAccountSnapshot {
      const client = capture()
      if (!cached || cached.client !== client) {
        invalidate(client)
        throw new Error('本机 Core 账号状态尚未加载，正在恢复')
      }
      return cached.snapshot
    },
    operation<T>(operation: string, args: unknown[] = []): Promise<T> {
      // UI 初始化会并发请求 status/OTP 选项；顺序读取确保快照不会互相覆盖。
      const requestedClient = capture()
      const run = async (): Promise<T> => {
        const client = capture()
        if (client !== requestedClient) throw new Error('本机 Core 账号会话已切换，请重试')
        const epoch = ++generation
        try {
          ownOperation = true
          let result: T
          try { result = await client.accountOperation<T>(operation, args) } finally { ownOperation = false }
          // 操作自身可触发目录事件；仍复核 owner，但快照使用最新世代重读。
          if (!deps.independent() || deps.client() !== client || client.isConnected === false) throw new Error('本机 Core 账号会话已切换，请重试')
          await loadSnapshot(client)
          return result
        } catch (error) {
          if (epoch === generation) cached = undefined
          throw error
        }
      }
      const pending = queue.then(run, run)
      queue = pending.catch(() => undefined)
      return pending
    },
  }
}

export const localAccount = createLocalAccountRouter({
  independent: isIndependentLocalCore,
  // 延迟读取桥接，避免 commercial → auth → bridge → edition 的装配循环。
  client: () => (require('./core-local-bridge') as typeof import('./core-local-bridge')).getLocalCoreClient(),
})
