export interface BrowserPageSnapshot {
  url: string
  title: string
  textHash: string
  textLength: number
  loading: boolean
  pendingNetworkRequests: number
  frameCount: number
  generation: number
}

export interface BrowserPageSnapshotInput {
  url: string
  title: string
  text: string
  loading?: boolean
  pendingNetworkRequests?: number
  frameCount?: number
  generation?: number
}

export interface BrowserPageChange {
  url: boolean
  title: boolean
  content: boolean
  frameTree: boolean
  generation: boolean
}

export function createBrowserPageSnapshot(input: BrowserPageSnapshotInput): BrowserPageSnapshot {
  let hash = 2166136261
  const text = input.text.slice(0, 20_000)
  for (const char of text) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return {
    url: input.url,
    title: input.title,
    textHash: (hash >>> 0).toString(16),
    textLength: input.text.length,
    loading: input.loading === true,
    pendingNetworkRequests: Math.max(0, input.pendingNetworkRequests ?? 0),
    frameCount: Math.max(0, input.frameCount ?? 0),
    generation: input.generation ?? 0,
  }
}

export function compareBrowserPageSnapshots(before: BrowserPageSnapshot, after: BrowserPageSnapshot): BrowserPageChange {
  return {
    url: before.url !== after.url,
    title: before.title !== after.title,
    content: before.textHash !== after.textHash || before.textLength !== after.textLength,
    frameTree: before.frameCount !== after.frameCount,
    generation: before.generation !== after.generation,
  }
}

export function hasBrowserPageChanged(before: BrowserPageSnapshot, after: BrowserPageSnapshot): boolean {
  const change = compareBrowserPageSnapshots(before, after)
  return change.url || change.title || change.content || change.frameTree || change.generation
}
