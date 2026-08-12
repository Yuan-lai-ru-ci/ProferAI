/**
 * 系统配置服务 — DB override + 已校验环境默认 + 内存缓存。
 *
 * 优先级：DB override > 合法环境变量默认值 > 代码安全默认值。
 * 所有可动态调整的计费参数必须经本模块读取，避免配置面板与真实计费脱节。
 */
import { db } from './schema.js'

function envDefault(envKey, fallback, { type, min = -Infinity, max = Infinity, allowZero = true } = {}) {
  if (!envKey || process.env[envKey] === undefined) return String(fallback)
  try {
    return formatAndValidate(process.env[envKey], { type, min, max, allowZero }, envKey)
  } catch {
    console.warn(`[config] 环境变量 ${envKey} 无效，使用安全默认值 ${fallback}`)
    return String(fallback)
  }
}

/** @type {Record<string, {defaultValue: string, type: 'int'|'float'|'string', label: string, group: string, envKey?: string, min?: number, max?: number, allowZero?: boolean}>} */
const CONFIG_SCHEMA = {
  'plan.standard.monthlyRmb': { defaultValue: '2900', type: 'int', label: 'Standard 月价', group: '套餐定价', min: 0 },
  'plan.standard.yearlyRmb': { defaultValue: '29600', type: 'int', label: 'Standard 年价', group: '套餐定价', min: 0 },
  'plan.standard.welcomeBonus': { defaultValue: '60', type: 'int', label: 'Standard 首购红包', group: '套餐定价', min: 0 },
  'plan.standard.dailyDrip': { defaultValue: '8', type: 'int', label: 'Standard 每日 drip', group: '套餐定价', min: 0 },
  'plan.plus.monthlyRmb': { defaultValue: '4900', type: 'int', label: 'Plus 月价', group: '套餐定价', min: 0 },
  'plan.plus.yearlyRmb': { defaultValue: '50000', type: 'int', label: 'Plus 年价', group: '套餐定价', min: 0 },
  'plan.plus.welcomeBonus': { defaultValue: '200', type: 'int', label: 'Plus 首购红包', group: '套餐定价', min: 0 },
  'plan.plus.dailyDrip': { defaultValue: '20', type: 'int', label: 'Plus 每日 drip', group: '套餐定价', min: 0 },
  'plan.pro.monthlyRmb': { defaultValue: '9900', type: 'int', label: 'Pro 月价', group: '套餐定价', min: 0 },
  'plan.pro.yearlyRmb': { defaultValue: '101000', type: 'int', label: 'Pro 年价', group: '套餐定价', min: 0 },
  'plan.pro.welcomeBonus': { defaultValue: '450', type: 'int', label: 'Pro 首购红包', group: '套餐定价', min: 0 },
  'plan.pro.dailyDrip': { defaultValue: '40', type: 'int', label: 'Pro 每日 drip', group: '套餐定价', min: 0 },
  'vip.price': { defaultValue: '69800', type: 'int', label: 'VIP 终身价格', group: 'VIP', min: 0 },
  'vip.discount': { defaultValue: '0.9', type: 'float', label: 'VIP 套餐折扣', group: 'VIP', min: 0, max: 1, allowZero: false },
  'vip.extraDrip': { defaultValue: '20', type: 'int', label: 'VIP 额外 drip', group: 'VIP', min: 0 },
  'vip.modelDiscount': { defaultValue: '0.8', type: 'float', label: 'VIP 模型折扣倍率', group: 'VIP', min: 0.01, max: 1, allowZero: false },
  'vip.newApiGroup': { defaultValue: 'vip', type: 'string', label: 'VIP New API 分组', group: 'VIP' },
  'pricing.modelMultipliers': { defaultValue: '{}', type: 'string', label: '模型倍率目录(JSON)', group: '计费' },

  'billing.markup': { defaultValue: '', type: 'float', label: '计费加价倍率', group: '计费', envKey: 'BILLING_MARKUP', min: 0.01, max: 100, allowZero: false },
  'billing.defaultCreditGrant': { defaultValue: '', type: 'int', label: '新用户默认额度(quota)', group: '计费', envKey: 'DEFAULT_CREDIT_GRANT', min: 0, max: Number.MAX_SAFE_INTEGER },
  'billing.overdraftLimit': { defaultValue: '', type: 'int', label: '透支上限(quota)', group: '计费', envKey: 'BILLING_OVERDRAFT_LIMIT', min: 0, max: Number.MAX_SAFE_INTEGER },
  'misc.adminWechat': { defaultValue: 'CYBER_YLRC', type: 'string', label: '管理员微信号', group: '杂项' },

  // ===== 在线充值（易支付） =====
  // 用户自助充值积分。1 元 = 10 积分。启用在线支付需同时配置 epayApi/epayPid/epayKey/notifyBase。
  'pay.onRecharge': { defaultValue: '0', type: 'int', label: '启用在线充值', group: '在线充值', min: 0, max: 1 },
  'pay.currency': { defaultValue: 'rmb', type: 'string', label: '计价货币(rmb)', group: '在线充值' },
  'pay.rate': { defaultValue: '10', type: 'int', label: '积分/元换算(1元=所得积分)', group: '在线充值', min: 1, max: 100000 },
  'pay.presetsRmb': { defaultValue: '[10,30,50,100,300]', type: 'string', label: '充值档位(元,JSON数组)', group: '在线充值' },
  'pay.customMinRmb': { defaultValue: '1', type: 'int', label: '自定义充值下限(元)', group: '在线充值', min: 0 },
  'pay.customMaxRmb': { defaultValue: '1000', type: 'int', label: '自定义充值上限(元)', group: '在线充值', min: 1 },
  'pay.epayApi': { defaultValue: '', type: 'string', label: '易支付网关地址', group: '在线充值', envKey: 'EPAY_API' },
  'pay.epayPid': { defaultValue: '', type: 'string', label: '易支付商户ID(PID)', group: '在线充值', envKey: 'EPAY_PID' },
  'pay.epayKey': { defaultValue: '', type: 'string', label: '易支付商户密钥(KEY)', group: '在线充值', envKey: 'EPAY_KEY', secret: true },
  'pay.notifyBase': { defaultValue: '', type: 'string', label: '回调公网域名(如 https://x.com)', group: '在线充值', envKey: 'PAY_NOTIFY_BASE' },

  'admin.maxOrderAmount': { defaultValue: '', type: 'int', label: '单笔订单上限(分)', group: '安全限额', envKey: 'MAX_ORDER_AMOUNT_RMB', min: 1, max: Number.MAX_SAFE_INTEGER, allowZero: false },
  'admin.orderDualConfirmThreshold': { defaultValue: '', type: 'int', label: '双人确认阈值(分)', group: '安全限额', envKey: 'ORDER_DUAL_CONFIRM_THRESHOLD', min: 1, max: Number.MAX_SAFE_INTEGER, allowZero: false },
  'admin.orderDailyConfirmCap': { defaultValue: '', type: 'int', label: '每日确认总额上限(分)', group: '安全限额', envKey: 'ORDER_DAILY_CONFIRM_CAP', min: 1, max: Number.MAX_SAFE_INTEGER, allowZero: false },
  'admin.dailyGrantCap': { defaultValue: '', type: 'int', label: '每日充值上限(quota)', group: '安全限额', envKey: 'DAILY_GRANT_CAP', min: 1, max: Number.MAX_SAFE_INTEGER, allowZero: false },
  'admin.maxGrantAmount': { defaultValue: '', type: 'int', label: '单次充值上限(quota)', group: '安全限额', envKey: 'MAX_GRANT_AMOUNT', min: 1, max: Number.MAX_SAFE_INTEGER, allowZero: false },
}

