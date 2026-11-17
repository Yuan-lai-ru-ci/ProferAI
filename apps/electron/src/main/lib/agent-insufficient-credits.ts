/**
 * 新 runtime 链的「额度不足」结构化补齐。
 *
 * 背景：旧链 `agent-orchestrator.ts` 对 assistant 错误消息做完整的
 * `mapSDKErrorToTypedError` 映射，并写入 `_errorCode` / `_errorTitle` /
 * `_errorActions` 供渲染层展示结构化错误卡片；新 runtime 链（`agent-runtime-entry.ts`）
 * 目前只迁移了凭证 preflight 一种（见 `agent-preflight-typed-errors.ts` 的边界说明），
 * provider 流错误原样透传，商业版代管 402 在默认内核（Pi）下会显示成普通错误，
 * 用户看不到「额度不足 / 查看额度」引导。
 *
 * 这里只补「额度不足」这一类，理由：
 * - 它由发行版注入判定（`editionProviders.errors.detectInsufficientCredits`），
 *   开源版恒返回 null，因此对开源版行为零影响；
 * - 其余错误类型的映射涉及整条链迁移，不能顺手在本模块扩散。
 *
 * 只写缺失字段：已被旧链或其它投影写入 `_errorCode` 的消息不再覆盖。
 */

import type { SDKMessage } from '@profer/shared'

/** 与 `EditionProviders.errors.detectInsufficientCredits` 同形，便于测试注入。 */
export type InsufficientCreditsDetector = (
  error: unknown,
  status?: number,
) => { message?: string } | null

type ErrorCarryingMessage = SDKMessage & {
  error?: unknown
  _errorCode?: string
  _errorTitle?: string
  _errorActions?: unknown
}

/**
 * 命中额度不足时补齐渲染层需要的结构化字段。
 *
 * @returns 是否写入了字段（供测试与调用方判断，不参与业务分支）
 */
export function markInsufficientCreditsMessage(
  message: SDKMessage,
  detect: InsufficientCreditsDetector | undefined,
): boolean {
  if (!detect) return false
  const record = message as ErrorCarryingMessage
  if (!record.error) return false
  // 已有结构化错误码（旧链映射 / preflight 投影）时保持原判，不覆盖。
  if (typeof record._errorCode === 'string' && record._errorCode) return false

  const info = detect(record.error)
  if (!info) return false

  record._errorCode = 'insufficient_credits'
  record._errorTitle = '额度不足'
  record._errorActions = [
    { key: 'c', label: '查看额度', action: 'open_credits' },
    { key: 'r', label: '重试', action: 'retry' },
  ]
  return true
}
