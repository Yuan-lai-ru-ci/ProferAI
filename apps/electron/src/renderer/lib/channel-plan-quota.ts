import { type Channel, type ChannelPlanQuotaResult, type ProviderType } from '@profer/shared'

const PLAN_QUOTA_PROVIDERS = new Set<ProviderType>([
  'deepseek', 'kimi-coding', 'minimax', 'zhipu-coding', 'openai-codex',
])

export function supportsChannelPlanQuota(channel: Pick<Channel, 'provider' | 'baseUrl' | 'serverManaged'> | null | undefined): boolean {
  // Profer 代管渠道的额度由 Profer 账户计费，不应使用其服务端凭据查询第三方账户数据。
  if (!channel || channel.serverManaged) return false
  return PLAN_QUOTA_PROVIDERS.has(channel.provider) || channel.baseUrl.includes('api.kimi.com/coding')
}

// PR2：引入每渠道定时后台刷新后，被动缓存可放长——成功 5 分钟、失败 60 秒（保留「失败可尽快重试」的意图）。
const PLAN_QUOTA_CACHE_MS = 5 * 60 * 1000
const PLAN_QUOTA_ERROR_CACHE_MS = 60 * 1000

interface CachedPlanQuota {
  result: ChannelPlanQuotaResult
  channelUpdatedAt?: number
}

const quotaCache = new Map<string, CachedPlanQuota>()
const inflightRequests = new Map<string, Promise<ChannelPlanQuotaResult>>()

function getCacheTtl(result: ChannelPlanQuotaResult): number {
  return result.supported ? PLAN_QUOTA_CACHE_MS : PLAN_QUOTA_ERROR_CACHE_MS
}

export function getCachedPlanQuota(channelId: string, channelUpdatedAt?: number): ChannelPlanQuotaResult | null {
  const cached = quotaCache.get(channelId)
  // result 必须有效：历史缺陷曾把 undefined 写入缓存（IPC 实现缺失/平板 stub 兜底），
  // 二次查询读 cached.result.updatedAt 会抛 TypeError。
  if (!cached || !cached.result) return null
  // 仅在调用方显式传入渠道版本时才做严格一致性校验；否则信任结果内部自带的 channelUpdatedAt，
  // 避免「主进程回传版本后，未传参的二次查询因 undefined !== 实际版本而误判缓存失效」。
  if (channelUpdatedAt != null && cached.channelUpdatedAt !== channelUpdatedAt) return null
  if (Date.now() - cached.result.updatedAt >= getCacheTtl(cached.result)) return null
  return cached.result
}

/** 实际执行一次 IPC 额度查询：拉取结果、写缓存（含 IPC 异常兜底）。 */
function performPlanQuotaRequest(
  channelId: string,
  channelUpdatedAt?: number,
): Promise<ChannelPlanQuotaResult> {
  return window.electronAPI.getChannelPlanQuota(channelId)
    .then((result) => {
      // 兜底：IPC 实现异常或平板 stub 返回 undefined 时，写入明确的“不支持”结果，
      // 避免缓存中出现 result: undefined（二次查询会读 result.updatedAt 崩溃）。
      if (!result || typeof result !== 'object') {
        result = {
          supported: false,
          provider: 'custom',
          windows: [],
          updatedAt: Date.now(),
          message: '订阅额度查询失败',
        }
      }
      // 回写时带上主进程回传的渠道版本，下次调用即使没显式传 channelUpdatedAt 也能命中缓存。
      quotaCache.set(channelId, { result, channelUpdatedAt: result.channelUpdatedAt ?? channelUpdatedAt })
      return result
    })
    .catch((error: unknown) => {
      const result: ChannelPlanQuotaResult = {
        supported: false,
        provider: 'custom',
        windows: [],
        updatedAt: Date.now(),
        message: error instanceof Error ? error.message : '订阅额度查询失败',
      }
      quotaCache.set(channelId, { result, channelUpdatedAt })
      return result
    })
}

