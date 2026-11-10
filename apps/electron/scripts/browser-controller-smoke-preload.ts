import { contextBridge, ipcRenderer } from 'electron'
import { AGENT_IPC_CHANNELS } from '@profer/shared'
import type { BrowserGuestRequest, BrowserGuestVisibility, BrowserViewState } from '@profer/shared'

contextBridge.exposeInMainWorld('electronAPI', {
  connectBrowserGuestHost: () => ipcRenderer.invoke(AGENT_IPC_CHANNELS.CONNECT_BROWSER_GUEST_HOST),
  bindBrowserGuest: (claim: import('@profer/shared').BrowserGuestClaim) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.BIND_BROWSER_GUEST, claim),
  onBrowserGuestsChanged: (callback: (requests: BrowserGuestRequest[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requests: BrowserGuestRequest[]) => callback(requests)
    ipcRenderer.on(AGENT_IPC_CHANNELS.BROWSER_GUESTS_CHANGED, listener)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.BROWSER_GUESTS_CHANGED, listener)
  },
  setBrowserGuestVisibility: (pages: BrowserGuestVisibility[]) => ipcRenderer.send(AGENT_IPC_CHANNELS.SET_BROWSER_GUEST_VISIBILITY, pages),
  onAgentBrowserStateChanged: (callback: (state: BrowserViewState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserViewState) => callback(state)
    ipcRenderer.on(AGENT_IPC_CHANNELS.BROWSER_STATE_CHANGED, listener)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.BROWSER_STATE_CHANGED, listener)
  },
  onBrowserGuestFocused: (callback: (page: import('@profer/shared').BrowserGuestFocusEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, page: import('@profer/shared').BrowserGuestFocusEvent) => callback(page)
    ipcRenderer.on(AGENT_IPC_CHANNELS.BROWSER_GUEST_FOCUSED, listener)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.BROWSER_GUEST_FOCUSED, listener)
  },
  setBrowserShortcutContext: (context: import('@profer/shared').BrowserShortcutContext) => ipcRenderer.send(AGENT_IPC_CHANNELS.SET_BROWSER_SHORTCUT_CONTEXT, context),
  onBrowserShortcut: (callback: (event: import('@profer/shared').BrowserShortcutEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, input: import('@profer/shared').BrowserShortcutEvent) => callback(input)
    ipcRenderer.on(AGENT_IPC_CHANNELS.BROWSER_SHORTCUT, listener)
    return () => ipcRenderer.removeListener(AGENT_IPC_CHANNELS.BROWSER_SHORTCUT, listener)
  },
  getSettings: () => ipcRenderer.invoke('smoke:get-settings'),
  getBrowserStartPage: () => ipcRenderer.invoke('smoke:get-browser-start-page'),
  navigateAgentBrowser: (input: { sessionId: string; tabId?: string; url: string }) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.NAVIGATE_BROWSER, input),
  goBackAgentBrowser: (sessionId: string, tabId?: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.GO_BACK_BROWSER, sessionId, tabId),
  goForwardAgentBrowser: (sessionId: string, tabId?: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.GO_FORWARD_BROWSER, sessionId, tabId),
  reloadAgentBrowser: (sessionId: string, tabId?: string) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.RELOAD_BROWSER, sessionId, tabId),
  stopBrowserPage: (input: import('@profer/shared').BrowserTabInput) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.STOP_BROWSER_PAGE, input),
  findBrowserPage: (input: import('@profer/shared').BrowserTabInput & import('@profer/shared').BrowserFindInput) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.FIND_BROWSER_PAGE, input),
  clearBrowserFind: (input: import('@profer/shared').BrowserTabInput) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.CLEAR_BROWSER_FIND, input),
  respondBrowserDialog: (input: import('@profer/shared').BrowserTabInput & import('@profer/shared').BrowserDialogResponse) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.RESPOND_BROWSER_DIALOG, input),
})
