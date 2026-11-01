/**
 * 退出清理的硬预算。
 *
 * 背景：`before-quit` 里曾经 `await stopRemoteService()`，而这个 promise 没有超时。
 * 远控/FRP 的生命周期是串行队列（`RemoteLifecycleQueue`），队列里只要有在跑的操作——
 * 典型是启动隧道时 `ensureFrpMaterial()` 从 GitHub 下载 frpc（超时上限 120s）——退出就
 * 会无限期挂起。用户看到的是「点退出没反应」；更糟的是更新流程：
 *
 * - macOS：`quitAndInstall()` 之后 Squirrel 的 ShipIt 要等旧进程退出才替换 /Applications；
 * - Windows：NSIS 安装器已经在 `doInstall()` 里拉起，会一直等旧进程释放被占用的 exe。
 *
 * 所以「关不掉」不只是体验问题，它直接让一次已经下载完 200MB+ 的更新装不上。
 *
 * 结论：退出清理只能「尽力而为」。超过预算就继续退出，残留子进程交给下次启动的孤儿
 * 清理，绝不允许把「关不掉」当成可接受的代价。
 */

export type QuitCleanupOutcome = 'completed' | 'timeout' | 'failed'

export interface QuitCleanupResult {
  outcome: QuitCleanupOutcome
  /** 实际耗时，便于日志判断是「真的慢」还是「直接失败」。 */
  elapsedMs: number
  error?: string
}

/**
 * 退出清理预算。3s 足够覆盖正常情况（停监听、关 ws、杀 frpc 各在毫秒级），
 * 又短到用户不会觉得「点了没反应」。可用环境变量收紧/放宽以便现场排障。
 */
export function resolveQuitCleanupTimeoutMs(raw = process.env.PROFER_QUIT_CLEANUP_TIMEOUT_MS): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3_000
}

/**
 * 等待清理任务，但绝不超过预算。
 *
 * 三种结果都必须让调用方继续退出：`completed` 是正常路径，`timeout` / `failed`
 * 只值得写一条日志——因为卡住的清理任务已经不可能再被等回来。
 */
export function awaitQuitCleanup(
  task: Promise<unknown>,
  timeoutMs: number = resolveQuitCleanupTimeoutMs(),
): Promise<QuitCleanupResult> {
  const startedAt = Date.now()
  return new Promise<QuitCleanupResult>((resolve) => {
    let settled = false
    const finish = (result: QuitCleanupResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      finish({ outcome: 'timeout', elapsedMs: Date.now() - startedAt })
    }, timeoutMs)
    // 计时器不应拖住主进程退出：它只是在等一个可能永远不回来的 promise。
    ;(timer as unknown as { unref?: () => void }).unref?.()

    task.then(
      () => finish({ outcome: 'completed', elapsedMs: Date.now() - startedAt }),
      (error: unknown) => finish({
        outcome: 'failed',
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  })
}