export async function fetchChannelPlanQuota(
  channelId: string,
  channelUpdatedAt?: number,
): Promise<ChannelPlanQuotaResult> {
  const cached = getCachedPlanQuota(channelId, channelUpdatedAt)
  if (cached) return cached

  // 以渠道 ID 作为统一 in-flight 键：被动查询与手动刷新共享同一锁，
  // 同一渠道并发触发时复用同一 Promise，杜绝重复请求。
  const inflight = inflightRequests.get(channelId)
  if (inflight) return inflight

  const request = performPlanQuotaRequest(channelId, channelUpdatedAt)
    .finally(() => {
      inflightRequests.delete(channelId)
    })

  inflightRequests.set(channelId, request)
  return request
}

/**
 * 手动/定时刷新入口：跳过缓存，强制拉取一次最新额度。
 *
 * 与 `fetchChannelPlanQuota` 共享统一 in-flight 锁（key = channelId）：
 * 刷新进行中重复调用（含被动查询并发）返回同一 Promise，物理上杜绝多次触发。
 */
export async function requestPlanQuotaRefresh(channelId: string): Promise<ChannelPlanQuotaResult> {
  const inflight = inflightRequests.get(channelId)
  if (inflight) return inflight

  const request = performPlanQuotaRequest(channelId)
    .finally(() => {
      inflightRequests.delete(channelId)
    })

  inflightRequests.set(channelId, request)
  return request
}

/** 定期后台刷新间隔：每渠道每 5 分钟静默拉取一次最新额度。 */
const PLAN_QUOTA_REFRESH_INTERVAL_MS = 5 * 60 * 1000

/** 渠道定时刷新事件：start 表示请求开始（UI 刷新图标转圈），done 携带最新结果并复位。 */
export type PlanQuotaRefreshEvent =
  | { type: 'start' }
  | { type: 'done'; result: ChannelPlanQuotaResult }

type RefreshListener = (event: PlanQuotaRefreshEvent) => void

/** 每渠道的刷新事件订阅者集合。 */
const refreshListeners = new Map<string, Set<RefreshListener>>()

function notifyRefreshListeners(channelId: string, event: PlanQuotaRefreshEvent): void {
  refreshListeners.get(channelId)?.forEach((listener) => {
    try {
      listener(event)
    } catch {
      // 单个监听器异常不影响其他监听器
    }
  })
}

/** 订阅某渠道的定时刷新事件，返回退订函数。 */
export function subscribeChannelQuotaRefresh(channelId: string, listener: RefreshListener): () => void {
  let listeners = refreshListeners.get(channelId)
  if (!listeners) {
    listeners = new Set()
    refreshListeners.set(channelId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 每渠道后台刷新定时器。 */
const periodicTimers = new Map<string, ReturnType<typeof setInterval>>()
/** 每渠道活跃订阅者计数，归零时回收定时器（无入口可见则停止后台刷新，避免空转）。 */
const periodicSubscriberCount = new Map<string, number>()

/** 定时刷新回调：通知 start（UI 转圈）→ 强制拉取（共享 in-flight 锁）→ 通知 done（旧值更新并复位）。 */
async function runPeriodicRefresh(channelId: string): Promise<void> {
  notifyRefreshListeners(channelId, { type: 'start' })
  const result = await requestPlanQuotaRefresh(channelId)
  notifyRefreshListeners(channelId, { type: 'done', result })
}

/** 登记一个活跃入口（引用计数 +1）；首次登记时启动该渠道的后台刷新定时器。 */
export function ensurePeriodicRefresh(channelId: string): void {
  const count = (periodicSubscriberCount.get(channelId) ?? 0) + 1
  periodicSubscriberCount.set(channelId, count)
  if (!periodicTimers.has(channelId)) {
    periodicTimers.set(channelId, setInterval(() => {
      void runPeriodicRefresh(channelId)
    }, PLAN_QUOTA_REFRESH_INTERVAL_MS))
  }
}

/** 注销一个活跃入口（引用计数 -1）；归零时清除该渠道的定时器，避免泄漏。 */
export function releasePeriodicRefresh(channelId: string): void {
  const count = (periodicSubscriberCount.get(channelId) ?? 1) - 1
  if (count <= 0) {
    periodicSubscriberCount.delete(channelId)
    const timer = periodicTimers.get(channelId)
    if (timer) {
      clearInterval(timer)
      periodicTimers.delete(channelId)
    }
  } else {
    periodicSubscriberCount.set(channelId, count)
  }
}
