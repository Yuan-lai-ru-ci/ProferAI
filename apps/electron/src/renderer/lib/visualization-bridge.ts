import { VISUALIZATION_INLINE_CSS } from '../../shared/visualization-style'
import { renderFragmentMath } from '../../shared/visualization-math'
import type {
  VisualizationContent,
  VisualizationQuote,
  VisualizationViewState,
} from '@profer/shared'
import { VISUALIZATION_LIMITS } from '@profer/shared'

export const VISUALIZATION_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ')

export const VISUALIZATION_BRIDGE_API_NAME = 'proferVisualization'
export const VISUALIZATION_STATE_EVENT = 'stateUpdated'

export type VisualizationThemeTokens = Record<string, string>

interface VisualizationMessageIdentity {
  token: string
  revision: string
  generation: string
}

export type VisualizationBridgeMessage = VisualizationMessageIdentity & (
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'error'; message: string }
  | { type: 'state'; state: VisualizationViewState }
  | { type: 'interaction'; kind: 'keyboard' | 'pointer' | 'selection' | 'wheel' }
  | { type: 'selection'; objectId: string }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | { type: 'theme'; theme: VisualizationThemeTokens }
)

export interface VisualizationPageAPI {
  setState(state: VisualizationViewState): void
  getState(): VisualizationViewState
  selectObject(id: string): void
}

export interface VisualizationSrcDocOptions {
  token: string
  generation: string
  theme?: VisualizationThemeTokens
  fontFamily?: string
}

const THEME_TOKEN_NAMES = [
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--border',
  '--primary',
  '--primary-foreground',
  '--card',
  '--card-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
] as const

const MAX_MESSAGE_TEXT_CHARS = 1000
const MAX_OBJECT_ID_CHARS = 512
const INTERACTION_INTERVAL_MS = 80

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function asJsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 将状态限制为 JSON 可表示的普通对象，并在克隆前执行 16KiB 预算检查。 */
export function cloneVisualizationState(state: unknown): VisualizationViewState {
  if (!isRecord(state)) throw new Error('Visualization state must be an object')
  let json: string
  try {
    json = JSON.stringify(state, (_key, value: unknown) => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return value
      throw new Error('Visualization state contains non-JSON values')
    })
  } catch {
    throw new Error('Visualization state is not JSON serializable')
  }
  if (!json || utf8ByteLength(json) > VISUALIZATION_LIMITS.maxStateBytes) {
    throw new Error(`Visualization state exceeds ${VISUALIZATION_LIMITS.maxStateBytes} bytes`)
  }
  try {
    const cloned = JSON.parse(json) as unknown
    if (!isRecord(cloned)) throw new Error('Visualization state must be an object')
    return cloned
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Visualization state is invalid')
  }
}

export function serializeVisualizationState(state: unknown): string {
  const cloned = cloneVisualizationState(state)
  return JSON.stringify(cloned)
}

const COLOR_VALUE = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%/+\-]+\)|[\d.\s%/+\-]+|[a-z]+)$/i

export function normalizeVisualizationTheme(theme: VisualizationThemeTokens | undefined): VisualizationThemeTokens {
  const result: VisualizationThemeTokens = {}
  for (const name of THEME_TOKEN_NAMES) {
    const value = theme?.[name]
    if (typeof value !== 'string' || value.length > 100) continue
    // 主题值来自宿主的 CSS 计算结果；再次限制为颜色/短 token，避免把 CSS 语法带入 srcDoc。
    if (!COLOR_VALUE.test(value.trim())) continue
    result[name] = value.trim()
  }
  return result
}

function isForbiddenHtml(html: string): boolean {
  // 拒绝所有 http-equiv meta，涵盖大小写、属性顺序和实体编码的 refresh。
  // CSP 由宿主统一提供，生成内容也不需要覆盖其他 HTTP 行为。
  return /<\s*base(?:\s|\/?>)/i.test(html) || /<\s*meta\b[^>]*\bhttp-equiv\b/i.test(html)
}

export function assertSafeVisualizationHtml(html: string): void {
  if (typeof html !== 'string' || utf8ByteLength(html) > VISUALIZATION_LIMITS.maxHtmlBytes) {
    throw new Error(`Visualization HTML exceeds ${VISUALIZATION_LIMITS.maxHtmlBytes} bytes`)
  }
  if (isForbiddenHtml(html)) {
    throw new Error('Visualization HTML cannot contain base or meta refresh navigation')
  }
}

