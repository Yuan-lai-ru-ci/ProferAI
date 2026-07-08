// ===== 服务端配置 =====

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
    console.error('[Proma Team Server] 致命错误: JWT_SECRET 未设置、过短或使用了默认不安全值')
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
// 默认 500000 = $1 起步。可用 DEFAULT_CREDIT_GRANT 覆盖（直接给 quota 数）。
export const DEFAULT_CREDIT_GRANT = parseInt(process.env.DEFAULT_CREDIT_GRANT || '500000', 10)

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

// 按分组的代理 Key：模型属于非 default 组时，用对应组的 token 转发，
// 让 New API 走该分组的倍率。格式：group1:key1,group2:key2
// default 组不需要配，自动用 RELAY_API_KEY
export const GROUP_PROXY_KEYS = (() => {
  const raw = process.env.GROUP_PROXY_KEYS || ''
  const map = {}
  if (raw) {
    for (const pair of raw.split(',')) {
      const colon = pair.indexOf(':')
      if (colon > 0) map[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim()
    }
  }
  return map
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

// ===== 多类账号体系 =====
// 账号类型决定工作区配额 + 初始额度。自配 API 为独立开关（users.can_self_config_api）。
// 要加新类型：在此对象加一行即可。
// 账号类型赠送额单位：New API quota（500000 = $1）。restricted $0.5 / standard $1 / advanced $5。
export const ACCOUNT_TYPES = {
  restricted: {
    label: '受限用户',
    maxWorkspaces: 0,
    defaultCreditGrant: parseInt(process.env.CREDIT_RESTRICTED || '250000', 10),
  },
  standard: {
    label: '标准用户',
    maxWorkspaces: 3,
    defaultCreditGrant: parseInt(process.env.CREDIT_STANDARD || '500000', 10),
  },
  advanced: {
    label: '高级用户',
    maxWorkspaces: 10,
    defaultCreditGrant: parseInt(process.env.CREDIT_ADVANCED || '2500000', 10),
  },
}

/** 获取账号类型的能力配置（不存在或旧版本 'team' 均降级为 standard） */
export function getAccountCapability(type) {
  // 旧版本遗留的 'team' 类型映射为 standard
  const normalized = type === 'team' ? 'standard' : type
  return ACCOUNT_TYPES[normalized] || ACCOUNT_TYPES.standard
}
