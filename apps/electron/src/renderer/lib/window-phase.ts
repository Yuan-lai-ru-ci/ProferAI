export function reportWindowPhase(phase: 'app-ready' | 'target-meta-ready' | 'target-interactive'): void {
  const report = window.electronAPI.reportWindowPhase
  if (typeof report === 'function') void report(phase).catch(console.error)
}

export function isTargetInteractive(state: { sessionId: string; targetSessionId?: string; loadedSessionId: string | null; messagesLoaded: boolean; editorReady: boolean; channelReady: boolean; modelReady: boolean }): boolean {
  return state.sessionId === state.targetSessionId && state.loadedSessionId === state.sessionId
    && state.messagesLoaded && state.editorReady && state.channelReady && state.modelReady
}
export function editorReadinessEvents(notify: (ready: boolean) => void) {
  return { onCreate: () => notify(true), onDestroy: () => notify(false) }
}