export function createVisualizationToken(): string {
  return globalThis.crypto.randomUUID()
}

function createBridgeScript(options: VisualizationSrcDocOptions, revision: string): string {
  const config = asJsonScript({
    apiName: VISUALIZATION_BRIDGE_API_NAME,
    eventName: VISUALIZATION_STATE_EVENT,
    token: options.token,
    generation: options.generation,
    revision,
    maxStateBytes: VISUALIZATION_LIMITS.maxStateBytes,
    interactionInterval: INTERACTION_INTERVAL_MS,
    fontFamily: options.fontFamily?.slice(0, 500),
    theme: normalizeVisualizationTheme(options.theme),
    themeNames: THEME_TOKEN_NAMES,
  })

  return `(function () {
  'use strict';
  var config = ${config};
  var localState = {};
  var restored = false;
  var interactionTimer = 0;
  var wheelTimer = 0;
  var pendingWheelX = 0;
  var pendingWheelY = 0;
  var stateEventName = config.eventName;
  var lastUserInput = 0;
  var lastSelectionAt = -Infinity;

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function cloneState(value) {
    if (!isRecord(value)) throw new Error('Visualization state must be an object');
    var json = JSON.stringify(value, function (key, item) {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
      if (typeof item === 'number' && Number.isFinite(item)) return item;
      if (typeof item === 'object' && (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) return item;
      throw new Error('Visualization state contains non-JSON values');
    });
    if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > config.maxStateBytes) {
      throw new Error('Visualization state exceeds the allowed size');
    }
    var cloned = JSON.parse(json);
    if (!isRecord(cloned)) throw new Error('Visualization state must be an object');
    return cloned;
  }
  function post(message) {
    window.parent.postMessage(Object.assign({ token: config.token, revision: config.revision, generation: config.generation }, message), '*');
  }
  function reportError(error) {
    var message = error instanceof Error ? error.message : String(error);
    post({ type: 'error', message: message.slice(0, ${MAX_MESSAGE_TEXT_CHARS}) });
  }
  function dispatchStateUpdated() {
    window.dispatchEvent(new CustomEvent(stateEventName, { detail: cloneState(localState) }));
  }
  var restoringState = false;
  function applyState(value, notifyParent) {
    var next = cloneState(value);
    if (restoringState) return;
    if (JSON.stringify(next) === JSON.stringify(localState) && notifyParent) return;
    localState = next;
    // 恢复事件内调用 setState 不再回发，以免生成代码形成事件循环。
    restoringState = true;
    try { dispatchStateUpdated(); } finally { restoringState = false; }
    if (notifyParent && restored) post({ type: 'state', state: cloneState(localState) });
  }
  function scheduleInteraction(kind) {
    if (interactionTimer) return;
    interactionTimer = window.setTimeout(function () {
      interactionTimer = 0;
      post({ type: 'interaction', kind: kind });
    }, config.interactionInterval);
  }
  function scheduleWheel(deltaX, deltaY) {
    pendingWheelX += Number.isFinite(deltaX) ? deltaX : 0;
    pendingWheelY += Number.isFinite(deltaY) ? deltaY : 0;
    if (wheelTimer) return;
    wheelTimer = window.requestAnimationFrame(function () {
      var nextX = pendingWheelX;
      var nextY = pendingWheelY;
      pendingWheelX = 0;
      pendingWheelY = 0;
      wheelTimer = 0;
      post({ type: 'wheel', kind: 'wheel', deltaX: nextX, deltaY: nextY });
      scheduleInteraction('wheel');
    });
  }
  function applyTheme(theme) {
    if (!isRecord(theme)) return;
    Object.keys(theme).forEach(function (name) {
      var value = theme[name];
      if (typeof value !== 'string' || value.length > 100 || config.themeNames.indexOf(name) < 0) return;
      if (!/^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\\([\\d\\s.,%/+\\-]+\\)|[\\d.\\s%/+\\-]+|[a-z]+)$/i.test(value.trim())) return;
      document.documentElement.style.setProperty(name, value.trim());
    });
  }
  var lastHeight = 0;
  var layoutFrame = 0;
  var normalizeLayout = true;
  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(function () {
      layoutFrame = 0;
      if (!document.body) return;
      // 默认随文档伸展。旧页面的固定高度滚动面板也展开；显式控件滚动需单独声明。
      if (normalizeLayout) document.querySelectorAll('body *').forEach(function (element) {
        if (!(element instanceof HTMLElement) || element.closest('[data-profer-scroll]')) return;
        var overflow = window.getComputedStyle(element).overflowY;
        if (/(auto|scroll|overlay)/.test(overflow)) {
          element.style.setProperty('overflow-y', 'visible', 'important');
          element.style.setProperty('height', 'auto', 'important');
          element.style.setProperty('max-height', 'none', 'important');
        }
      });
      normalizeLayout = false;
      var height = Math.ceil(Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight));
      if (height > 0 && height !== lastHeight) { lastHeight = height; post({ type: 'resize', height: height }); }
    });
  }
  function selectObject(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > ${MAX_OBJECT_ID_CHARS}) {
      reportError('Visualization object id is invalid');
      return;
    }
    var now = Date.now();
    if (now - lastSelectionAt < config.interactionInterval) return;
    lastSelectionAt = now;
    post({ type: 'selection', kind: 'selection', objectId: id });
    scheduleInteraction('selection');
  }
  function blockNavigation(event) {
    var target = event.target && event.target.closest ? event.target.closest('a') : null;
    if (target) event.preventDefault();
  }
  function blockSubmit(event) { event.preventDefault(); }

  try {
    applyTheme(config.theme);
    if (config.fontFamily) document.documentElement.style.setProperty('--profer-font-family', config.fontFamily);
    window[config.apiName] = Object.freeze({
      setState: function (state) { try { applyState(state, true); } catch (error) { reportError(error); } },
      getState: function () { return cloneState(localState); },
      selectObject: selectObject
    });
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent || !event.data || event.data.token !== config.token || event.data.revision !== config.revision || event.data.generation !== config.generation) return;
      try {
        if (event.data.type === 'state') { applyState(event.data.state, false); restored = true; }
        else if (event.data.type === 'theme') applyTheme(event.data.theme);
      } catch (error) { reportError(error); }
    });
    document.addEventListener('submit', blockSubmit, true);
    // 链接/表单与可取消导航在 iframe 内阻断；跨文档 location 导航还需主进程 will-frame-navigate 守卫。
    if (window.navigation) window.navigation.addEventListener('navigate', function (event) {
      if (!event.hashChange && event.cancelable) event.preventDefault();
    });
    document.addEventListener('click', blockNavigation, true);
    document.addEventListener('auxclick', blockNavigation, true);
    document.addEventListener('keydown', function (event) {
      if (!event.isTrusted) return;
      lastUserInput = Date.now();
      scheduleInteraction('keyboard');
    }, true);
    document.addEventListener('selectionchange', function (event) {
      if (event.isTrusted && Date.now() - lastUserInput < 1000) scheduleInteraction('selection');
    }, true);
    document.addEventListener('pointerdown', function (event) {
      if (!event.isTrusted) return;
      lastUserInput = Date.now();
      scheduleInteraction('pointer');
    }, true);
    document.addEventListener('wheel', function (event) {
      if (!event.isTrusted) return;
      lastUserInput = Date.now();
      scheduleInteraction('wheel');
      if (event.ctrlKey || event.metaKey) return;
      var factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      var deltaX = event.deltaX * factor;
      var deltaY = event.deltaY * factor;
      var target = event.target;
      while (target && target !== document) {
        if (target.nodeType === 1) {
          var style = window.getComputedStyle(target);
          var horizontal = Math.abs(deltaX) > Math.abs(deltaY);
          var overflow = horizontal ? style.overflowX : style.overflowY;
          var size = horizontal ? target.scrollWidth - target.clientWidth : target.scrollHeight - target.clientHeight;
          var position = horizontal ? target.scrollLeft : target.scrollTop;
          var delta = horizontal ? deltaX : deltaY;
          if (/(auto|scroll|overlay)/.test(overflow) && size > 1 && ((delta > 0 && position < size - 1) || (delta < 0 && position > 0))) return;
        }
        target = target.parentNode;
      }
      // 留给页面自己的控件先处理；只有未消费的滚轮才转交会话。
      window.queueMicrotask(function () {
        if (!event.defaultPrevented) { event.preventDefault(); scheduleWheel(deltaX, deltaY); }
      });
    }, { passive: false, capture: true });
    document.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('[data-profer-object-id]') : null;
      if (target && event.isTrusted) selectObject(target.getAttribute('data-profer-object-id'));
    }, true);
    window.open = function () { return null; };
    window.alert = function () {};
    window.confirm = function () { return false; };
    window.prompt = function () { return null; };
    document.addEventListener('DOMContentLoaded', function () {
      post({ type: 'ready' });
      var resize = new ResizeObserver(scheduleLayout);
      resize.observe(document.body);
      var mutations = new MutationObserver(function () { normalizeLayout = true; scheduleLayout(); });
      mutations.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      window.addEventListener('resize', scheduleLayout);
      document.addEventListener('load', scheduleLayout, true);
      if (document.fonts) document.fonts.ready.then(scheduleLayout);
      scheduleLayout();
    }, { once: true });
    window.addEventListener('error', function (event) { reportError(event.message); });
    window.addEventListener('unhandledrejection', function (event) { reportError(event.reason); });
  } catch (error) {
    reportError(error);
  }
})();`
}

