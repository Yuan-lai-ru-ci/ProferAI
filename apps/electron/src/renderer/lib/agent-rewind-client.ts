import type {
  ExecuteRewindPlanInput,
  PrepareRewindPlanInput,
  PrepareRewindPlanResult,
  RewindPlan,
  RewindResult,
  RewindService,
  UndoRewindInput,
} from '@profer/shared'

export interface RewindClient extends Pick<RewindService, 'prepare' | 'execute' | 'undo'> {
  refine?(input: { sessionId: string; previousPlanId: string; excludedItemIds: string[] }): Promise<PrepareRewindPlanResult>
}

export type RewindClientState = 'idle' | 'preparing' | 'executing' | 'undoing'

export interface RewindClientSnapshot {
  state: RewindClientState
  plan: RewindPlan | null
  result: RewindResult | null
  error: Error | null
}

export function createRewindClient(service: RewindClient): RewindClient {
  return service
}

/** Ensures a repeated click cannot dispatch a duplicate in-flight request. */
export class RewindRequestCoordinator {
  private activeRequest: Promise<unknown> | null = null

  get busy(): boolean {
    return this.activeRequest !== null
  }

  prepare(client: RewindClient, input: PrepareRewindPlanInput): Promise<PrepareRewindPlanResult> | null {
    if (this.activeRequest) return null
    const request = client.prepare(input)
    this.activeRequest = request
    void request.then(
      () => { if (this.activeRequest === request) this.activeRequest = null },
      () => { if (this.activeRequest === request) this.activeRequest = null },
    )
    return request
  }

  execute(client: RewindClient, input: ExecuteRewindPlanInput): Promise<RewindResult> | null {
    if (this.activeRequest) return null
    const request = client.execute(input)
    this.activeRequest = request
    void request.then(
      () => { if (this.activeRequest === request) this.activeRequest = null },
      () => { if (this.activeRequest === request) this.activeRequest = null },
    )
    return request
  }

  undo(client: RewindClient, input: UndoRewindInput): Promise<RewindResult> | null {
    if (this.activeRequest) return null
    const request = client.undo(input)
    this.activeRequest = request
    void request.then(
      () => { if (this.activeRequest === request) this.activeRequest = null },
      () => { if (this.activeRequest === request) this.activeRequest = null },
    )
    return request
  }
}

export function asRewindError(error: unknown): Error {
  return error instanceof Error ? error : new Error(typeof error === 'string' ? error : '回退请求失败')
}
