/**
 * 协作子会话阻塞（提问 / 权限审批）的宿主无关处理。
 *
 * 目标：子会话被阻塞时，父会话获得**一次**决策机会——
 * - 能从用户原始要求、任务说明或已核验上下文确定答案 → 调用代答工具继续子会话；
 * - 确定不了（用户偏好、取舍、外部事实、高风险授权）→ 不猜测，问题留在用户界面由用户回答。
 *
 * 边界：
 * - 这里只持有阻塞事件状态、唤醒决策、提示词与等待竞速，不启动 run、不发 IPC、不读写会话。
 *   真正的唤醒由宿主注入（Electron 侧走 headless run），因此 Claude / Pi 与其他宿主共用同一套判定。
 * - 「转交用户」不是额外动作：阻塞事件本身已经进入用户界面；父会话不代答即等于转交。
 *   本模块只保证同一事件不重复唤醒，避免父会话被反复拉起。
 * - 权限类阻塞默认归用户决定：父会话只有在用户本轮已明确授权时才可代答 allow。
 */

import type {
  DelegationBlockedEvent,
  DelegationBlockedKind,
  DelegationBlockedQuestion,
  DelegationBlockedResolution,
} from '@profer/shared'

// ===== 注册表 =====

export interface RegisterDelegationBlockedInput {
  delegationId: string
  childSessionId: string
  kind: DelegationBlockedKind
  /** 子会话侧请求 ID（ask_user / permission）。 */
  requestId: string
  questions?: readonly DelegationBlockedQuestion[]
  toolName?: string
}

export interface DelegationBlockedRegistryOptions {
  now?: () => number
  /** 已解决事件保留上限；超出按创建时间淘汰，避免长进程无限增长。 */
  maxRetained?: number
  /** 事件 ID 生成器；默认用 `globalThis.crypto.randomUUID`，无 crypto 时退化为进程内序号。 */
  createId?: () => string
}

let fallbackSequence = 0

function defaultCreateId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID()
  fallbackSequence += 1
  return `delegation-blocked-${Date.now()}-${fallbackSequence}`
}

const DEFAULT_MAX_RETAINED = 200

/**
 * 进程内阻塞事件表。
 *
 * 只保存「子会话正在等回答」这一事实与唤醒标记；不保存工具原始输入，
 * 也不解释回答内容——回答由宿主交给子会话的 ask_user / permission 服务。
 */
export class DelegationBlockedRegistry {
  private readonly events = new Map<string, DelegationBlockedEvent>()
  private readonly listeners = new Set<(event: DelegationBlockedEvent) => void>()
  private readonly now: () => number
  private readonly maxRetained: number
  private readonly createId: () => string

  constructor(options: DelegationBlockedRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.maxRetained = options.maxRetained ?? DEFAULT_MAX_RETAINED
    this.createId = options.createId ?? defaultCreateId
  }

