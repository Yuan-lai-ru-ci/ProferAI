/**
 * 凭证 preflight 失败的 TypedError 文案表（唯一来源）。
 *
 * 背景（`05-next-slice.md` C1/C2、projection lane 的 IR-2A）：
 * 旧路径 `agent-orchestrator.ts` 的 `sendMessage` 在凭证解析失败时把错误落成
 * TypedError 助手气泡 + `interruption_record`，文案表原先**内联在编排器里**。
 * 新 runtime 路径只给出 `Credential resolution failed: token_expired` 这样的机械文本，
 * 宿主入口必须把它翻译成同一份用户可见文案，否则「同一次失败」在两个入口下
 * 对用户显示不同内容（G3）。
 *
 * 因此这里把凭证类文案提取成宿主侧小模块：编排器与新 runtime 入口**共用同一份文案**，
 * 避免两处漂移。本模块不包含环境类 / 渠道类 preflight（那些仍只存在于旧编排器，
 * 属新路径未迁移的能力，见 `blockers.md`）。
 *
 * 只做文案映射，不做判定：调用方拿到 `code` 后自己决定要不要走 preflight 语义。
 */

import type { ErrorCode, TypedError } from '@profer/shared'

/** CredentialPort 可能返回的失败码 → 旧路径的用户可见文案。 */
const CREDENTIAL_PREFLIGHT_TYPED_ERRORS: Partial<Record<string, TypedError>> = {
  token_expired: {
    code: 'token_expired',
    title: '团队账号登录已过期',
    message: '请重新登录团队账号后再使用 Agent 商业渠道。',
    actions: [{ key: 's', label: '打开设置', action: 'settings' }],
    canRetry: false,
  },
  api_key_decrypt_failed: {
    code: 'api_key_decrypt_failed',
    title: 'API Key 解密失败',
    message: '无法解密此渠道的 API Key，可能是系统密钥环异常。请到设置中重新填写 API Key。',
    actions: [{ key: 's', label: '打开渠道设置', action: 'open_channel_settings' }],
    canRetry: false,
  },
  // 发行版切换后，另一发行版下发的渠道在当前版本里不可见（典型：商业版官方渠道在开源版里）。
  // 文案必须与 orchestrator 的渠道 preflight 保持一致，否则同一次失败在两个入口说法不同。
  channel_not_found: {
    code: 'channel_not_found',
    title: '渠道不存在',
    message: '当前会话引用的渠道已被删除或不可用，请在设置中重新选择。',
    actions: [{ key: 's', label: '打开渠道设置', action: 'open_channel_settings' }],
    canRetry: false,
  },
}

/** 凭证 preflight 语义覆盖的失败码（新入口据此把准备失败翻译成产品文案）。 */
export const CREDENTIAL_PREFLIGHT_CODES: readonly string[] = Object.keys(CREDENTIAL_PREFLIGHT_TYPED_ERRORS)

/**
 * 把 CredentialPort 的失败码翻译成旧路径的 TypedError。
 *
 * 返回 `undefined` 表示该码不属于凭证 preflight 语义（调用方应保持 runtime 的机械文案，
 * 不要凭空造一份新文案）。
 */
export function resolveCredentialPreflightTypedError(code: string | undefined): TypedError | undefined {
  if (!code) return undefined
  return CREDENTIAL_PREFLIGHT_TYPED_ERRORS[code]
}

/** 该失败码是否属于凭证 preflight 语义。 */
export function isCredentialPreflightCode(code: string | undefined): code is ErrorCode {
  return typeof code === 'string' && CREDENTIAL_PREFLIGHT_TYPED_ERRORS[code] !== undefined
}
