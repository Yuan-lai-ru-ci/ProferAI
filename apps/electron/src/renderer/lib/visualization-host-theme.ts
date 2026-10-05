/**
 * 会话内可视化的**宿主主题通道**：把 app 文档上此刻真正生效的 token 交给 iframe 片段与原生图表。
 *
 * 为什么需要它（而不是各自挂一个 MutationObserver）：
 * 换肤不是一次 DOM 属性变化就能观察完的过程。`atoms/theme.ts` 的 `applyThemeToDOM` 会
 * **同步**切换 `documentElement` 上的 `skin-*` / `dark` 类，而皮肤 CSS 是**异步 IPC**
 * 写进 `<style id="skin-css">` 的。只监听 class 属性的实现会在微任务里读到「上一个皮肤」
 * 的计算值，等 CSS 真正落地时又没有任何信号——于是片段和图表永远停在上一个配色。
 *
 * 正确顺序只有一种：DOM 属性变化时立即发一次（让明暗切换这类同步变化不延迟），
 * 皮肤 CSS 落地后再取一次值补发（`whenSkinCssApplied`）。本模块把这个顺序做成可单测的
 * 纯逻辑，React 侧只负责订阅（见 `hooks/useVisualizationHostTheme.ts`）。
 */
import {
  collectVisualizationThemeTokens,
  type VisualizationThemeTokens,
} from '../../shared/visualization-theme'

export interface VisualizationHostTheme {
  /** app 文档 `:root` 上实际生效的 token（皮肤 CSS 未落地时读到的是上一个主题的值） */
  tokens: VisualizationThemeTokens
  /** 会话正文字体；片段与图表跟随同一套字体栈 */
  fontFamily: string
}

export interface VisualizationThemeChannelDeps {
  /** 读一次当前值；必须是「计算值」，不是缓存 */
  read: () => VisualizationHostTheme
  /** 当前激活皮肤 id（没启用皮肤时为 null） */
  skinId: () => string | null
  /** 等这套皮肤的 CSS 真的落到 DOM；未启用皮肤/皮肤不存在时立即 resolve */
  whenSkinCssApplied: (skinId: string | null) => Promise<void>
  /** 发布一份新主题；相同值不会重复发布 */
  publish: (theme: VisualizationHostTheme) => void
}

export interface VisualizationThemeChannel {
  /**
   * DOM 主题属性刚刚变化：立即取值发布一次。
   * 换肤场景下这次读到的是**还没落地**的旧值——不发布的话同步的明暗切换会延迟，
   * 发布之后 `refresh()` 会再用落地后的值补一次。
   */
  publishNow: () => void
  /** 等皮肤 CSS 落地后再取值发布；并发调用只保留最后一次的结果 */
  refresh: () => Promise<void>
}

export function createVisualizationThemeChannel(deps: VisualizationThemeChannelDeps): VisualizationThemeChannel {
  let publishedKey: string | null = null
  let generation = 0
  const publish = (theme: VisualizationHostTheme): void => {
    const key = JSON.stringify([theme.tokens, theme.fontFamily])
    if (key === publishedKey) return
    publishedKey = key
    deps.publish(theme)
  }
  return {
    publishNow: () => publish(deps.read()),
    refresh: async () => {
      const mine = ++generation
      await deps.whenSkinCssApplied(deps.skinId())
      // 等待期间又发起了新的 refresh：这一轮取值已过期，交给新的那一轮
      if (mine !== generation) return
      publish(deps.read())
    },
  }
}

/**
 * 量一个圆角类名在**当前皮肤下**实际算出来的圆角。
 *
 * 为什么不能只搬 `--radius` 的字面值：皮肤可以把“全局直角”写成**文档级规则**
 * （terminal-dark：`[class*="rounded"]{ border-radius:0 !important }`），这类规则不会随 token 值
 * 进到 iframe / 图表里，于是片段在旧屏微光下仍然是圆角。所以在 app 文档里探一个真带
 * `rounded-*` 类名的元素，让皮肤的规则照样命中它 —— 和 `PluginViewport` 读 frame 计算圆角同一个思路。
 * 默认主题/其他皮肤下探针读到的就是 token 值本身（`rounded-lg` = `--radius`），不影响观感。
 */
export type VisualizationRadiusProbe = (className: string) => string | null

/** 只有长度值能进 token；`getComputedStyle` 回来的是 px，但导出路径可能拿到 rem，两种都接受 */
const RADIUS_VALUE = /^\d+(?:\.\d+)?(?:px|rem|em|%)?$/

/** 把探针结果写回主题 token：探不到就保留原值（CSS 还没加载/无 document 时不让片段掉成直角） */
export function applyEffectiveRadii(tokens: VisualizationThemeTokens, probe: VisualizationRadiusProbe): VisualizationThemeTokens {
  const surface = probe('rounded-lg')
  const pill = probe('rounded-full')
  return {
    ...tokens,
    ...(isUsableRadius(surface) ? { '--radius': surface } : {}),
    ...(isUsableRadius(pill) ? { '--radius-pill': pill } : {}),
  }
}

function isUsableRadius(value: string | null): value is string {
  const trimmed = value?.trim()
  if (!trimmed || !RADIUS_VALUE.test(trimmed)) return false
  // 探针返回的 `0px` 是真实意图（皮肤要直角），必须保留
  return Number.isFinite(Number.parseFloat(trimmed))
}

let radiusProbeElement: HTMLElement | null = null

/** 探针元素只建一次，挂在不影响布局的位置；类名换成 app 的 rounded-* 后读计算值 */
function measureAppRadius(className: string): string | null {
  if (typeof document === 'undefined' || !document.body) return null
  if (!radiusProbeElement?.isConnected) {
    radiusProbeElement = document.createElement('span')
    radiusProbeElement.dataset.proferRadiusProbe = ''
    radiusProbeElement.setAttribute('aria-hidden', 'true')
    radiusProbeElement.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;padding:0;border:0;visibility:hidden;pointer-events:none'
    document.body.appendChild(radiusProbeElement)
  }
  radiusProbeElement.className = className
  const radius = getComputedStyle(radiusProbeElement).borderTopLeftRadius
  return radius ? radius.trim() : null
}

/** 从 app 文档读一次宿主主题（计算值；调用前无需确认皮肤 CSS 是否落地） */
export function readVisualizationHostTheme(): VisualizationHostTheme {
  if (typeof document === 'undefined') return { tokens: {}, fontFamily: '' }
  const computed = getComputedStyle(document.documentElement)
  return {
    tokens: applyEffectiveRadii({ ...collectVisualizationThemeTokens(computed) }, measureAppRadius),
    fontFamily: computed.fontFamily || '',
  }
}