  register(input: RegisterDelegationBlockedInput): DelegationBlockedEvent {
    // 同一请求重复上报（重放/重连）不能变成两个阻塞事件，否则父会话会被重复唤醒。
    const existing = [...this.events.values()].find((item) => item.delegationId === input.delegationId
      && item.requestId === input.requestId
      && !item.resolvedAt)
    if (existing) return existing

    const event: DelegationBlockedEvent = {
      id: this.createId(),
      delegationId: input.delegationId,
      childSessionId: input.childSessionId,
      kind: input.kind,
      requestId: input.requestId,
      questions: input.questions ? input.questions.map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options.map((option) => ({ label: option.label, description: option.description })),
      })) : undefined,
      toolName: input.toolName,
      createdAt: this.now(),
    }
    this.events.set(event.id, event)
    this.prune()
    // 监听方（等待中的父会话）出错不能阻断阻塞登记本身。
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // 监听方异常由各自宿主记录；注册表只保证事件状态一致。
      }
    }
    return event
  }

  get(id: string): DelegationBlockedEvent | undefined {
    return this.events.get(id)
  }

  /** 未解决的阻塞事件；传 delegationIds 时只返回这些委派下的。 */
  pendingFor(delegationIds?: readonly string[]): DelegationBlockedEvent[] {
    const scope = delegationIds ? new Set(delegationIds) : undefined
    return [...this.events.values()]
      .filter((event) => !event.resolvedAt && (!scope || scope.has(event.delegationId)))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  resolve(id: string, resolution: DelegationBlockedResolution): boolean {
    const event = this.events.get(id)
    if (!event || event.resolvedAt) return false
    event.resolvedAt = this.now()
    event.resolution = resolution
    return true
  }

  resolveByRequestId(requestId: string, resolution: DelegationBlockedResolution): DelegationBlockedEvent | undefined {
    const event = [...this.events.values()].find((item) => item.requestId === requestId && !item.resolvedAt)
    if (!event) return undefined
    this.resolve(event.id, resolution)
    return event
  }

  /** 标记父会话已被唤醒；返回 false 表示该事件已解决、已转交或已唤醒过。 */
  markWoken(id: string): boolean {
    const event = this.events.get(id)
    if (!event || event.resolvedAt || event.escalatedAt || event.wokenAt) return false
    event.wokenAt = this.now()
    return true
  }

  /** 标记父会话无法决定、问题已留在用户界面；返回 false 表示已解决或已标记过。 */
  markEscalated(id: string): boolean {
    const event = this.events.get(id)
    if (!event || event.resolvedAt || event.escalatedAt) return false
    event.escalatedAt = this.now()
    return true
  }

  /** 委派结束时清掉它名下的阻塞事件，避免等待方被已结束的子会话唤醒。 */
  clearDelegation(delegationId: string): void {
    for (const [id, event] of this.events) {
      if (event.delegationId === delegationId) this.events.delete(id)
    }
  }

  onBlocked(listener: (event: DelegationBlockedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private prune(): void {
    const finished = [...this.events.values()].filter((event) => !!event.resolvedAt)
    const excess = finished.length - this.maxRetained
    if (excess <= 0) return
    finished
      .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))
      .slice(0, excess)
      .forEach((event) => this.events.delete(event.id))
  }
}

// ===== 等待：完成 / 阻塞 / 超时三态竞速 =====

export interface DelegationProgressWaitInput {
  registry: DelegationBlockedRegistry
  delegationIds: readonly string[]
  /** 完成目标达成时 resolve；由宿主把子会话完成信号接进来。 */
  completed: Promise<void>
  /** 同步判定完成目标是否已达成；用于在阻塞与完成同时到达时优先返回完成。 */
  isCompleted?: () => boolean
  timeoutMs: number
  /** 进入等待前已经挂起的阻塞事件；避免「注册早于等待」被漏掉。 */
  initialBlocked?: readonly DelegationBlockedEvent[]
}

export type DelegationProgressWaitResult =
  | { status: 'completed' }
  | { status: 'blocked'; event: DelegationBlockedEvent }
  | { status: 'timeout' }

/**
 * 等待子会话进展：任一目标完成、出现阻塞、或超时。
 *
 * 阻塞必须提前返回：否则父会话等子会话完成、子会话等父会话回答，会互锁到超时。
 */
export async function waitForDelegationProgress(
  input: DelegationProgressWaitInput,
): Promise<DelegationProgressWaitResult> {
  const scope = new Set(input.delegationIds)
  const pickBlocked = (events: readonly DelegationBlockedEvent[]): DelegationBlockedEvent | undefined =>
    events.find((event) => !event.resolvedAt && scope.has(event.delegationId))

  const alreadyBlocked = pickBlocked(input.initialBlocked ?? input.registry.pendingFor(input.delegationIds))
  if (alreadyBlocked) return { status: 'blocked', event: alreadyBlocked }
  if (input.isCompleted?.()) return { status: 'completed' }

  let unsubscribe: () => void = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      input.completed.then((): DelegationProgressWaitResult => ({ status: 'completed' })),
      new Promise<DelegationProgressWaitResult>((resolve) => {
        unsubscribe = input.registry.onBlocked((event) => {
          if (event.resolvedAt || !scope.has(event.delegationId)) return
          // 完成目标已经达成时，阻塞留给下一轮处理，不打断已完成的结果回传。
          if (input.isCompleted?.()) return
          resolve({ status: 'blocked', event })
        })
      }),
      new Promise<DelegationProgressWaitResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), input.timeoutMs)
      }),
    ])
  } finally {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}

// ===== 唤醒决策 =====

