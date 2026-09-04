export interface PiInterruptReservation {
  contentReady: Promise<string>
  resolveAccepted: () => void
  rejectAccepted: (error: unknown) => void
}

export interface PiPromptChainState {
  abortRequested: boolean
  interrupting: boolean
  pendingInterruptPrompts: PiInterruptReservation[]
}

export interface PiPromptChainDependencies {
  prompt: (content: string) => Promise<void>
  prepareInitialPrompt: (content: string) => Promise<string>
  shouldStopBeforeNextTurn: () => boolean
  rejectPendingInterruptPrompts: (error: unknown) => void
  createAbortError: () => Error
  dropTrailingAbortedAssistant: () => void
}

/**
 * Pi 的单一 prompt owner。interrupt 只登记续轮 reservation 并 abort 当前 session；
 * 本链路始终等待当前 prompt 真正 settle 后才消费 reservation，避免并行 prompt 和未关闭的事件流。
 */
export async function runPiPromptChain(
  initialPrompt: string,
  state: PiPromptChainState,
  deps: PiPromptChainDependencies,
): Promise<void> {
  let nextPrompt: string | undefined = initialPrompt
  let nextInterrupt: PiInterruptReservation | undefined

  while (nextPrompt !== undefined) {
    const currentInterrupt = nextInterrupt
    nextInterrupt = undefined
    if (deps.shouldStopBeforeNextTurn()) {
      const error = deps.createAbortError()
      currentInterrupt?.rejectAccepted(error)
      deps.rejectPendingInterruptPrompts(error)
      return
    }

    let prompt: string
    try {
      prompt = await deps.prepareInitialPrompt(nextPrompt)
    } catch (error) {
      // 失败即中断整链：当前 interrupt 与队内未消费的 reservation 全部 reject，
      // 否则其 accepted promise 悬挂到 cleanup 才 settle，渲染层“发送”状态会卡住数秒。
      currentInterrupt?.rejectAccepted(error)
      deps.rejectPendingInterruptPrompts(error)
      throw error
    }
    nextPrompt = undefined

    try {
      if (state.abortRequested) {
        if (currentInterrupt && state.pendingInterruptPrompts.length > 0) {
          // R1 已经从 pending 取出，R2 的 abort 不能令 R1 无 receipt 地消失。
          // 先正式开始 R1；R2 会在 R1 settle 后按 FIFO 成为下一轮。
          state.abortRequested = false
          currentInterrupt.resolveAccepted()
          await deps.prompt(prompt)
        } else if (state.pendingInterruptPrompts.length > 0) {
          // 初始 prompt 尚未开始时收到 reservation：跳过旧 prompt，转去消费队首。
          state.abortRequested = false
        } else {
          const error = deps.createAbortError()
          currentInterrupt?.rejectAccepted(error)
          deps.rejectPendingInterruptPrompts(error)
          return
        }
      } else {
        currentInterrupt?.resolveAccepted()
        await deps.prompt(prompt)
      }
    } finally {
      if (state.interrupting) deps.dropTrailingAbortedAssistant()
      state.interrupting = false
    }

    if (state.abortRequested) {
      if (state.pendingInterruptPrompts.length > 0) {
        state.abortRequested = false
      } else {
        deps.rejectPendingInterruptPrompts(deps.createAbortError())
        return
      }
    }
    if (deps.shouldStopBeforeNextTurn()) {
      deps.rejectPendingInterruptPrompts(deps.createAbortError())
      return
    }

    const pendingInterrupt = state.pendingInterruptPrompts.shift()
    if (pendingInterrupt) {
      nextInterrupt = pendingInterrupt
      try {
        nextPrompt = await pendingInterrupt.contentReady
      } catch (error) {
        pendingInterrupt.rejectAccepted(error)
        throw error
      }
      continue
    }
  }
}
