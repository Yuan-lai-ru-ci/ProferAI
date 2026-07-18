// ===== 服务端配置 =====

import { resolveAllowedOrigin } from './cors-config.js'

export const PORT = process.env.PORT || 3000
export const JWT_EXPIRES = '7d'
export const ACCESS_TOKEN_EXPIRES = '1h'

// 数据目录（Docker 下指向 volume 挂载点）
const DATA_DIR = process.env.DATA_DIR || '.'
export const DB_PATH = process.env.DB_PATH || `${DATA_DIR}/proma-team.db`
export const FILES_DIR = `${DATA_DIR}/files`

// 账户安全
export const MAX_LOGIN_ATTEMPTS = 5
export const ACCOUNT_LOCK_MINUTES = 15

// JWT_SECRET 必须由环境变量提供，拒绝默认值
export const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET
  const knownDefaults = [
    'proma-team-server-secret-change-in-production',
    'change-me-to-a-random-64-byte-hex',
  ]
  if (!secret || secret.length < 32 || knownDefaults.includes(secret)) {
    console.error('[Profer Team Server] 致命错误: JWT_SECRET 未设置、过短或使用了默认不安全值')
    console.error('  请通过环境变量设置: export JWT_SECRET="<随机生成的安全密钥>"')
    console.error('  生成建议: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"')
    process.exit(1)
  }
  return secret
})()

// Admin 账户配置
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@proma.local'
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD

// 文件上传上限 (默认 500MB)
export const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || '524288000', 10)

// JSON 请求体上限 (默认 1MB，防止大 body DoS；文件上传不受此限)
export const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || '1048576', 10)

// Paperpipe multipart 上传独立于普通 JSON 限制；仍由实际流读取累计约束。
export const PAPERPIPE_MAX_FILE_SIZE = parseInt(process.env.PAPERPIPE_MAX_FILE_SIZE || String(200 * 1024 * 1024), 10)
export const PAPERPIPE_MAX_BODY_SIZE = parseInt(
  process.env.PAPERPIPE_MAX_BODY_SIZE || String(PAPERPIPE_MAX_FILE_SIZE + 1024 * 1024),
  10,
)

// CORS 允许的 Origin；未配置时不授权浏览器跨域。
// 支持逗号分隔的多个域名；开发环境如需跨域必须显式设置为 *。
export const ALLOWED_ORIGIN = resolveAllowedOrigin(process.env.ALLOWED_ORIGIN)

// 在线状态阈值（2 分钟无心跳视为离线）
export const ONLINE_THRESHOLD = 120_000

// 邀请有效期（7 天）
export const INVITATION_TTL = 7 * 86400 * 1000

// 工作区冷静期（软删除后可恢复的时间窗口，默认 30 天）
export const WORKSPACE_GRACE_PERIOD_MS = parseInt(
  process.env.WORKSPACE_GRACE_PERIOD_MS || String(30 * 86400 * 1000), 10
)

// 已处理邀请保留期（accepted/declined/cancelled/expired 后默认保留 90 天再自动清理）
export const INVITATION_RETENTION_MS = parseInt(
  process.env.INVITATION_RETENTION_MS || String(90 * 86400 * 1000), 10
)

// 同步信封保留期（默认 30 天）。超期的 sync_envelopes 定期清理，避免无限增长。
// 注意：离线超过该时长的客户端再上线会漏掉窗口外的增量变更，需触发全量重同步。
export const SYNC_ENVELOPE_RETENTION_MS = parseInt(
  process.env.SYNC_ENVELOPE_RETENTION_MS || String(30 * 86400 * 1000), 10
)

// ===== 商业模式 =====
// COMMERCIAL_MODE=true 时启用额度扣除、渠道统配、管理后台
export const COMMERCIAL_MODE = process.env.COMMERCIAL_MODE === 'true'

