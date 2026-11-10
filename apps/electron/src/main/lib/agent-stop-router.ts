import type { AgentStopSource } from './agent-headless-runner-registry'

/** 停止路由只看当前 owner，不看启动来源或本轮环境开关。 */
export function createAgentStopRouter(deps: {
  runtimeActive(sessionId: string): boolean
  stopRuntime(sessionId: string, reason: string): void | Promise<void>
  stopLegacy(sessionId: string, source: AgentStopSource): void
  stopChildren(sessionId: string): void
  onError(sessionId: string, error: unknown): void
}) {
  const visiting = new Set<string>()
  return (sessionId: string, source: AgentStopSource = 'user'): void => {
    if (visiting.has(sessionId)) return
    visiting.add(sessionId)
    try {
      if (deps.runtimeActive(sessionId)) {
        // 先同步标记实际运行停止，再级联；不要 await 后重新按 session 查下一轮 owner。
        const request = deps.stopRuntime(sessionId, source === 'user' ? 'stopped_by_user' : source)
        void Promise.resolve(request).catch(error => deps.onError(sessionId, error))
        deps.stopChildren(sessionId)
      } else {
        // 旧 orchestrator 的 stop 本身负责级联，避免重复发停止请求。
        deps.stopLegacy(sessionId, source)
      }
    } catch (error) {
      deps.onError(sessionId, error)
      throw error
    } finally { visiting.delete(sessionId) }
  }
}