const ENV_FALLBACKS = {
  'billing.markup': '1.0', 'billing.defaultCreditGrant': '500000', 'billing.overdraftLimit': '2500000',
  'admin.maxOrderAmount': '100000', 'admin.orderDualConfirmThreshold': '50000', 'admin.orderDailyConfirmCap': '100000',
  'admin.dailyGrantCap': '50000000', 'admin.maxGrantAmount': '500000000',
  // 在线支付：环境变量未设置时应回退为空串而非字符串 "undefined"
  'pay.epayApi': '', 'pay.epayPid': '', 'pay.epayKey': '', 'pay.notifyBase': '',
}
for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
  if (schema.envKey) schema.defaultValue = envDefault(schema.envKey, ENV_FALLBACKS[key], schema)
}

let cache = new Map()
let cacheLoaded = false

function loadCache() {
  try {
    const next = new Map()
    for (const row of db.prepare('SELECT key, value FROM system_config').all()) next.set(row.key, row.value)
    cache = next
    cacheLoaded = true
  } catch {
    // schema 初始化前允许回退，但不能把失败永久标成已加载。
    cacheLoaded = false
  }
}
function ensureCache() { if (!cacheLoaded) loadCache() }

function formatAndValidate(value, schema, key = '配置') {
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`配置值无效: ${key} 必须为字符串`)
    return value
  }
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`配置值无效: ${key} 必须为有限数字`)
  const text = typeof value === 'string' ? value.trim() : String(value)
  if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new Error(`配置值无效: ${key} 必须为有限数字`)
  const number = Number(text)
  if (!Number.isFinite(number) || !Number.isSafeInteger(schema.type === 'int' ? number : Math.trunc(number))) throw new Error(`配置值无效: ${key} 必须为有限安全数字`)
  if (schema.type === 'int' && !Number.isInteger(number)) throw new Error(`配置值无效: ${key} 必须为整数`)
  const min = schema.min ?? -Infinity
  const max = schema.max ?? Infinity
  if (number < min || number > max || (schema.allowZero === false && number === 0)) throw new Error(`配置值无效: ${key} 超出允许范围`)
  return String(number)
}
function parseValue(raw, schema, key) {
  try { return schema.type === 'string' ? String(raw) : Number(formatAndValidate(raw, schema, key)) } catch { return undefined }
}
function effectiveValue(key, schema) {
  ensureCache()
  if (cache.has(key)) {
    const parsed = parseValue(cache.get(key), schema, key)
    if (parsed !== undefined) return { value: parsed, source: 'db' }
    console.warn(`[config] 忽略非法 DB 配置 ${key}，回退默认值`)
  }
  return { value: parseValue(schema.defaultValue, schema, key), source: schema.envKey && process.env[schema.envKey] !== undefined ? 'env' : 'code' }
}