export interface DelegationBlockedWakeContext {
  /** 父会话当前是否仍在运行；运行中不打断，等它自己从等待/轮询里看到阻塞。 */
  parentActive: boolean
  parentStoppedByUser?: boolean
  /** 没有渠道无法启动父会话，只能让用户直接回答。 */
  parentHasChannel: boolean
  /** 委派 ID → 子会话标题，用于提示词可读性。 */
  childTitles?: Readonly<Record<string, string>>
}

export type DelegationBlockedWakeSkipReason =
  | 'no_pending'
  | 'already_handled'
  | 'parent_active'
  | 'parent_stopped'
  | 'parent_channel_missing'

export type DelegationBlockedWakeDecision =
  | { action: 'wake'; eventIds: string[]; prompt: string }
  | { action: 'skip'; reason: DelegationBlockedWakeSkipReason }

/**
 * 决定是否唤醒父会话处理阻塞事件。
 *
 * 只有「未解决、未唤醒、未转交」的事件才触发唤醒，且一次唤醒覆盖当前全部待处理事件，
 * 避免多个子会话同时阻塞时把父会话拉起多次。
 */
export function decideDelegationBlockedWake(
  events: readonly DelegationBlockedEvent[],
  context: DelegationBlockedWakeContext,
): DelegationBlockedWakeDecision {
  const unresolved = events.filter((event) => !event.resolvedAt)
  if (unresolved.length === 0) return { action: 'skip', reason: 'no_pending' }

  const pending = unresolved.filter((event) => !event.wokenAt && !event.escalatedAt)
  if (pending.length === 0) return { action: 'skip', reason: 'already_handled' }
  if (context.parentActive) return { action: 'skip', reason: 'parent_active' }
  if (context.parentStoppedByUser) return { action: 'skip', reason: 'parent_stopped' }
  if (!context.parentHasChannel) return { action: 'skip', reason: 'parent_channel_missing' }

  return {
    action: 'wake',
    eventIds: pending.map((event) => event.id),
    prompt: buildDelegationBlockedPrompt(pending, { childTitles: context.childTitles }),
  }
}

// ===== 提示词 =====

export interface DelegationBlockedPromptOptions {
  childTitles?: Readonly<Record<string, string>>
}

/**
 * 父会话唤醒提示词。
 *
 * 决策规则必须写死在提示词里：代答是「替用户做决定」，猜错会污染子会话的产出，
 * 所以只允许从已表达的要求直接推出唯一答案时代答，其余一律留在用户界面。
 */
export function buildDelegationBlockedPrompt(
  events: readonly DelegationBlockedEvent[],
  options: DelegationBlockedPromptOptions = {},
): string {
  const sections = events.map((event) => formatBlockedEvent(event, options.childTitles?.[event.delegationId]))
  return [
    '协作子会话被阻塞，需要你决定是否代答。',
    '',
    ...sections,
    '',
    '决策规则：',
    '1. 只有能从用户本轮指令、任务说明或已核验上下文直接推出唯一答案时，才调用 answer_delegation_question 代答；代答内容必须与用户已表达的要求一致。',
    '2. 需要用户偏好、取舍、外部事实或高风险授权时，不要猜测也不要代答。问题已经在用户界面等待回答，直接说明「已转交用户」并结束本轮。',
    '3. 权限类阻塞默认归用户决定；只有用户本轮已明确授权该操作时，才可代答 allow。',
    '4. 同一阻塞事件只会唤醒你一次。不要重复调用 answer_delegation_question，也不要为了等待用户而空转。',
  ].join('\n')
}

function formatBlockedEvent(event: DelegationBlockedEvent, title?: string): string {
  const lines: string[] = [`### ${title?.trim() || event.delegationId}`]
  lines.push(`- 委派 ID：${event.delegationId}`)
  lines.push(`- 阻塞事件 ID：${event.id}`)
  lines.push(`- 类型：${event.kind === 'ask_user' ? '提问' : '权限审批'}`)
  if (event.kind === 'permission') {
    lines.push(`- 工具：${event.toolName ?? '未知'}`)
  }
  if (event.questions && event.questions.length > 0) {
    lines.push('- 问题：')
    event.questions.forEach((question, index) => {
      lines.push(`  ${index + 1}. ${question.question}`)
      if (question.options.length > 0) {
        const options = question.options
          .map((option) => option.description ? `${option.label}（${option.description}）` : option.label)
          .join('；')
        lines.push(`     选项：${options}`)
      }
    })
  }
  return lines.join('\n')
}
