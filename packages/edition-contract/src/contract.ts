import type { Channel } from '@profer/shared'

/** 发行版标识：oss=开源版，commercial=商业版。 */
export type EditionId = 'oss' | 'commercial'

/**
 * 一次商业账号会话的只读快照。
 *
 * 刷新、持久化和 Team Server 细节都由 AccountProvider 的实现负责；
 * 执行链只消费快照，不感知具体服务端。
 */
export interface EditionAuthSession {
  baseUrl: string
  token: string
  proxyToken?: string
  membershipTier?: string
  teamEmail?: string
  teamAccountId?: string
}

/** 商业账号能力。OSS 实现整体返回空值。 */
export interface EditionAccountProvider {
  /** 当前有效登录态；实现负责在过期时刷新。未登录返回 null。 */
  getSession(): Promise<EditionAuthSession | null>
  /** 代管令牌失效后的恢复路径；不提供恢复能力的发行版返回 null。 */
  recoverSession(): Promise<EditionAuthSession | null>
  /**
   * 同步读取已缓存的登录态，不触发刷新。
   *
   * 用于写入前的一致性校验（例如服务端下发数据落地前确认账号没换），
   * 这种场景不适合再等一次网络刷新。
   */
  getSessionSnapshot(): EditionAuthSession | null
  /**
   * 会话代数：登录/登出/换号时递增，未登录为 null。
   *
   * 异步结果回来后比对这个值，丢掉“登出前发出、登出后才回来”的脏写。
   */
  getSessionGeneration(): number | null
  /** 主动刷新登录态，成功返回 true。 */
  refreshSession(): Promise<boolean>
  /**
   * 启动/系统唤醒时用持久化凭据恢复登录态；恢复成功返回 true。
   *
   * OSS 实现恒为 false —— 开源版没有账号体系，不需要恢复任何东西。
   */
  restoreSession(): Promise<boolean>
  /** 恢复成功后启动自动续期。OSS 实现为空操作。 */
  scheduleAutoRefresh(): void
  /** 会员与商业模式投影。OSS 实现恒为“非商业、可自配”。 */
  getMembership(): EditionMembership
}

/** 会员与商业模式投影：UI 只靠这三个字段决定展示什么。 */
export interface EditionMembership {
  /** 是否处于商业模式（渠道与模型由服务端统一管理）。 */
  commercialMode: boolean
  /** 会员等级标识；OSS 为空字符串。 */
  membershipTier: string
  /** 是否允许用户自配渠道。 */
  canSelfConfig: boolean
}

/** 远程控制中继票据。 */
export interface EditionRelayTicket {
  ticket: string
  expiresAt: number
}

/**
 * 远程控制能力。
 *
 * OSS 不提供远程中继，实现返回 null；调用方需自行给出“当前发行版未启用”的提示，
 * 不能把 null 当成网络错误。
 */
export interface EditionRemoteProvider {
  getRelayTicket(role?: 'desktop' | 'viewer', deviceSlotId?: string): Promise<EditionRelayTicket | null>
}

/**
 * 路由判定只需要渠道的最小投影。
 *
 * 不直接使用完整 Channel，避免契约层绑定渠道配置的其余字段。
 */
export type EditionChannelRef = Pick<Channel, 'id' | 'serverManaged' | 'directDataPlane'>

export interface ManagedRouteOptions {
  /** 为 true 时，directDataPlane 渠道不进入代管通道。 */
  respectDirectDataPlane?: boolean
}

/**
 * 代管通道的请求路径种类。
 *
 * 只表达「这是哪一类请求」，具体路径由发行版决定：开源版没有代管通道，
 * 也就不该在包里出现 `/v1/proxy/*` 这类商业端点。
 */
export type EditionManagedPathKind = 'messages' | 'chat' | 'images' | 'imageEdits' | 'root'

/** 凭据路由策略：只回答“走哪条路”，不解析账号、额度或供应商错误。 */
export interface EditionCredentialPolicy {
  /** 是否应把该渠道的请求路由到官方代管通道。 */
  shouldUseManagedRoute(channel: EditionChannelRef, options?: ManagedRouteOptions): boolean
  /** 是否应使用 Bearer 代管凭据（而非本地 API Key）。 */
  shouldUseBearerAuth(channel: EditionChannelRef): boolean
  /**
   * 代管通道的请求路径（含前导斜杠）。
   *
   * 只有商业模式会调用——`shouldUseManagedRoute` 在开源版恒为 false，
   * 所以 OSS 实现直接抛错，避免把商业端点写进开源包。
   */
  managedPath(kind: EditionManagedPathKind): string
  /**
   * 代管图片生成的「按幂等键查回结果」路径。
   *
   * 504 后不能重发同一个 POST（只会拿到缓存的结果），必须轮询同一 operation。
   * 这条服务端约定同样只属于商业模式。
   */
  managedImageOperationPath(operation: 'generation' | 'edit', idempotencyKey: string): string
}

/** 渠道来源策略：区分“用户自配”与“服务端下发/代管”。 */
export interface EditionChannelPolicy {
  /**
   * 该渠道是否由服务端下发并代管。
   *
   * 代管渠道用户不可改名/改密钥/删除，也不能用 OAuth 重新授权覆盖——
   * 这些约束只在有服务端下发的发行版里成立，所以做成发行版能力，而不是写死。
   * OSS 恒为 false：开源版没有任何服务端下发渠道。
   */
  isManagedChannel(channel: { id: string; serverManaged?: boolean }): boolean

  /**
   * 是否向 UI 展示该渠道。缺省视为展示。
   *
   * 用途是**发行版切换**：两个发行版共用同一份 `channels.json`，商业版写入的
   * 服务端下发渠道在开源版里无法使用（没有代管通道，baseUrl 为空）。
   * 开源版只隐藏、不删除——切回商业版时这些渠道原样恢复，不需要重新同步。
   */
  isChannelVisible?(channel: { id: string; serverManaged?: boolean }): boolean
}

/** 额度不足的结构化信息（余额、预估消耗、面向用户的提示）。 */
export interface EditionInsufficientCredits {
  balance?: number
  required?: number
  message: string
}

/**
 * 错误语义策略。
 *
 * 有些错误含义本身就是商业的：402「额度不足」只在代管计费模式下出现，
 * 对应的引导是「去充值」。开源版没有额度体系，识别它只会给用户看一段
 * 与当前版本无关的充值文案，所以做成发行版能力。
 */
export interface EditionErrorPolicy {
  /** 识别额度不足类错误；OSS 恒返回 null。 */
  detectInsufficientCredits(error: unknown, status?: number): EditionInsufficientCredits | null
}

/**
 * 一个发行版向执行链暴露的全部商业能力。
 *
 * 执行链只依赖本接口；具体实现由构建期别名选择（`@profer/edition-impl`）。
 * 开源包的模块图里不应出现商业实现文件。
 */
export interface EditionProviders {
  id: EditionId
  account: EditionAccountProvider
  credentials: EditionCredentialPolicy
  channels: EditionChannelPolicy
  errors: EditionErrorPolicy
  remote: EditionRemoteProvider
  /**
   * 注册本发行版专属的 IPC。
   *
   * OSS 也会注册同一批通道的空实现：preload 契约对渲染进程是固定的，
   * 让通道直接不存在只会把“没有这个功能”变成满屏的 promise 报错。
   */
  registerIpc(): void
}

/** 代管通道统一使用 proxyToken 优先、token 兜底的 Bearer 凭据。 */
export function resolveEditionBearerToken(session: EditionAuthSession): string {
  return session.proxyToken || session.token
}