/** 生成 iframe srcDoc。用户 HTML 只作为文档内容，不会进入宿主脚本字符串。 */
export function buildVisualizationSrcDoc(content: VisualizationContent, options: VisualizationSrcDocOptions): string {
  if (content.record.schemaVersion !== 1) throw new Error('Unsupported visualization schema')
  assertSafeVisualizationHtml(content.html)
  const revision = content.record.revision
  const theme = normalizeVisualizationTheme(options.theme)
  const csp = `<meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CSP}">`
  const bridge = createBridgeScript({ ...options, theme }, revision)
  return `<!doctype html><html><head>${csp}<script>${bridge}</script></head><body>${renderFragmentMath(content.html)}<style id="profer-inline-layout">${VISUALIZATION_INLINE_CSS}</style></body></html>`
}

export function readVisualizationThemeTokens(): VisualizationThemeTokens {
  if (typeof document === 'undefined') return {}
  const computed = getComputedStyle(document.documentElement)
  const theme: VisualizationThemeTokens = {}
  for (const name of THEME_TOKEN_NAMES) {
    const value = computed.getPropertyValue(name).trim()
    if (value) theme[name] = value
  }
  return normalizeVisualizationTheme(theme)
}

export function isVisualizationBridgeMessage(value: unknown): value is VisualizationBridgeMessage {
  if (!isRecord(value)) return false
  try {
    if (utf8ByteLength(JSON.stringify(value)) > VISUALIZATION_LIMITS.maxStateBytes + 4096) return false
  } catch { return false }
  if (typeof value.token !== 'string' || value.token.length > 256 || typeof value.revision !== 'string' || value.revision.length > 512 || typeof value.generation !== 'string' || value.generation.length > 256) return false
  switch (value.type) {
    case 'ready': return true
    case 'resize': return typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0 && value.height <= 1_000_000
    case 'state':
      try { cloneVisualizationState(value.state); return true } catch { return false }
    case 'selection': return typeof value.objectId === 'string' && value.objectId.length > 0 && value.objectId.length <= MAX_OBJECT_ID_CHARS
    case 'error': return typeof value.message === 'string' && value.message.length <= MAX_MESSAGE_TEXT_CHARS
    case 'wheel': return typeof value.deltaX === 'number' && Number.isFinite(value.deltaX) && typeof value.deltaY === 'number' && Number.isFinite(value.deltaY)
    case 'interaction': return ['keyboard', 'pointer', 'selection', 'wheel'].includes(String(value.kind))
    case 'theme': return isRecord(value.theme) && Object.keys(normalizeVisualizationTheme(value.theme as VisualizationThemeTokens)).length === Object.keys(value.theme).length
    default: return false
  }
}

/** opaque-origin iframe 的 origin 为 null，必须同时验证实际 WindowProxy 和实例身份。 */
export function acceptVisualizationMessage(
  event: Pick<MessageEvent<unknown>, 'source' | 'data'>,
  source: MessageEventSource | null,
  identity: VisualizationMessageIdentity,
): VisualizationBridgeMessage | null {
  if (!source || event.source !== source || !isVisualizationBridgeMessage(event.data)) return null
  const message = event.data
  return message.token === identity.token && message.revision === identity.revision && message.generation === identity.generation ? message : null
}

export function resolveVisualizationQuote(content: VisualizationContent, objectId: string): VisualizationQuote | null {
  const object = content.record.objects.find((candidate) => candidate.id === objectId)
  if (!object) return null
  return {
    visualizationId: content.record.id,
    revision: content.record.revision,
    objectId: object.id,
    label: object.label,
    text: object.text ?? object.label,
  }
}
