import { withBrowserCdpTimeout } from './browser-cdp'
import type { Debugger } from 'electron'

const IFRAME_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }

/** Page 的 document-start hook 不跨 OOPIF target；逐级接入 iframe，安装完成后才恢复脚本。 */
export class BrowserDialogFrameScripts {
  private generation = 0
  private disposed = false
  private readonly children = new Map<string, number>()

  constructor(private readonly debuggerClient: Debugger, private readonly source: string, private readonly failed: (error: unknown) => void) {
    debuggerClient.on('message', this.onMessage)
  }

  async start(): Promise<void> {
    if (this.disposed) throw new Error('网页对话框通道已关闭。')
    const generation = ++this.generation
    this.children.clear()
    await this.install(undefined, () => !this.disposed && generation === this.generation)
  }

  private async install(sessionId: string | undefined, current: () => boolean): Promise<void> {
    const send = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (!current()) return Promise.reject(new Error('网页提示安装实例已失效。'))
      return withBrowserCdpTimeout(() => sessionId
        ? this.debuggerClient.sendCommand(method, params, sessionId) : this.debuggerClient.sendCommand(method, params), `Dialog.${method}`, 8_000)
    }
    await send('Page.enable', {})
    await send('Page.addScriptToEvaluateOnNewDocument', { source: this.source, runImmediately: true })
    await send('Target.setAutoAttach', IFRAME_ATTACH)
  }

  private readonly onMessage = (_event: Electron.Event, method: string, raw: unknown): void => {
    if (this.disposed || !raw || typeof raw !== 'object') return
    const params = raw as Record<string, unknown>
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined
    if (!sessionId) return
    if (method === 'Target.detachedFromTarget') { this.children.delete(sessionId); return }
    const target = params.targetInfo && typeof params.targetInfo === 'object' ? params.targetInfo as Record<string, unknown> : null
    if (method !== 'Target.attachedToTarget' || target?.type !== 'iframe' || this.children.has(sessionId)) return
    const generation = this.generation
    this.children.set(sessionId, generation)
    const current = (): boolean => !this.disposed && generation === this.generation && this.children.get(sessionId) === generation
    void this.install(sessionId, current).then(async () => {
      if (current()) await this.debuggerClient.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId)
    }).catch(error => { if (current()) this.failed(error) })
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.children.clear()
    this.debuggerClient.removeListener('message', this.onMessage)
  }
}
