import type { BrowserPageSnapshot } from './browser-page-snapshot'

export interface BrowserStabilityProbeInput {
  snapshot: BrowserPageSnapshot
  now?: number
}

export interface BrowserStabilityState {
  stable: boolean
  loading: boolean
  pendingNetworkRequests: number
  frameCount: number
  unchangedSamples: number
  lastChangedAt: number | null
}

export interface BrowserStabilityOptions {
  /** 连续多少个相同样本后才认为页面稳定。 */
  requiredUnchangedSamples?: number
  /** 页面仍有网络请求时是否允许报告稳定。默认不允许。 */
  allowPendingNetwork?: boolean
}

/**
 * 页面稳态只依赖注入的快照，不依赖 Electron/CDP。
 * 页面内容变化、frame 数变化、导航代次变化都会打断连续稳定样本。
 */
export class BrowserStabilityProbe {
  private readonly requiredUnchangedSamples: number
  private readonly allowPendingNetwork: boolean
  private previous: BrowserPageSnapshot | null = null
  private unchangedSamples = 0
  private lastChangedAt: number | null = null

  constructor(options: BrowserStabilityOptions = {}) {
    this.requiredUnchangedSamples = Math.max(1, Math.floor(options.requiredUnchangedSamples ?? 2))
    this.allowPendingNetwork = options.allowPendingNetwork === true
  }

  push(input: BrowserStabilityProbeInput): BrowserStabilityState {
    const now = input.now ?? Date.now()
    const changed = this.previous !== null && !sameSnapshot(this.previous, input.snapshot)
    if (this.previous === null || changed) {
      this.unchangedSamples = 1
      this.lastChangedAt = now
    } else {
      this.unchangedSamples++
    }
    this.previous = input.snapshot
    const loading = input.snapshot.loading
    const pendingNetworkRequests = input.snapshot.pendingNetworkRequests
    return {
      stable: !loading
        && (this.allowPendingNetwork || pendingNetworkRequests === 0)
        && this.unchangedSamples >= this.requiredUnchangedSamples,
      loading,
      pendingNetworkRequests,
      frameCount: input.snapshot.frameCount,
      unchangedSamples: this.unchangedSamples,
      lastChangedAt: this.lastChangedAt,
    }
  }

  reset(): void {
    this.previous = null
    this.unchangedSamples = 0
    this.lastChangedAt = null
  }
}

function sameSnapshot(before: BrowserPageSnapshot, after: BrowserPageSnapshot): boolean {
  return before.url === after.url
    && before.title === after.title
    && before.textHash === after.textHash
    && before.textLength === after.textLength
    && before.loading === after.loading
    && before.pendingNetworkRequests === after.pendingNetworkRequests
    && before.frameCount === after.frameCount
    && before.generation === after.generation
}
