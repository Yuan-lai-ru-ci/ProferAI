import type { BrowserOperationStatus } from '@profer/shared'
import { createBrowserPageSnapshot, type BrowserPageSnapshot } from './browser-page-snapshot'

export type BrowserActionVerificationKind = 'click' | 'fill' | 'press' | 'dom' | 'script'
export type BrowserActionEffect = 'none' | 'dom-confirmed' | 'document-changed' | 'url-changed' | 'tab-topology-changed'
export type BrowserClickRisk = 'safe-retry' | 'non-retryable'

export { createBrowserPageSnapshot }
export type { BrowserPageSnapshot }

/** 兼容旧调用方：动作验证统一使用 BrowserPageSnapshot。 */
export type BrowserActionSnapshot = BrowserPageSnapshot

const NON_RETRYABLE_CLICK_PATTERN = /提交|删除|移除|购买|付款|支付|下单|发送|发布|确认订单|submit|delete|remove|buy|purchase|pay|checkout|send|publish|confirm order/i

/** 只把明显可能造成不可逆副作用的控件列为高风险；未知普通控件允许一次受限 fallback。 */
export function classifyBrowserClickRisk(label: string): BrowserClickRisk {
  return NON_RETRYABLE_CLICK_PATTERN.test(label) ? 'non-retryable' : 'safe-retry'
}

export function browserActionSnapshotChanged(before: BrowserActionSnapshot, after: BrowserActionSnapshot): boolean {
  return before.url !== after.url
    || before.title !== after.title
    || before.textHash !== after.textHash
    || before.textLength !== after.textLength
    || before.frameCount !== after.frameCount
    || before.generation !== after.generation
}

/** 旧接口保留，内部统一创建 BrowserPageSnapshot。 */
export function createBrowserActionSnapshot(input: { url: string; title: string; text: string; loading?: boolean; pendingNetworkRequests?: number; frameCount?: number; generation?: number }): BrowserActionSnapshot {
  return createBrowserPageSnapshot(input)
}

export interface BrowserActionEvidence {
  /** 页面命令是否至少有一部分已经发送。已发送就不能把结果伪装成失败后自动重试。 */
  dispatched: boolean
  /** 调用方已经拿到明确的页面拒绝/失败证据。 */
  rejected?: boolean
  /** 页面可观测到的因果结果；none 或缺省表示无法确认。 */
  effect?: BrowserActionEffect
}

/**
 * 把动作证据归一化为对 Agent 可解释的状态。
 *
 * 规则故意保守：事件已派发但没有明确因果结果时返回 unknown，尤其不把 click
 * 当成 verified。这样上层可以要求重新观察，但不会因为延迟反馈重复执行动作。
 */
export function resolveBrowserActionStatus(
  _action: BrowserActionVerificationKind,
  evidence: BrowserActionEvidence,
): BrowserOperationStatus {
  if (evidence.rejected) return 'failed'
  if (!evidence.dispatched) return 'failed'
  if (evidence.effect && evidence.effect !== 'none') return 'verified'
  return 'unknown'
}

export function isBrowserActionResultUncertain(status: BrowserOperationStatus): boolean {
  return status === 'unknown'
}
