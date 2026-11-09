/**
 * 工作区级串行任务队列（按 key 分链）。
 *
 * Shadow Git 的写入（建对象、合成 tree、更新 ref）必须串行，否则两个 session
 * 同时提交会互相覆盖 ref；但不同工作区之间没有共享资源，串行它们只会白白拖慢。
 * 所以按 key（workspaceId）分链：同 key 严格 FIFO，跨 key 并行。
 *
 * 为什么不用一个全局锁：一次采集可能上百毫秒，全局锁会让用户在多工作区间切换时
 * 明显卡顿；按 key 锁正好匹配「一个工作区一个 shadow repo」的物理边界。
 */
export class WorkspaceTaskQueue {
  /** key → 链尾。链尾永远 resolve，reject 只回给各自的调用方。 */
  #chains = new Map<string, Promise<void>>()
  /** key → 未完成任务数；归零即删键，避免长跑进程中无限增长。 */
  #pending = new Map<string, number>()

  /**
   * 排入任务。返回的 promise 透传任务结果/异常。
   *
   * 任务同步抛错也会变成 reject：调用点统一按 promise 失败处理，不需要两套错误路径。
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('WorkspaceTaskQueue.run: key 不能为空字符串')
    }
    if (typeof task !== 'function') {
      throw new Error('WorkspaceTaskQueue.run: task 必须是函数')
    }

    const previous = this.#chains.get(key) ?? Promise.resolve()
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1)

    // previous 一定是链尾（永不 reject），所以这里的 then 不会跳过任务。
    const result = previous.then(() => task())
    // 链尾吞掉结果与异常：前一个任务失败绝不能污染后续任务，
    // 而 result 自身的 reject 仍然完整返回给调用方。
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#chains.set(key, tail)

    void tail.then(() => {
      // 只有当自己还是链尾时才清理：期间若有新任务入队，链尾已经被替换。
      if (this.#chains.get(key) === tail) this.#chains.delete(key)
      const remaining = (this.#pending.get(key) ?? 1) - 1
      if (remaining <= 0) this.#pending.delete(key)
      else this.#pending.set(key, remaining)
    })

    return result
  }

  /** 该 key 尚未完成的任务数（含正在执行的）。 */
  pending(key: string): number {
    return this.#pending.get(key) ?? 0
  }

  /**
   * 等待某个 key 的链空闲。
   *
   * 用于「下一个 turn 开始前，确认上一轮的后台采集已经落盘」：不等待就会把本轮的写入
   * 并进上一份快照，turn 边界随之失真。链尾永不 reject，所以这里不会抛。
   */
  async drainKey(key: string): Promise<void> {
    for (;;) {
      const tail = this.#chains.get(key)
      if (!tail) return
      await tail
      // 链尾已结算且没有被替换 → 这个 key 真的空闲了。
      // 若等待期间又排入新任务，链尾会变成另一个 promise，继续等。
      const current = this.#chains.get(key)
      if (current === undefined || current === tail) return
    }
  }

  /**
   * 等待所有 key 的链结束，包括等待期间新排入的任务。
   *
   * 循环而不是等一次：快照之后随时可能入队，只有「再取一次快照仍为空」才说明真的静默了。
   * 链尾永不 reject，所以这里不需要也不允许 reject。
   */
  async drain(): Promise<void> {
    for (;;) {
      const chains = [...this.#chains.values()]
      if (chains.length === 0) return
      await Promise.allSettled(chains)
      // 清理回调在链尾 resolve 时已注册且先于本函数继续执行；
      // 仍非空说明等待期间又来了新任务，继续下一轮。
      if (this.#chains.size === 0) return
    }
  }
}
