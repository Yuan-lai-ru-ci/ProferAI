import { AgentRunLedger, type RunLedgerPort } from '@profer/agent-runtime'
import { createFileRunLedgerPort } from '@profer/session-store'

/** 两条执行链共用一个文件账本；先对账旧进程，未知副作用不自动重放。 */
export function createDesktopRunLedger(resolvePath: () => string): {
  ledger: AgentRunLedger
  initialize(): void
} {
  let filePort: RunLedgerPort | undefined
  let initialized = false
  let initializationError: unknown
  let initializationFailed = false
  const file = (): RunLedgerPort => filePort ??= createFileRunLedgerPort(resolvePath())
  const ledger = new AgentRunLedger({
    load() {
      initialize()
      return file().load()
    },
    save: snapshot => file().save(snapshot),
  })
  function initialize(): void {
    if (initializationFailed) throw initializationError
    if (initialized) return
    // 同步重入只用于 reconcile 自己读取账本，尚未向任何运行入口开放。
    initialized = true
    try {
      ledger.reconcileInterrupted()
    } catch (error) {
      initialized = false
      initializationFailed = true
      initializationError = error
      throw error
    }
  }
  return { ledger, initialize }
}
