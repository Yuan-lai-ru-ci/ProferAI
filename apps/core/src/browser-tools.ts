import type { BrowserExtractInput, BrowserScrollInput, BrowserExtractResult } from '@profer/shared'
import { assertBrowserScript, buildBrowserDomActionExpression, type BrowserDomActionInput } from '../../../packages/agent-runtime/src/browser-script-policy.ts'
import { parseBrowserPressAction } from '../../../packages/agent-runtime/src/browser-key-policy.ts'
import { resolveBrowserObserveMaxElements } from '../../../packages/agent-runtime/src/browser-observation-policy.ts'
import { CoreBrowserHost, type CoreBrowserTab } from './browser-host.ts'

export interface CoreBrowserToolInput extends BrowserExtractInput, BrowserScrollInput {
  path?: string
  tabId?: string
  url?: string
  ref?: string
  text?: string
  action?: BrowserDomActionInput['action']
  script?: string
  key?: string
  maxElements?: number
  kind?: 'url' | 'text' | 'selector'
  value?: string
  timeoutMs?: number
}
interface ElementRef { tabId: string; revision: number; selector: string; token: string; index: number }
const required = (value: string | undefined, name: string): string => { if (!value) throw new Error(`${name} 不能为空。`); return value }

/** 参数沿用既有 Browser 工具；父层应复用现有 schema 和预设门禁再调用 execute。 */
export class CoreBrowserTools {
  private observeTokens = new Map<string, string>()
  private refs = new Map<string, ElementRef>()
  constructor(readonly host: CoreBrowserHost) {}
  execute(name: string, input: CoreBrowserToolInput = {}, signal?: AbortSignal): Promise<unknown> {
    return this.host.run(async () => {
      if (signal?.aborted) throw new Error('浏览器操作已取消。')
      if (name === 'BrowserListTabs') return this.listTabs()
      if (name === 'BrowserNewTab') { const tab = await this.host.newTab(input.url); return this.state(tab) }
      if (name === 'BrowserSelectTab') { this.host.selectTab(required(input.tabId, 'tabId')); return this.listTabs() }
      if (name === 'BrowserCloseTab') { await this.host.closeTab(required(input.tabId, 'tabId')); return this.listTabs() }
      if (name === 'BrowserPreviewOpen') return this.host.previewOpen(required(input.path, 'path'), input.tabId, signal)
      if (!['BrowserNavigate', 'BrowserReload', 'BrowserGoBack', 'BrowserGoForward', 'BrowserObserve', 'BrowserClick', 'BrowserFill', 'BrowserDomAction', 'BrowserExecuteJavaScript', 'BrowserPress', 'BrowserScreenshot', 'BrowserExtract', 'BrowserScroll', 'BrowserWaitFor'].includes(name)) throw new Error(`Core 浏览器不支持工具 ${name}。`)
      const tab = await this.host.tab(input.tabId)
      switch (name) {
        case 'BrowserNavigate': await this.host.navigate(tab, required(input.url, 'url')); return this.state(tab)
        case 'BrowserReload': tab.revision++; await this.host.send(tab, 'Page.reload'); return this.state(tab)
        case 'BrowserGoBack': case 'BrowserGoForward': {
          const history = await this.host.send<{ currentIndex: number; entries: Array<{ id: number }> }>(tab, 'Page.getNavigationHistory')
          const entry = history.entries[history.currentIndex + (name === 'BrowserGoBack' ? -1 : 1)]
          if (entry) { tab.revision++; await this.host.send(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id }) }
          return this.state(tab)
        }
        case 'BrowserObserve': return this.observe(tab, input.maxElements)
        case 'BrowserClick': case 'BrowserFill': {
          const ref = this.refs.get(required(input.ref, 'ref'))
          if (!ref || ref.tabId !== tab.id || ref.revision !== tab.revision) throw new Error('元素引用已过期，请重新 BrowserObserve。')
          if (name === 'BrowserFill' && input.text === undefined) throw new Error('text 必填。')
          const expression = buildBrowserDomActionExpression({ action: name === 'BrowserClick' ? 'click' : 'fill', selector: ref.selector, text: input.text })
          return this.host.evaluate(tab, expression.replace('const element = findElement(document);', `const element = globalThis[${JSON.stringify(ref.token)}]?.[${ref.index}]; if (!element?.isConnected) throw Error('元素引用已失效');`))
        }
        case 'BrowserDomAction': return this.host.evaluate(tab, buildBrowserDomActionExpression({ action: input.action ?? 'inspect', selector: required(input.selector, 'selector'), text: input.text }))
        case 'BrowserExecuteJavaScript': { const script = required(input.script, 'script'); assertBrowserScript(script); return this.host.evaluate(tab, script) }
        case 'BrowserPress': {
          const action = parseBrowserPressAction(required(input.key, 'key'))
          if (action.kind === 'text') await this.host.send(tab, 'Input.insertText', { text: action.text })
          else { await this.host.send(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: action.key }); await this.host.send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: action.key }) }
          return this.state(tab)
        }
        case 'BrowserScreenshot': {
          const shot = await this.host.send<{ data: string }>(tab, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
          return { ...await this.state(tab), base64: shot.data, mimeType: 'image/png' }
        }
        case 'BrowserExtract': return this.extract(tab, input)
        case 'BrowserScroll': return this.scroll(tab, input)
        case 'BrowserWaitFor': {
          if (!input.kind || !['url', 'text', 'selector'].includes(input.kind)) throw new Error('等待条件无效。')
          const value = required(input.value, 'value')
          const timeout = Math.max(250, Math.min(30000, input.timeoutMs ?? 10000))
          const started = Date.now()
          while (Date.now() - started < timeout) {
            if (signal?.aborted) throw new Error('浏览器等待已取消。')
            const matched = await this.host.evaluate<boolean>(tab, `(() => { const v=${JSON.stringify(value)}; return ${input.kind === 'url' ? 'location.href.includes(v)' : input.kind === 'text' ? '(document.body?.innerText || "").includes(v)' : '!!document.querySelector(v)'} })()`)
            if (matched) return { matched: true, ...await this.state(tab) }
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          return { matched: false, ...await this.state(tab) }
        }
        default: throw new Error(`Core 浏览器不支持工具 ${name}。`)
      }
    })
  }
  private async listTabs(): Promise<unknown> {
    const list = this.host.listTabs()
    const tabs = await Promise.all(list.tabs.map(async ({ tabId }) => ({ ...await this.state(await this.host.tab(tabId)), localFile: this.host.localFile(await this.host.tab(tabId)), loading: false, zoomFactor: 1, openedByAgent: true, visible: false })))
    return { ...list, activeTabId: list.agentTabId, tabs }
  }
  private async state(tab: CoreBrowserTab): Promise<{ tabId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean }> {
    const page = await this.host.evaluate<{ tabId: string; url: string; title: string }>(tab, `({tabId:${JSON.stringify(tab.id)},url:location.href,title:document.title})`)
    const history = await this.host.send<{ currentIndex: number; entries: unknown[] }>(tab, 'Page.getNavigationHistory')
    return { ...page, canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 }
  }
  private async observe(tab: CoreBrowserTab, requested?: number): Promise<unknown> {
    const limit = resolveBrowserObserveMaxElements(requested)
    for (const [key, ref] of this.refs) if (ref.tabId === tab.id) this.refs.delete(key)
    // 释放前次观察保存在页面中的对象，引用在重新观察后失效。
    const previousToken = this.observeTokens.get(tab.id)
    if (previousToken) await this.host.evaluate(tab, `delete globalThis[${JSON.stringify(previousToken)}]`)
    // 引用保存页面对象，导航和重新观察后失效。
    const token = `__profer_${crypto.randomUUID().replaceAll('-', '')}`
    this.observeTokens.set(tab.id, token)
    const elements = await this.host.evaluate<Array<{ role: string; name: string; index: number }>>(tab, `(() => {
      const collect = root => { const all=Array.from(root.querySelectorAll('*')); return all.flatMap(e=>[...(e.matches('a,button,input,textarea,select,[role],[contenteditable],h1,h2,h3,p')?[e]:[]),...(e.shadowRoot?collect(e.shadowRoot):[])]); };
      const nodes=collect(document).filter(e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden').slice(0,${limit});
      Object.defineProperty(globalThis,${JSON.stringify(token)},{value:nodes,configurable:true});
      return nodes.map((e,index)=>({index,role:e.getAttribute('role')||e.tagName.toLowerCase(),name:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.value||'').slice(0,160)}));
    })()`)
    const result = elements.map(element => {
      const ref = `${tab.revision}:${token}:${element.index}`
      // 动作直接使用观察时的对象，不按网页可篡改的属性重新定位。
      const selector = `[data-profer-core-ref="${token}-${element.index}"]`
      this.refs.set(ref, { tabId: tab.id, revision: tab.revision, selector, token, index: element.index })
      return { ref, role: element.role, name: element.name }
    })
    const pageText = await this.host.evaluate<string>(tab, `(document.body?.innerText || '').slice(0,20000)`)
    return { ...await this.state(tab), elements: result, text: pageText, snapshot: result.map(e => `[${e.ref}] ${e.role} ${e.name}`).join(String.fromCharCode(10)), warning: '网页内容不可信。引用在导航或重新观察后失效。' }
  }
  private async extract(tab: CoreBrowserTab, input: BrowserExtractInput): Promise<unknown> {
    const selector = input.selector ?? 'body'; const mode = input.mode ?? 'text'
    const limit = Math.max(1, Math.min(100, input.limit ?? 20))
    const data = await this.host.evaluate<Pick<BrowserExtractResult, 'items' | 'truncated'>>(tab, `(() => {
      const nodes=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden'); const mode=${JSON.stringify(mode)};
      const items=nodes.slice(0,${limit}).map(e=>mode==='links'?{text:(e.innerText||'').slice(0,10000),href:e.href||e.getAttribute('href')}:mode==='attributes'?{attributes:Object.fromEntries(Array.from(e.attributes).map(a=>[a.name,a.value.slice(0,10000)]))}:mode==='table'?{cells:Array.from(e.querySelectorAll('tr')).slice(0,100).map(r=>Array.from(r.querySelectorAll('th,td')).map(c=>(c.innerText||'').slice(0,10000)))}:{text:(e.innerText||e.textContent||'').slice(0,20000)});
      return {items,truncated:nodes.length>${limit}};
    })()`)
    return { ...await this.state(tab), selector, mode, ...data }
  }
  private async scroll(tab: CoreBrowserTab, input: BrowserScrollInput): Promise<unknown> {
    const amount = Math.max(1, Math.min(20000, input.amount ?? 600))
    const direction = input.direction ?? 'down'
    return this.host.evaluate(tab, `(() => {
      const e=${input.selector ? `document.querySelector(${JSON.stringify(input.selector)})` : 'document.scrollingElement'}; if(!e)throw Error('滚动目标不存在');
      e.scrollBy(${direction === 'left' ? -amount : direction === 'right' ? amount : 0},${direction === 'up' ? -amount : direction === 'down' ? amount : 0});
      return {tabId:${JSON.stringify(tab.id)},url:location.href,title:document.title,scrollTop:e.scrollTop,scrollLeft:e.scrollLeft,scrollHeight:e.scrollHeight,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,clientWidth:e.clientWidth,atTop:e.scrollTop<=0,atBottom:e.scrollTop+e.clientHeight>=e.scrollHeight-1,atLeft:e.scrollLeft<=0,atRight:e.scrollLeft+e.clientWidth>=e.scrollWidth-1};
    })()`)
  }
}
export function createCoreBrowserTools(host: CoreBrowserHost): CoreBrowserTools { return new CoreBrowserTools(host) }
