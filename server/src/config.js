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
  if (!secret || secret === 'proma-team-server-secret-change-in-production') {
    console.error('[Proma Team Server] 致命错误: JWT_SECRET 未设置或使用了默认不安全值')
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

// 新用户注册时赠送的默认额度
export const DEFAULT_CREDIT_GRANT = parseInt(process.env.DEFAULT_CREDIT_GRANT || '1000000', 10)

// New API 中继站地址（额度代理转发目标）
export const RELAY_BASE_URL = process.env.RELAY_BASE_URL || 'http://127.0.0.1:3080'
export const RELAY_API_KEY = process.env.RELAY_API_KEY || ''
