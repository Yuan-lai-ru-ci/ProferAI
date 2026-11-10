import type { AgentEvent, AgentStreamPayload, ProferEvent, SDKMessage } from '@profer/shared'

export type AgentRunOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: string }
  | { status: 'stopped'; stopReason?: string }

export type AgentRuntimeEvent = (
  /**
   * 内核产出的一条消息（含 `_partial` 增量帧）。
   *
   * `sessionId` 必须是 **agent 会话 id**，不得从 `message.session_id` 推断：后者是内核
   * 原生会话 id（Pi 的 sdkSessionId / Claude 的 SDK session id），与 agent 会话 id 不同。
   * 宿主用事件自带的 `sessionId` 做 EventBus 路由键；用错键会让 `sdk_message` 在转发层
   * 查不到已绑定的 webContents 而被静默丢弃（症状：UI 不再逐字出流）。
   */
  | { type: 'message'; sessionId: string; message: SDKMessage }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'host_event'; sessionId: string; event: ProferEvent }
  | { type: 'stream_payload'; sessionId: string; payload: AgentStreamPayload }
  | { type: 'retry'; attempt: number; delayMs: number; reason: string }
  /**
   * 执行权已被本轮 run 取得（claim / active）：不等于 provider 已经启动。
   *
   * 与 `runtime_started` 的分工（凭证 / 资源 / 工具装配准备阶段可能失败，provider 从未参与）：
   * - `runtime_claimed`：只表示「本宿主上这个会话有一轮 run 在跑」，宿主据此维护运行态快照
   *   （`isRuntimeRunActive`）与 owner 可见性；**不得**触发未读清除 / draft 晋升 /
   *   `external_run_started` 等「真正运行开始」的副作用。
   * - `runtime_started`：准备成功、provider 即将启动时才发出，是上述副作用的唯一触发点。
   */
  | { type: 'runtime_claimed'; sessionId: string; runtime: string; startedAt: number; title?: string; workspaceId?: string; modelId?: string; initiator?: import('@profer/shared').AgentRunInitiator }
  | { type: 'runtime_started'; sessionId: string; runtime: string; startedAt: number; title?: string; workspaceId?: string; modelId?: string; initiator?: import('@profer/shared').AgentRunInitiator }
  | { type: 'runtime_persistence'; sessionId: string; persistence: import('./ports').RuntimePersistenceState }
  | { type: 'runtime_finished'; sessionId: string; persistence?: import('./ports').RuntimePersistenceState; runtime?: string; outcome: AgentRunOutcome; finishedAt: number; title?: string; workspaceId?: string; modelId?: string; initiator?: import('@profer/shared').AgentRunInitiator }
) & { runId?: string; taskId?: string; triggerId?: string }

export interface AgentRuntimeCompletionSignal {
  outcomeStatus?: 'completed' | 'failed' | 'stopped'
  stopReason?: string
  stoppedByUser?: boolean
  endReason?: string
  endReasonLabel?: string
  resultSubtype?: string
  resultErrors?: readonly string[]
  backgroundTasksPending?: boolean
}
