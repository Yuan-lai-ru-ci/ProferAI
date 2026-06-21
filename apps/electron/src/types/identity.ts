/**
 * 身份与团队账户类型
 *
 * 设备身份、用户身份、团队服务器配置。
 */

/** 设备唯一标识 */
export interface DeviceIdentity {
  /** 设备唯一 ID（首次运行时生成） */
  deviceId: string
  /** 设备友好名称 */
  deviceName: string
  /** 首次注册时间 */
  registeredAt: number
}

/** 用户身份（增强版 UserProfile） */
export interface UserIdentity {
  /** 显示名称 */
  displayName: string
  /** 头像（emoji 或 data URL） */
  avatar: string
  /** 个人简介 */
  bio?: string

  // 团队账户绑定（可选，未登录时为空）
  /** 登录的团队账户 ID */
  teamAccountId?: string
  /** 加密存储的认证令牌 */
  encryptedAuthToken?: string
  /** 令牌过期时间戳 */
  tokenExpiresAt?: number
  /** 团队账户邮箱 */
  teamEmail?: string
  /** 账户创建时间 */
  createdAt?: number
}

/** 设备身份 IPC 通道 */
export const DEVICE_IDENTITY_IPC_CHANNELS = {
  GET: 'identity:get-device',
  GET_USER: 'identity:get-user',
  UPDATE_USER: 'identity:update-user',
} as const