// 渠道 API Key 加密密钥（AES-256-GCM，64 字符 hex）
export const CHANNEL_ENCRYPTION_KEY = (() => {
  const key = process.env.CHANNEL_ENCRYPTION_KEY
  if (COMMERCIAL_MODE && !key) {
    console.error('[Profer] 致命错误: COMMERCIAL_MODE=true 但 CHANNEL_ENCRYPTION_KEY 未设置')
    console.error('  请设置: export CHANNEL_ENCRYPTION_KEY="<64位随机hex>"')
    console.error('  生成: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
    process.exit(1)
  }
  return key || ''
})()

// 新用户注册时赠送的默认额度（单位：New API quota，500000 = $1）
// 默认 2,500,000 = 50 积分 = $5。可用 DEFAULT_CREDIT_GRANT 覆盖。
export const DEFAULT_CREDIT_GRANT = parseInt(process.env.DEFAULT_CREDIT_GRANT || '2500000', 10)

// 单次手动充值/发放上限（防呆）。单位 quota（500000=$1）。默认 5 亿 quota = $1000。
export const MAX_GRANT_AMOUNT = parseInt(process.env.MAX_GRANT_AMOUNT || '500000000', 10)

// New API 中继站地址（额度代理转发目标）
export const RELAY_BASE_URL = process.env.RELAY_BASE_URL || 'http://127.0.0.1:3080'
export const RELAY_API_KEY = (() => {
  const key = process.env.RELAY_API_KEY
  if (COMMERCIAL_MODE && !key) {
    console.warn('[Profer] 警告: COMMERCIAL_MODE=true 但 RELAY_API_KEY 未设置，代理请求可能被中继站拒绝')
  }
  return key || ''
})()

// New API 系统访问令牌（用于查询真实用量/对账）
// ⚠️ 必须是 New API 后台 root/超管账号 → 个人设置 → 生成的「系统访问令牌」，
// 不是 API 令牌（sk-...）。系统令牌才能调 /api/log/ /api/user/ 等管理接口；
// sk- 令牌只能调 /v1/dashboard/billing/usage。调管理接口还需 New-API-User 头 = 令牌所属用户 id。
export const NEWAPI_ADMIN_TOKEN = process.env.NEWAPI_ADMIN_TOKEN || ''

// 系统访问令牌所属的 New API 用户 id（root/超管），调管理接口时作 New-API-User 头。
export const NEWAPI_ADMIN_USER_ID = process.env.NEWAPI_ADMIN_USER_ID || '1'

// New API quota → 货币换算锚点（默认 500000 quota = 1 单位，与 New API QuotaPerUnit 一致）
export const NEWAPI_QUOTA_PER_UNIT = parseInt(process.env.NEWAPI_QUOTA_PER_UNIT || '500000', 10)

// 计费加价倍率：Profer 对用户扣费 = New API 真实成本 × 此倍率。
// 默认 1.0（成本价，不加价）。要赚差价设 >1（如 1.5 = 加价 50%）。
export const BILLING_MARKUP = parseFloat(process.env.BILLING_MARKUP || '1.0')

// ===== 每用户独立 New API Key =====
// 新用户注册时在 New API 创建的初始额度（quota 单位，500000 = $1）。
// 默认 5,000,000 = $10 等价额度，仅作兜底；Profer 侧实际扣费以本地账本为准。
export const NEWAPI_USER_INITIAL_QUOTA = parseInt(process.env.NEWAPI_USER_INITIAL_QUOTA || '5000000', 10)
// 是否启用每用户独立 New API Key（灰度开关，默认关闭）。
// 开启后注册/登录会同步创建 New API 账号 + 独立 Key；proxy 转发用用户自己的 Key。
export const PER_USER_NEWAPI_KEY = process.env.PER_USER_NEWAPI_KEY === 'true'

// ===== 订阅制账号体系 =====
// membership_tier 决定工作区配额 + 模型门控 + 自配 API 权限。
// 要加新等级：在此对象加一行即可。
// 设备数统一 4 台，不再按等级区分。
// 初始赠送额度：50 积分（2,500,000 quota），统一给所有新注册用户。
export const SUBSCRIPTION_CAPS = {
  free: {
    label: '免费用户',
    maxWorkspaces: 1,
    maxDevices: 4,
    defaultCreditGrant: parseInt(process.env.DEFAULT_CREDIT_GRANT || '2500000', 10),
    canSelfConfig: false,
  },
  standard: {
    label: '标准用户',
    maxWorkspaces: Infinity,
    maxDevices: 4,
    canSelfConfig: false,
  },
  plus: {
    label: 'Plus 用户',
    maxWorkspaces: Infinity,
    maxDevices: 4,
    canSelfConfig: true,
  },
  pro: {
    label: 'Pro 用户',
    maxWorkspaces: Infinity,
    maxDevices: 4,
    canSelfConfig: true,
  },
}

/** 获取订阅等级的能力配置（不存在则降级为 free）。VIP 同 pro。 */
export function getSubscriptionCap(tier) {
  if (tier === 'vip') return SUBSCRIPTION_CAPS.pro
  return SUBSCRIPTION_CAPS[tier] || SUBSCRIPTION_CAPS.free
}

// ===== MinerU 论文解析 API =====
// MinerU (mineru.net) 将 PDF 转为结构化 Markdown（含 LaTeX 公式、HTML 表格）。
// 使用 v4 精准解析 API（批量上传模式），API key 服务端代管，绝不暴露给客户端。
// 获取 API key: https://mineru.net → API 管理页面
export const MINERU_API_KEY = process.env.MINERU_API_KEY || ''
// 论文精读定价：每 10 页 2 积分，最少 1 积分
export const MINERU_CREDITS_PER_10_PAGES = 2

// ===== Admin 安全限制 =====
// 批量重置：单次最多重置用户数
export const MAX_BATCH_RESET_SIZE = parseInt(process.env.MAX_BATCH_RESET_SIZE || '50', 10)
// 批量重置：每管理员每天最多执行次数
export const MAX_BATCH_RESET_PER_DAY = parseInt(process.env.MAX_BATCH_RESET_PER_DAY || '3', 10)
// 单笔订单金额上限（人民币分，默认 ¥1000）
export const MAX_ORDER_AMOUNT_RMB = parseInt(process.env.MAX_ORDER_AMOUNT_RMB || '100000', 10)
// 订单双人确认阈值（人民币分，默认 ¥500。超过此金额需另一管理员确认）
export const ORDER_DUAL_CONFIRM_THRESHOLD = parseInt(process.env.ORDER_DUAL_CONFIRM_THRESHOLD || '50000', 10)
// 同一管理员每日确认订单总额上限（人民币分，默认 ¥1000）
export const ORDER_DAILY_CONFIRM_CAP = parseInt(process.env.ORDER_DAILY_CONFIRM_CAP || '100000', 10)
// 同一管理员每日充值发放总额上限（quota 单位，默认 5000 万 = 100 积分）
export const DAILY_GRANT_CAP = parseInt(process.env.DAILY_GRANT_CAP || '50000000', 10)
// 渠道激活确认（test → global 是高风险操作）
export const CHANNEL_ACTIVATE_CONFIRM_REQUIRED = true
