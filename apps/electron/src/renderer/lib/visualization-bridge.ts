import { VISUALIZATION_INLINE_CSS } from '../../shared/visualization-style'
import { renderFragmentMath } from '../../shared/visualization-math'
import {
  VISUALIZATION_THEME_TOKEN_NAMES,
  VISUALIZATION_THEME_VALUE_MAX_LENGTH,
  normalizeVisualizationTheme as normalizeHostTheme,
} from '../../shared/visualization-theme'
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

/**
 * 线上消息形状仍是「名字 → 值」的宽松记录：
 * 名单、值校验与「读哪些 token」的真源在 `shared/visualization-theme.ts`（main 侧导出也要用）。
 */
export type VisualizationThemeTokens = Record<string, string>

interface VisualizationMessageIdentity {
  token: string
  revision: string
  generation: string
}

export type VisualizationBridgeMessage = VisualizationMessageIdentity & (
  | { type: 'ready' }
  | { type: 'resize'; height: number }
  | { type: 'error'; message: string; height?: number }
  | { type: 'notice'; message: string }
  | { type: 'state'; state: VisualizationViewState }
  | { type: 'interaction'; kind: 'keyboard' | 'pointer' | 'selection' | 'wheel' }
  | { type: 'selection'; objectId: string }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | { type: 'theme'; theme: VisualizationThemeTokens; fontFamily?: string }
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

const MAX_MESSAGE_TEXT_CHARS = 1000
const MAX_FONT_FAMILY_CHARS = 500
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

export function normalizeVisualizationTheme(theme: VisualizationThemeTokens | undefined): VisualizationThemeTokens {
  // 名单与字符白名单在 shared/visualization-theme 收口：主题值来自宿主的计算样式，
  // 但仍要挡住 CSS 语法与 url()，避免被生成内容二次消费。
  return { ...normalizeHostTheme(theme) }
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
    fontFamily: options.fontFamily?.slice(0, MAX_FONT_FAMILY_CHARS),
    theme: normalizeVisualizationTheme(options.theme),
    themeNames: VISUALIZATION_THEME_TOKEN_NAMES,
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
  /* 跨 iframe/跨 realm 的 Error 不一定是本 realm 的实例，按形状取 message 更稳。 */
  function failureText(reason) {
    if (reason && typeof reason === 'object' && typeof reason.message === 'string') return reason.message;
    return String(reason);
  }
  function reportError(error) {
    var message = failureText(error);
    // 报错时把当前高度一并交给宿主：容器按内容定制，不该因为片段出错就塔回默认高度。
    var height = measureHeight();
    var payload = { type: 'error', message: message.slice(0, ${MAX_MESSAGE_TEXT_CHARS}) };
    if (height > 0) payload.height = height;
    post(payload);
  }
  /* CSP / 网络 / 跨域失败是宿主故意挡的（connect-src 'none'、img-src data:），不是片段坏了：
     当成非致命 notice，不让它把已经渲染出来的可视化拆掉。 */
  var BLOCKED_FAILURE = /Content Security Policy|Refused to|Failed to fetch|NetworkError|not allowed|Cross[- ]origin|CORS|Load failed/i;
  var MAX_NOTICES = 5;
  var noticedKeys = {};
  var noticeCount = 0;
  function reportNotice(message) {
    var text = message ? String(message).slice(0, ${MAX_MESSAGE_TEXT_CHARS}) : '';
    if (!text || noticedKeys[text] || noticeCount >= MAX_NOTICES) return;
    noticedKeys[text] = true;
    noticeCount++;
    post({ type: 'notice', message: text });
  }
  function classifyFailure(reason) {
    var message = failureText(reason);
    if (BLOCKED_FAILURE.test(message)) { reportNotice(message); return; }
    reportError(reason);
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
  function applyTheme(theme, fontFamily) {
    if (isRecord(theme)) Object.keys(theme).forEach(function (name) {
      var value = theme[name];
      if (typeof value !== 'string' || value.length > ${VISUALIZATION_THEME_VALUE_MAX_LENGTH} || config.themeNames.indexOf(name) < 0) return;
      if (!/^[#a-zA-Z0-9\\s.,%()/+\\-]+$/.test(value.trim())) return;
      if (/url\\s*\\(|@|\\\\|;|\\{|\\}|<|>|expression|javascript:/i.test(value)) return;
      document.documentElement.style.setProperty(name, value.trim());
    });
    if (typeof fontFamily === 'string' && fontFamily.length > 0 && fontFamily.length <= ${MAX_FONT_FAMILY_CHARS}) document.documentElement.style.setProperty('--profer-font-family', fontFamily);
  }
  var lastHeight = 0;
  var layoutFrame = 0;
  var quietTimer = 0;
  var lastCommitAt = 0;
  var LAYOUT_MARKER = 'data-profer-layout-checked';
  /* 高度按帧变化的内容（进度条生长、列表变长、layout 属性动画）不能让宿主跟着每帧重排：
     结构性跳变（面板展开、切页签）立即上报；其余变化等布局安静下来再收口一次；
     所有路径都至少间隔一个安静窗口，动画期间最多 8 次/秒。 */
  var LAYOUT_IMPATIENT_DELTA = 240;
  var LAYOUT_QUIET_MS = 150;
  var LAYOUT_GROW_STEP = 24;
  function normalizeLayout() {
    // 只检查还没查过的元素：属性变化过的元素在 MutationObserver 里被摘掉标记重查，
    // 已归一化的元素不再逐帧读计算样式。
    document.querySelectorAll('body *:not([' + LAYOUT_MARKER + '])').forEach(function (element) {
      if (!(element instanceof HTMLElement)) return;
      element.setAttribute(LAYOUT_MARKER, '');
      if (element.closest('[data-profer-scroll]')) return;
      var overflow = window.getComputedStyle(element).overflowY;
      if (/(auto|scroll|overlay)/.test(overflow)) {
        element.style.setProperty('overflow-y', 'visible', 'important');
        element.style.setProperty('height', 'auto', 'important');
        element.style.setProperty('max-height', 'none', 'important');
      }
    });
  }
  function measureHeight() {
    if (!document.body) return 0;
    return Math.ceil(Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight));
  }
  function commitHeight(height, immediate) {
    if (height <= 0 || height === lastHeight) return;
    var now = performance.now();
    // 上一个提交还没过一个安静窗口：说明画面还在动，交给静默收口，不逐帧推宿主。
    if (!immediate && now - lastCommitAt < LAYOUT_QUIET_MS) { scheduleQuietCommit(); return; }
    lastCommitAt = now;
    lastHeight = height;
    post({ type: 'resize', height: height });
  }
  /** 布局安静下来以后按最终高度收口一次；任何新的变动都会把它重新计时。 */
  function scheduleQuietCommit() {
    if (quietTimer) window.clearTimeout(quietTimer);
    quietTimer = window.setTimeout(function () {
      quietTimer = 0;
      commitHeight(measureHeight(), true);
    }, LAYOUT_QUIET_MS);
  }
  function scheduleLayout() {
    if (layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(function () {
      layoutFrame = 0;
      if (!document.body) return;
      // 默认随文档伸展。旧页面的固定高度滚动面板也展开；显式控件滚动需单独声明。
      normalizeLayout();
      var height = measureHeight();
      if (height <= 0 || height === lastHeight) return;
      var delta = height - lastHeight;
      if (lastHeight === 0 || delta >= LAYOUT_IMPATIENT_DELTA) { commitHeight(height, true); return; }
      // 变高就跟一步（受频率上限）：长大只会把下方内容往下推，不会把阅读位置抽来抽去，
      // 而“不跟”会把正在生长的内容裁掉。变矮/来回抖则等布局安静后再收口。
      if (delta >= LAYOUT_GROW_STEP) { commitHeight(height, false); return; }
      scheduleQuietCommit();
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
  /*
   * 只有**显式声明的**滚动区才允许吃掉滚轮（见 SKILL：需要刻意可滚动的区域用 data-profer-scroll 标注）。
   * 旧实现是拿计算样式找「任何 overflow:auto|scroll 的祖先」：html/body 的 used value 就是 auto，
   * 而文档几乎总有几像素溢出（body 外边距、取整），于是循环总在根元素上命中并 return，
   * 滚轮被片段内部吃掉、永远转交不到会话 —— 表现就是「鼠标停在内建网页上就滚不动」。
   */
  function innerRegionConsumesWheel(target, delta) {
    var node = target && target.nodeType === 1 ? target : (target && target.parentElement) || null;
    var region = node && node.closest ? node.closest('[data-profer-scroll]') : null;
    if (!region) return false;
    var horizontal = Math.abs(delta.x) > Math.abs(delta.y);
    var size = horizontal ? region.scrollWidth - region.clientWidth : region.scrollHeight - region.clientHeight;
    var position = horizontal ? region.scrollLeft : region.scrollTop;
    if (size <= 1) return false;
    return horizontal ? (delta.x > 0 ? position < size - 1 : position > 0) : (delta.y > 0 ? position < size - 1 : position > 0);
  }
  function blockNavigation(event) {
    var target = event.target && event.target.closest ? event.target.closest('a') : null;
    if (target) event.preventDefault();
  }
  function blockSubmit(event) { event.preventDefault(); }

  try {
    applyTheme(config.theme, config.fontFamily);
    window[config.apiName] = Object.freeze({
      setState: function (state) { try { applyState(state, true); } catch (error) { reportError(error); } },
      getState: function () { return cloneState(localState); },
      selectObject: selectObject
    });
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent || !event.data || event.data.token !== config.token || event.data.revision !== config.revision || event.data.generation !== config.generation) return;
      try {
        if (event.data.type === 'state') { applyState(event.data.state, false); restored = true; }
        else if (event.data.type === 'theme') applyTheme(event.data.theme, event.data.fontFamily);
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
    /* 混合滚动策略：内部可滚动区域自己消费；滚到边界时把未消费增量转交宿主。

       纯原生滚动链的问题：iframe 滚到顶/底后，外层会话容器无法继续滚动，用户感觉「卡住」。
       纯 postMessage 转发的问题：Chromium 把滚轮手势 latch 到 iframe，名额换手时卸载会丢弃整段手势。

       当前方案：检查内部滚动区是否到边界，未消费的增量才转发，既能让内部滚动流畅（原生合成器），
       又能在边界处继续推动外层（宿主接管）。latch 问题通过候选管理的「滚轮钉住」机制缓解。 */
    document.addEventListener('wheel', function (event) {
      if (!event.isTrusted) return;
      lastUserInput = Date.now();
      scheduleInteraction('wheel');

      // 检查是否有内部可滚动区域消费了滚轮
      var delta = { x: event.deltaX, y: event.deltaY };
      if (innerRegionConsumesWheel(event.target, delta)) return;

      // 未被消费，转发给宿主
      scheduleWheel(event.deltaX, event.deltaY);
    }, { passive: true, capture: true });
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
      var mutations = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var record = records[i];
          // 标记是我们自己写的，不算“元素变了”；其余属性变化让该元素下一帧重查一次。
          if (record.type !== 'attributes' || record.attributeName === LAYOUT_MARKER) continue;
          var target = record.target;
          if (target && target.nodeType === 1) target.removeAttribute(LAYOUT_MARKER);
        }
        scheduleLayout();
      });
      mutations.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      window.addEventListener('resize', scheduleLayout);
      document.addEventListener('load', scheduleLayout, true);
      if (document.fonts) document.fonts.ready.then(scheduleLayout);
      scheduleLayout();
    }, { once: true });
    // capture=true 才能收到资源加载失败（外链图片/脚本被 CSP 挡住时没有 message）。
    window.addEventListener('error', function (event) {
      if (!event.message) { reportNotice('资源被阻止加载（外链或非 data: 资源）'); return; }
      classifyFailure(event.message);
    }, true);
    window.addEventListener('unhandledrejection', function (event) { classifyFailure(event.reason); });
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
  const charset = '<meta charset="UTF-8">'
  return `<!doctype html><html><head>${charset}${csp}<script>${bridge}</script></head><body>${renderFragmentMath(content.html)}<style id="profer-inline-layout">${VISUALIZATION_INLINE_CSS}</style></body></html>`
}

export function readVisualizationThemeTokens(): VisualizationThemeTokens {
  if (typeof document === 'undefined') return {}
  const computed = getComputedStyle(document.documentElement)
  const theme: VisualizationThemeTokens = {}
  for (const name of VISUALIZATION_THEME_TOKEN_NAMES) {
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
    case 'error':
      return typeof value.message === 'string' && value.message.length <= MAX_MESSAGE_TEXT_CHARS &&
        (value.height === undefined || (typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0 && value.height <= 1_000_000))
    case 'notice': return typeof value.message === 'string' && value.message.length > 0 && value.message.length <= MAX_MESSAGE_TEXT_CHARS
    case 'wheel': return typeof value.deltaX === 'number' && Number.isFinite(value.deltaX) && typeof value.deltaY === 'number' && Number.isFinite(value.deltaY)
    case 'interaction': return ['keyboard', 'pointer', 'selection', 'wheel'].includes(String(value.kind))
    case 'theme':
      return isRecord(value.theme) &&
        Object.keys(normalizeVisualizationTheme(value.theme as VisualizationThemeTokens)).length === Object.keys(value.theme).length &&
        (value.fontFamily === undefined || (typeof value.fontFamily === 'string' && value.fontFamily.length <= MAX_FONT_FAMILY_CHARS))
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