export function getConfig(key) { const schema = CONFIG_SCHEMA[key]; return schema ? effectiveValue(key, schema).value : undefined }
export function getConfigRaw(key) { const schema = CONFIG_SCHEMA[key]; return schema ? String(getConfig(key)) : undefined }
export function getConfigSource(key) { const schema = CONFIG_SCHEMA[key]; return schema ? effectiveValue(key, schema).source : undefined }
export function getConfigs(prefix = '') {
  return Object.entries(CONFIG_SCHEMA).filter(([key]) => !prefix || key.startsWith(prefix)).map(([key, schema]) => {
    const effective = effectiveValue(key, schema)
    return { key, value: effective.value, rawValue: String(effective.value), type: schema.type, label: schema.label, group: schema.group, defaultValue: parseValue(schema.defaultValue, schema, key), isCustomized: effective.source === 'db', defaultSource: effective.source, min: schema.min, max: schema.max, secret: !!schema.secret }
  })
}
export function getConfigsGrouped() { return getConfigs().reduce((groups, item) => { (groups[item.group || '其他'] ||= []).push(item); return groups }, {}) }

function validateUpdate(key, value) {
  const schema = CONFIG_SCHEMA[key]
  if (!schema) throw new Error(`未知配置项: ${key}`)
  return { key, schema, raw: formatAndValidate(value, schema, key) }
}
function writeUpdates(entries, userId) {
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const { key, schema, raw } of entries) db.prepare(`INSERT INTO system_config (key, value, label, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, label=excluded.label, updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(key, raw, schema.label, now, userId || '')
  })
  tx()
  ensureCache()
  const next = new Map(cache)
  for (const entry of entries) next.set(entry.key, entry.raw)
  cache = next
}
export function setConfig(key, value, userId = '') { const entry = validateUpdate(key, value); writeUpdates([entry], userId); return { key, value: getConfig(key) } }
export function setConfigs(updates, userId = '') {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('配置值无效: updates 必须为对象')
  const entries = Object.entries(updates).map(([key, value]) => validateUpdate(key, value))
  if (!entries.length) throw new Error('配置值无效: updates 不能为空')
  writeUpdates(entries, userId)
  return Object.fromEntries(entries.map(({ key }) => [key, { key, value: getConfig(key) }]))
}
export function resetConfig(key) {
  if (key && !CONFIG_SCHEMA[key]) throw new Error(`未知配置项: ${key}`)
  if (key) {
    db.prepare('DELETE FROM system_config WHERE key = ?').run(key)
    ensureCache(); const next = new Map(cache); next.delete(key); cache = next
    return { key, value: getConfig(key), source: getConfigSource(key) }
  }
  db.prepare('DELETE FROM system_config').run(); cache = new Map(); cacheLoaded = true
  return { reset: 'all' }
}

/** 每次读取返回不可变快照，保证单次业务调用链使用同一套动态计费参数。 */
export function getBillingConfig() { return Object.freeze({ markup: getConfig('billing.markup'), defaultCreditGrant: getConfig('billing.defaultCreditGrant'), overdraftLimit: getConfig('billing.overdraftLimit') }) }
export function getPlanDefs() { return { standard: { monthlyRmb: getConfig('plan.standard.monthlyRmb'), yearlyRmb: getConfig('plan.standard.yearlyRmb'), welcomeBonus: getConfig('plan.standard.welcomeBonus'), dailyDrip: getConfig('plan.standard.dailyDrip') }, plus: { monthlyRmb: getConfig('plan.plus.monthlyRmb'), yearlyRmb: getConfig('plan.plus.yearlyRmb'), welcomeBonus: getConfig('plan.plus.welcomeBonus'), dailyDrip: getConfig('plan.plus.dailyDrip') }, pro: { monthlyRmb: getConfig('plan.pro.monthlyRmb'), yearlyRmb: getConfig('plan.pro.yearlyRmb'), welcomeBonus: getConfig('plan.pro.welcomeBonus'), dailyDrip: getConfig('plan.pro.dailyDrip') } } }
export function getPlanDefsRedeem() { return getPlanDefs() }
export function getVipConfig() { return { price: getConfig('vip.price'), discount: getConfig('vip.discount'), extraDrip: getConfig('vip.extraDrip'), modelDiscount: getConfig('vip.modelDiscount'), newApiGroup: getConfig('vip.newApiGroup') } }

/** 在线充值配置快照（不可变）。 */
export function getPayConfig() {
  return Object.freeze({
    onRecharge: !!getConfig('pay.onRecharge'),
    currency: getConfig('pay.currency'),
    rate: getConfig('pay.rate'),
    // 解析充值档位 JSON，非法时回退安全默认 [10,30,50,100,300]
    presetsRmb: (() => { try { const a = JSON.parse(getConfig('pay.presetsRmb')); return Array.isArray(a) ? a.map(Number).filter(n => Number.isFinite(n) && n > 0) : [10, 30, 50, 100, 300] } catch { return [10, 30, 50, 100, 300] } })(),
    customMinRmb: getConfig('pay.customMinRmb'),
    customMaxRmb: getConfig('pay.customMaxRmb'),
    epayApi: getConfig('pay.epayApi'),
    epayPid: getConfig('pay.epayPid'),
    epayKey: getConfig('pay.epayKey'),
    notifyBase: getConfig('pay.notifyBase'),
  })
}

/** 在线支付是否可用：需同时启用在线充值且已配置网关/商户/密钥/回调域名。 */
export function isOnlinePayReady() {
  const pay = getPayConfig()
  return pay.onRecharge && !!pay.epayApi && !!pay.epayPid && !!pay.epayKey && !!pay.notifyBase
}

/** 模型倍率目录由管理员维护，格式：{"claude-sonnet":0.6,"gpt-5":0.5}。 */
export function getModelMultipliers() {
  try {
    const parsed = JSON.parse(getConfig('pricing.modelMultipliers') || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([model, multiplier]) =>
      typeof model === 'string' && model.trim() && Number.isFinite(Number(multiplier)) && Number(multiplier) > 0
    ).map(([model, multiplier]) => [model, Number(multiplier)]))
  } catch {
    return {}
  }
}
export { CONFIG_SCHEMA }
