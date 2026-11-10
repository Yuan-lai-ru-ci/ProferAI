import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { BrowserDialogResponse, BrowserFindInput, BrowserFindState, BrowserPageInteractionState, BrowserScriptDialog } from '@profer/shared'
import type { BrowserDialogRequest, BrowserDialogValue } from './browser-dialog-protocol'

interface PendingDialog {
  state: BrowserScriptDialog
  alive: () => boolean
  settle: (value: BrowserDialogValue) => void
}

/** 每页查找/提示状态；UI 回应不接入 Agent 命令队列，不显示原生窗口或自动确认。 */
export class BrowserPageInteractions {
  private findState: BrowserFindState | null = null
  private pending: PendingDialog | null = null
  private findRequestId = 0
  private matchCase = false
  private disposed = false

  constructor(private readonly contents: WebContents, private readonly changed: () => void, private readonly dialogTimeoutMs = 5 * 60_000) {
    contents.on('found-in-page', this.onFound)
  }

  snapshot(): BrowserPageInteractionState {
    return { find: this.findState ? { ...this.findState } : null, dialog: this.pending ? { ...this.pending.state } : null }
  }

  find(input: BrowserFindInput): void {
    if (this.disposed) throw new Error('浏览器页面已关闭。')
    const query = input.query.slice(0, 1000)
    if (!query) { this.clearFind(); return }
    const matchCase = input.matchCase === true
    const continued = input.next === true && this.findState?.query === query && this.matchCase === matchCase
    this.findState = { query, matchCase, matches: continued ? this.findState?.matches ?? 0 : 0, activeMatchOrdinal: continued ? this.findState?.activeMatchOrdinal ?? 0 : 0, searching: true }
    this.matchCase = matchCase
    this.findRequestId = this.contents.findInPage(query, { forward: input.forward !== false, findNext: !continued, matchCase })
    this.changed()
  }

  clearFind(): void {
    this.findRequestId = 0
    this.findState = null
    if (!this.contents.isDestroyed()) this.contents.stopFindInPage('clearSelection')
    this.changed()
  }

  requestDialog(input: BrowserDialogRequest, alive: () => boolean, signal: AbortSignal): Promise<BrowserDialogValue> {
    if (this.disposed || this.pending || signal.aborted || !alive()) return Promise.resolve(input.type === 'confirm' ? false : null)
    return new Promise(resolve => {
      const state: BrowserScriptDialog = { ...input, id: randomUUID(), responding: false }
      const cancel = (): void => settle(input.type === 'confirm' ? false : null)
      const settle = (value: BrowserDialogValue): void => {
        if (this.pending?.state.id !== state.id) return
        this.pending = null
        clearTimeout(timeout)
        clearInterval(liveness)
        signal.removeEventListener('abort', cancel)
        resolve(value)
        this.changed()
      }
      const timeout = setTimeout(cancel, this.dialogTimeoutMs)
      // 仅等待提示期间检查 frame 存活；空闲页面没有常驻轮询。
      const liveness = setInterval(() => { if (!alive()) cancel() }, 250)
      timeout.unref?.(); liveness.unref?.()
      this.pending = { state, alive, settle }
      signal.addEventListener('abort', cancel, { once: true })
      this.changed()
    })
  }

  async respond(input: BrowserDialogResponse): Promise<void> {
    const current = this.pending
    if (this.disposed || !current || current.state.id !== input.dialogId || !current.alive()) {
      if (current && !current.alive()) current.settle(current.state.type === 'confirm' ? false : null)
      throw new Error('网页对话框已失效，请重新查看页面。')
    }
    current.settle(current.state.type === 'confirm' ? input.accept
      : current.state.type === 'prompt' && input.accept ? (input.promptText ?? '').slice(0, 10_000) : null)
  }

  cancelDialog(): void {
    if (this.pending) this.pending.settle(this.pending.state.type === 'confirm' ? false : null)
  }

  resetDocument(): void {
    if (this.findState) this.clearFind()
    this.cancelDialog()
  }

  private readonly onFound = (_event: Electron.Event, result: Electron.Result): void => {
    if (this.disposed || !this.findState || result.requestId !== this.findRequestId) return
    this.findState = { ...this.findState, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal, searching: !result.finalUpdate }
    this.changed()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.contents.removeListener('found-in-page', this.onFound)
    this.findState = null
    this.cancelDialog()
  }
}
