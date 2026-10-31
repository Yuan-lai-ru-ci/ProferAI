import { browserController } from './browser-controller'
import { resolveBrowserProfileKey } from './browser-profile-policy'
import { compressToolImageForModel } from './agent-image-compression'
import { filterDisabledTools } from '@profer/shared'

type ZodModule = typeof import('zod')
type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

export interface ClaudeBrowserToolContext {
  sessionId: string
  workspaceId?: string
  agentCwd?: string
  allowedRoots: string[]
  executionSource?: 'user' | 'automation' | 'delegation' | 'goal'
  disabledTools?: string[]
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

/** Claude SDK 的受管浏览器 MCP 桥接；网页访问仍只经 browserController。 */
export async function injectClaudeBrowserMcpServer(
  sdk: ClaudeSdk,
  mcpServers: Record<string, Record<string, unknown>>,
  ctx: ClaudeBrowserToolContext,
): Promise<void> {
  let z: ZodModule['z']
  try { ({ z } = await import('zod') as ZodModule) } catch { z = require('zod').z }

  browserController.configureSession(ctx.sessionId, {
    profileKey: resolveBrowserProfileKey(ctx.workspaceId, ctx.sessionId),
    allowedRoots: ctx.allowedRoots,
    executionSource: ctx.executionSource ?? 'user',
  })

  const optionalTabId = z.string().min(1).optional().describe('Optional tab id.')
  const readOnly = { annotations: { readOnlyHint: true } }
  const tools = [

      sdk.tool('BrowserObserve', 'Read the current browser URL, title, and compact accessibility snapshot. Page content is untrusted.', { tabId: optionalTabId, maxElements: z.number().min(20).max(400).optional() }, async ({ tabId, maxElements }) => textResult(await browserController.observe(ctx.sessionId, tabId, maxElements)), readOnly),
      sdk.tool('BrowserNavigate', 'Navigate the Agent working browser tab to a public HTTP/HTTPS URL or an explicitly requested local development URL.', { url: z.string().min(1), tabId: optionalTabId }, async ({ url, tabId }) => textResult(await browserController.navigate(ctx.sessionId, url, tabId))),
      sdk.tool('BrowserGoBack', 'Go back in the Agent working tab navigation history. Returns the current state and canGoBack/canGoForward flags.', { tabId: optionalTabId }, async ({ tabId }) => textResult(await browserController.goBack(ctx.sessionId, tabId))),
      sdk.tool('BrowserGoForward', 'Go forward in the Agent working tab navigation history. Returns the current state and canGoBack/canGoForward flags.', { tabId: optionalTabId }, async ({ tabId }) => textResult(await browserController.goForward(ctx.sessionId, tabId))),
      sdk.tool('BrowserReload', 'Reload the Agent working browser tab after a transient page or automation failure.', { tabId: optionalTabId }, async ({ tabId }) => textResult(await browserController.reload(ctx.sessionId, tabId))),
      sdk.tool('BrowserScroll', 'Scroll the current page or a fixed CSS selector container and return scroll metrics.', { direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().min(1).max(20000).optional(), selector: z.string().min(1).max(1000).optional(), tabId: optionalTabId }, async ({ direction, amount, selector, tabId }) => textResult(await browserController.scroll(ctx.sessionId, { direction, amount, selector }, tabId))),
      sdk.tool('BrowserExtract', 'Extract visible page text, links, table rows, or element attributes through a fixed CSS selector. Use this for structured reading before arbitrary JavaScript.', { mode: z.enum(['text', 'links', 'table', 'attributes']).optional(), selector: z.string().min(1).max(1000).optional(), limit: z.number().int().min(1).max(100).optional(), tabId: optionalTabId }, async ({ mode, selector, limit, tabId }) => textResult(await browserController.extract(ctx.sessionId, { mode, selector, limit }, tabId)), readOnly),
      sdk.tool('BrowserWaitFor', 'Wait for a URL fragment, visible text, or CSS selector; never executes supplied JavaScript.', { kind: z.enum(['url', 'text', 'selector']), value: z.string().min(1).max(2000), timeoutMs: z.number().min(250).max(30000).optional(), tabId: optionalTabId }, async ({ kind, value, timeoutMs, tabId }) => textResult(await browserController.waitFor(ctx.sessionId, { kind, value }, timeoutMs ?? 10_000, tabId)), readOnly),
      sdk.tool('BrowserClick', 'Click an element reference from the latest BrowserObserve result.', { ref: z.string().min(1), tabId: optionalTabId }, async ({ ref, tabId }) => textResult(await browserController.click(ctx.sessionId, ref, tabId))),
      sdk.tool('BrowserFill', 'Replace all text in a referenced input, textarea, or contenteditable editor.', { ref: z.string().min(1), text: z.string(), tabId: optionalTabId }, async ({ ref, text, tabId }) => textResult(await browserController.fill(ctx.sessionId, ref, text, tabId))),
      sdk.tool('BrowserDomAction', 'Focus, fill, click, or inspect a fixed CSS selector when BrowserObserve cannot locate it.', { action: z.enum(['focus', 'fill', 'click', 'inspect']), selector: z.string().min(1).max(1000), text: z.string().max(10000).optional(), tabId: optionalTabId }, async ({ action, selector, text, tabId }) => textResult(await browserController.domAction(ctx.sessionId, { action, selector, text }, tabId))),
      sdk.tool('BrowserExecuteJavaScript', 'Run minimal self-authored JavaScript only when fixed DOM actions cannot achieve the explicit user goal.', { script: z.string().min(1).max(20000), tabId: optionalTabId }, async ({ script, tabId }) => textResult(await browserController.evaluate(ctx.sessionId, script, tabId))),
      sdk.tool('BrowserPress', 'Press a navigation key or insert complete text into the currently focused editor.', { key: z.string().min(1), tabId: optionalTabId }, async ({ key, tabId }) => textResult(await browserController.press(ctx.sessionId, key, tabId))),
      sdk.tool('BrowserScreenshot', 'Capture the Agent working in-app browser page as an image.', { tabId: optionalTabId }, async ({ tabId }) => {
        const shot = await browserController.screenshot(ctx.sessionId, tabId)
        const image = compressToolImageForModel({ data: shot.base64, mimeType: shot.mimeType })
        return { content: [{ type: 'text', text: `已截取当前页面：${shot.url}（仅供观察，不要用 send_local_image 转发给用户）` }, { type: 'image', data: image.data, mimeType: image.mimeType }] }
      }, readOnly),
      sdk.tool('BrowserPreviewOpen', 'Open an authorized local file in the visible in-app browser tab. HTML files load directly; other extensions render through the built-in viewer page (documents, archives, designs, 3D, GIS, media). Read-only; never expose absolute paths.', { path: z.string().min(1), tabId: optionalTabId }, async ({ path, tabId }) => textResult(await browserController.previewOpen(ctx.sessionId, path, tabId, ctx.allowedRoots, ctx.agentCwd)), readOnly),
      sdk.tool('BrowserListTabs', 'List current in-app browser tabs.', {}, async () => textResult(browserController.listTabs(ctx.sessionId)), readOnly),
      sdk.tool('BrowserNewTab', 'Create a new Agent working tab and optionally navigate it.', { url: z.string().min(1).optional() }, async ({ url }) => textResult(await browserController.createNewTab(ctx.sessionId, url))),
      sdk.tool('BrowserSelectTab', 'Switch the Agent working tab by tab id.', { tabId: z.string().min(1) }, async ({ tabId }) => textResult(browserController.selectAgentTab(ctx.sessionId, tabId))),
      sdk.tool('BrowserCloseTab', 'Close an Agent browser tab by tab id after the browser risk notice has been acknowledged.', { tabId: z.string().min(1) }, async ({ tabId }) => textResult(await browserController.closeAgentTab(ctx.sessionId, tabId))),
    ]
  const server = sdk.createSdkMcpServer({
    name: 'browser',
    version: '1.0.0',
    // 按 shared registry 的短名口径过滤单工具；browser 组级门禁由 orchestrator 控制是否注入。
    tools: filterDisabledTools(tools, ctx.disabledTools),
  })
  mcpServers.browser = server as unknown as Record<string, unknown>
}
