import { atom, type createStore } from 'jotai/vanilla'
import type { MainWindowBootstrap } from '@profer/shared'
import { collectWindowSessions } from './app-windows'
import { tabsAtom } from '../atoms/tab-atoms'
export const agentWindowListenersReadyAtom = atom(false)
export async function confirmHandoffWhenReady(store: ReturnType<typeof createStore>, bootstrap: MainWindowBootstrap, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  if (bootstrap.initialTab?.type === 'agent' && !store.get(agentWindowListenersReadyAtom)) {
    await new Promise<void>(resolve => {
      const finish = () => { stop(); signal.removeEventListener('abort', finish); resolve() }
      const stop = store.sub(agentWindowListenersReadyAtom, () => { if(store.get(agentWindowListenersReadyAtom))finish() })
      signal.addEventListener('abort',finish,{once:true})
    })
  }
  if(signal.aborted)return
  await window.electronAPI.reportWindowSessions(collectWindowSessions(store.get(tabsAtom)))
  if(signal.aborted)return
  await window.electronAPI.confirmWindowBootstrap(bootstrap.handoffId)
}
