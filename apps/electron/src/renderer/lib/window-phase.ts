export function reportWindowPhase(phase: 'app-ready' | 'target-meta-ready' | 'target-interactive'): void {
  const report = window.electronAPI.reportWindowPhase
  if (typeof report === 'function') void report(phase).catch(console.error)
}

export function isTargetInteractive(state: { sessionId: string; targetSessionId?: string; loadedSessionId: string | null; messagesLoaded: boolean; editorReady: boolean; channelReady: boolean; modelReady: boolean }): boolean {
  return state.sessionId === state.targetSessionId && state.loadedSessionId === state.sessionId
    && state.messagesLoaded && state.editorReady && state.channelReady && state.modelReady
}
export function observeEditorReadiness(
  editor: { isInitialized: boolean; isDestroyed: boolean; on(event: 'create' | 'destroy', callback: () => void): unknown; off(event: 'create' | 'destroy', callback: () => void): unknown },
  notify: (ready: boolean) => void,
): () => void {
  const onCreate = () => notify(true)
  const onDestroy = () => notify(false)
  editor.on('create', onCreate)
  editor.on('destroy', onDestroy)
  notify(editor.isInitialized && !editor.isDestroyed)
  return () => {
    editor.off('create', onCreate)
    editor.off('destroy', onDestroy)
    notify(false)
  }
}
