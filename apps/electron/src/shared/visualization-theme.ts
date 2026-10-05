/**
 * 会话内可视化的**宿主主题契约**（单一真源）。
 *
 * 可视化片段跑在一个 sandbox iframe 里（`sandbox="allow-scripts"`，没有 preload、
 * 也读不到 app 文档的样式表），原生图表跑在 renderer 里但只用 ECharts 的 SVG 渲染器。
 * 两条路径都拿不到 app 的 CSS，所以宿主必须把「此刻真正生效的 token 值」搬过去——
 * 默认主题、内置皮肤、用户自定义皮肤因此走同一条路径，不需要在可视化侧维护皮肤清单。
 *
 * 为什么读**计算值**而不是照抄 `globals.css`：皮肤通过 `<style id="skin-css">` 覆写
 * `:root`，用户皮肤还可能改别名（`--x: var(--y)`）。`getComputedStyle` 会把派生链展开，
 * 拿到的就是最终值（HSL 三元组 / 长度），可视化侧不需要复制 app 的派生规则。
 *
 * 三方共用本文件：
 * - renderer `lib/visualization-bridge.ts`：烘进 iframe srcDoc，并在主题变化时 postMessage；
 * - renderer `lib/visualization-host-theme.ts`：读 app 文档的计算值并发布给 iframe / 图表；
 * - main `lib/visualization-export.ts`：导出 HTML 时把当前主题烘进静态页。
 *
 * 名单与校验是**契约**：新增 token 必须同时更新内置 `present-visualization` Skill 正文
 * （`visualization-host-contract.test.ts` 会拦住漂移）。
 */

/**
 * 会被搬运到可视化侧、且**片段可以直接引用**的 Profer token。
 *
 * 取值口径是「app 文档 `:root` 的**计算值**」：颜色 token 是 HSL 三元组
 * （片段里写 `hsl(var(--muted))`），几何 token 是长度值（如 `--radius: 0.625rem`）。
 *
 * 名单刻意只覆盖可视化真正需要的语义 token：表面与文字、控件状态、状态色、
 * 代码块与几何。app 里那些纯应用层的 token（侧栏、对话框、毛玻璃 tooltip 等）
 * 不搬运——片段不该复刻 app 的外壳。
 *
 * 这一组必须全部写进内置 Skill（`visualization-host-contract.test.ts` 守住），
 * 否则模型写出的 token 在片段里静默失效（换肤后尤其像“颜色不跟随”的 bug）。
 *
 * `--radius` / `--radius-pill` 是**几何意图**：宿主不是直接搬 `--radius` 的字面值，
 * 而是在 app 文档里探一个真带 `rounded-*` 类名的元素（见 `renderer/lib/visualization-host-theme.ts`）——
 * 因为皮肤可以把“全局直角”写成文档级规则（terminal-dark 的 `[class*="rounded"]{border-radius:0}`），
 * 这类规则只有真元素能命中，光搬 token 值进不了 iframe。
 */
export const VISUALIZATION_FRAGMENT_TOKEN_NAMES = [
  // 表面与文字
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--card',
  '--card-foreground',
  // 面板（皮肤契约里的分栏背景/描边；片段用 [data-profer-panel] 时走到这两个 token）
  '--panel-surface',
  '--panel-border',
  // 边框与控件状态
  '--border',
  '--input',
  '--ring',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--accent',
  '--accent-foreground',
  // 状态色与代码块
  '--destructive',
  '--destructive-foreground',
  '--success',
  '--warning',
  '--info',
  '--code-bg',
  '--code-fg',
  // 几何
  '--radius',
  '--radius-pill',
] as const

/**
 * 图表系列色（默认值见 `globals.css`，皮肤可覆写）。
 *
 * 只给宿主图表渲染器用——图表由 Profer 自己画，生成内容不该依赖这几个色，
 * 所以不写进 SKILL.md 的颜色 token 清单。
 */
export const VISUALIZATION_CHART_TOKEN_NAMES = [
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-6',
  '--chart-7',
  '--chart-8',
] as const

/** 实际搬运的全部 token：片段可见的 + 图表系列色 */
export const VISUALIZATION_THEME_TOKEN_NAMES = [
  ...VISUALIZATION_FRAGMENT_TOKEN_NAMES,
  ...VISUALIZATION_CHART_TOKEN_NAMES,
] as const


export type VisualizationThemeTokenName = (typeof VISUALIZATION_THEME_TOKEN_NAMES)[number]

/** 只带出现的 token：某个主题没有的 token 不写空串，片段里的 `var(--x, fallback)` 才会走到默认分支 */
export type VisualizationThemeTokens = Partial<Record<VisualizationThemeTokenName, string>>

/** 只需要按名字取值即可，便于单测注入替身（不引入 DOM 依赖） */
export interface VisualizationThemeTokenSource {
  getPropertyValue(property: string): string
}

/** 单个 token 值的长度上限（HSL 三元组/长度值都在 40 字符内，超出即视为畸变） */
export const VISUALIZATION_THEME_VALUE_MAX_LENGTH = 100

/** 允许的字符集：数字、字母（`hsl`/`rgb`/`rem`）、空白、`. , % ( ) / + # -` */
const TOKEN_VALUE_PATTERN = /^[#a-zA-Z0-9\s.,%()/+-]+$/

/** 明确拒绝的语法：`url()`、`@`、转义反斜杠、`;`、`{}`、尖括号与引号（字符集已挡住一部分） */
const FORBIDDEN_VALUE_PATTERN = /url\s*\(|@|\\|;|\{|\}|<|>|expression|javascript:/i

/**
 * 值是否可信。
 *
 * 值来自宿主自己的计算样式，但仍要过一层白名单：它会以 `setProperty(name, value)` 写进
 * iframe 文档（以及导出的静态页），把 CSS 语法/`url()` 挡在外面是纵深防御，
 * 也避免「自定义属性里塞 URL」被生成内容二次消费。
 */
export function isTrustedVisualizationThemeValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > VISUALIZATION_THEME_VALUE_MAX_LENGTH) return false
  if (!TOKEN_VALUE_PATTERN.test(trimmed)) return false
  return !FORBIDDEN_VALUE_PATTERN.test(trimmed)
}

/** 任意输入 → 只保留名单内、值可信的 token（不抛异常，供两端解析不可信载荷） */
export function normalizeVisualizationTheme(input: unknown): VisualizationThemeTokens {
  if (!input || typeof input !== 'object') return {}
  const source = input as Record<string, unknown>
  const tokens: VisualizationThemeTokens = {}
  for (const name of VISUALIZATION_THEME_TOKEN_NAMES) {
    const value = source[name]
    if (isTrustedVisualizationThemeValue(value)) tokens[name] = value.trim()
  }
  return tokens
}

/** 从样式源收集 token：**只收有值的项**（空值 = 该主题没定义这个 token） */
export function collectVisualizationThemeTokens(source: VisualizationThemeTokenSource): VisualizationThemeTokens {
  const tokens: VisualizationThemeTokens = {}
  for (const name of VISUALIZATION_THEME_TOKEN_NAMES) {
    const value = source.getPropertyValue(name).trim()
    if (isTrustedVisualizationThemeValue(value)) tokens[name] = value
  }
  return tokens
}

/** 把 token 渲染成 CSS 声明串（供导出静态页的 `:root{}` 使用）；键序固定便于比对 */
export function serializeVisualizationThemeCss(tokens: unknown): string {
  const safe = normalizeVisualizationTheme(tokens)
  return VISUALIZATION_THEME_TOKEN_NAMES.filter((name) => safe[name]).map((name) => `${name}:${safe[name]}`).join(';')
}
