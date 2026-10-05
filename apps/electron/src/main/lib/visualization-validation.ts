import rehypeRaw from 'rehype-raw'
import postcss from 'postcss'
import { VISUALIZATION_LIMITS } from '@profer/shared'
import type { VisualizationChartSpec, VisualizationObject, VisualizationViewState } from '@profer/shared'

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const FORBIDDEN_TAGS = new Set(['base', 'embed', 'frame', 'frameset', 'iframe', 'link', 'object', 'audio', 'source', 'track', 'video'])
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|avif|bmp)(?:;base64,|;charset=[^,]+,|,)/i

export function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

export function strictKeys(value: Record<string, unknown>, allowed?: string[], description = '参数'): void {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key) || !descriptor || !('value' in descriptor)
      || !descriptor.enumerable || (allowed && !allowed.includes(key))) throw new Error(`可视化${description}包含无效 JSON 字段`)
  }
}

export function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw new Error(`可视化${name}无效`)
  return value
}

export function optionalText(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, name, max)
}

function jsonArray(value: unknown[], description: string, maxLength: number): void {
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength
    || Reflect.ownKeys(value).length !== value.length + 1) throw new Error(`可视化${description}数组无效`)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error(`可视化${description}数组无效`)
  }
}

export function validateObjects(value: unknown): VisualizationObject[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('可视化对象列表无效')
  jsonArray(value, '对象列表', VISUALIZATION_LIMITS.maxObjects)
  const ids = new Set<string>()
  return value.map((item: unknown) => {
    if (!plainObject(item)) throw new Error('可视化对象无效')
    strictKeys(item, ['id', 'label', 'text'], '对象')
    const id = boundedText(item.id, '对象 id', 128)
    if (ids.has(id)) throw new Error('可视化对象 id 重复')
    ids.add(id)
    const text = optionalText(item.text, '对象文本', 2_000)
    return { id, label: boundedText(item.label, '对象标签', 200), ...(text === undefined ? {} : { text }) }
  })
}

export function validateChart(value: unknown): VisualizationChartSpec {
  if (!plainObject(value)) throw new Error('可视化图表规格无效')
  strictKeys(value, ['chartType', 'xKey', 'xAxisLabel', 'nameKey', 'valueKey', 'layout', 'series', 'data'], '图表规格')
  if (!['bar', 'line', 'pie', 'scatter'].includes(value.chartType as string)) throw new Error('可视化图表类型无效')
  if (!Array.isArray(value.series) || value.series.length < 1 || value.series.length > 8) throw new Error('可视化图表系列无效')
  jsonArray(value.series, '图表系列', 8)
  const series = value.series.map((item: unknown) => {
    if (!plainObject(item)) throw new Error('可视化图表系列无效')
    strictKeys(item, ['dataKey', 'label', 'valuePrefix', 'valueSuffix'], '图表系列')
    return {
      dataKey: boundedText(item.dataKey, '图表系列 dataKey', 64),
      ...(item.label === undefined ? {} : { label: boundedText(item.label, '图表系列标签', 120) }),
      ...(item.valuePrefix === undefined ? {} : { valuePrefix: boundedText(item.valuePrefix, '图表前缀', 16) }),
      ...(item.valueSuffix === undefined ? {} : { valueSuffix: boundedText(item.valueSuffix, '图表后缀', 16) }),
    }
  })
  if (!Array.isArray(value.data) || value.data.length < 1 || value.data.length > 200) throw new Error('可视化图表数据无效')
  jsonArray(value.data, '图表数据', 200)
  const data = value.data.map((row: unknown) => {
    if (!plainObject(row)) throw new Error('可视化图表数据行无效')
    strictKeys(row, undefined, '图表数据行')
    if (Object.keys(row).length > 20) throw new Error('可视化图表数据行字段过多')
    const result: Record<string, string | number> = {}
    for (const [key, item] of Object.entries(row)) {
      if (key.length > 64 || (typeof item === 'string' && item.length > 200) || (typeof item !== 'string' && !(typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e15))) throw new Error('可视化图表数据值无效')
      result[key] = item
    }
    return result
  })
  const text = (key: string) => value[key] === undefined ? undefined : boundedText(value[key], key, 120)
  if (new Set(series.map((item) => item.dataKey)).size !== series.length || new Set(series.map((item) => item.label ?? item.dataKey)).size !== series.length) throw new Error('可视化图表系列或图例名称重复')
  const xKey = text('xKey')
  const nameKey = text('nameKey')
  const valueKey = text('valueKey')
  if (value.layout !== undefined && !['horizontal', 'vertical'].includes(value.layout as string)) throw new Error('可视化图表布局无效')
  if (data.some((row) => Object.keys(row).sort().join('\0') !== Object.keys(data[0]!).sort().join('\0'))) throw new Error('图表数据行必须具有相同字段结构')
  if (value.chartType === 'pie') {
    if (!nameKey || !valueKey || series.length !== 1 || series[0]?.dataKey !== valueKey) throw new Error('饼图需要 nameKey、valueKey 和一个匹配的系列')
    if (new Set(data.map((row) => row[nameKey])).size !== data.length) throw new Error('饼图分类名称重复，请先聚合数据')
    if (data.some((row) => typeof row[nameKey] !== 'string' || typeof row[valueKey] !== 'number' || Number(row[valueKey]) < 0) || !data.some((row) => Number(row[valueKey]) > 0)) throw new Error('饼图数值必须非负且总和大于零')
  } else {
    if (!xKey || data.some((row) => !Object.hasOwn(row, xKey) || (value.chartType === 'scatter' && typeof row[xKey] !== 'number'))) throw new Error('图表 xKey 映射无效')
    if (data.some((row) => series.some((item) => typeof row[item.dataKey] !== 'number'))) throw new Error('图表系列数值必须是有限数字')
  }
  const result: VisualizationChartSpec = {
    chartType: value.chartType as VisualizationChartSpec['chartType'],
    ...(xKey === undefined ? {} : { xKey }),
    ...(text('xAxisLabel') === undefined ? {} : { xAxisLabel: text('xAxisLabel') }),
    ...(nameKey === undefined ? {} : { nameKey }),
    ...(valueKey === undefined ? {} : { valueKey }),
    ...(value.layout === undefined ? {} : { layout: value.layout as 'horizontal' | 'vertical' }),
    series, data,
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new Error('可视化图表规格超过 64 KiB')
  return result
}

export function validateViewState(value: unknown): VisualizationViewState {
  if (!plainObject(value)) throw new Error('可视化视图状态必须是普通 JSON 对象')
  const seen = new Set<object>()
  let nodes = 0
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > 2_000 || depth > 32) throw new Error('可视化视图状态超出节点或深度限制')
    if (current === null || typeof current === 'boolean') return
    if (typeof current === 'string') {
      if (current.length > VISUALIZATION_LIMITS.maxStateBytes) throw new Error('可视化视图状态超过 16 KiB 限制')
      return
    }
    if (typeof current === 'number' && Number.isFinite(current)) return
    if (typeof current !== 'object' || current === null || seen.has(current)) throw new Error('可视化视图状态不是有限 JSON')
    seen.add(current)
    if (Array.isArray(current)) {
      // 拒绝稀疏数组、访问器、附加字段和 Symbol，避免 JSON.stringify 静默丢失状态。
      jsonArray(current, '视图状态', 2_000)
      for (const item of current) visit(item, depth + 1)
    } else {
      if (!plainObject(current)) throw new Error('可视化视图状态必须是普通 JSON')
      strictKeys(current, undefined, '视图状态')
      for (const item of Object.values(current)) visit(item, depth + 1)
    }
    seen.delete(current)
  }
  visit(value, 0)
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > VISUALIZATION_LIMITS.maxStateBytes) throw new Error('可视化视图状态超过 16 KiB 限制')
  return JSON.parse(serialized) as VisualizationViewState
}

function localImageOrFragment(value: unknown): boolean {
  return typeof value === 'string' && (DATA_IMAGE.test(value.trim()) || /^#[^\s]*$/.test(value.trim()))
}

function decodeCss(value: string): string {
  return value.replace(/\\([a-fA-F0-9]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\n\r\f])/g, (_match, hex: string | undefined, escaped: string | undefined) => {
    const code = hex ? Number.parseInt(hex, 16) : 0
    return hex ? (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD') : escaped ?? ''
  })
}

function validateCss(css: string): void {
  // CSS 转义和注释均可改写资源函数名，先还原再检查；拒绝引入资源的扩展语法。
  const decoded = decodeCss(css.replace(/\/\*[\s\S]*?\*\//g, ''))
  if (/@import\b|(?:image-set|image|src|paint|element|expression)\s*\(|-moz-binding\s*:/i.test(decoded)) throw new Error('可视化 CSS 包含不支持的外部资源语法')
  let tree: ReturnType<typeof postcss.parse>
  try { tree = postcss.parse(decoded) } catch { throw new Error('可视化 CSS 无效') }
  tree.walkAtRules((rule) => { if (rule.name.toLowerCase() === 'import') throw new Error('可视化不允许外部 CSS') })
  for (const match of decoded.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    if (!localImageOrFragment(match[1] ?? match[2] ?? match[3])) throw new Error('可视化 CSS 包含外部资源')
  }
}

export function validateFragment(html: string): void {
  // 允许两种形式：
  // 1. 纯片段（不含 doctype/html/head/body）
  // 2. 完整 HTML 文档（包含 doctype/html/head/body，且必须有 <meta charset="UTF-8">）
  const hasDoctype = /<\s*!doctype\b/i.test(html)
  const hasHtmlTags = /<\s*\/?\s*(?:html|head|body)\b/i.test(html)
  const hasMain = /<\s*\/?\s*main\b/i.test(html)

  if (hasMain) {
    throw new Error('可视化片段不能包含 <main> 标签；根容器用 #widget')
  }

  // 如果包含任何完整 HTML 结构标签，就要求必须是完整的、带 charset 的文档
  if (hasDoctype || hasHtmlTags) {
    if (!hasDoctype || !hasHtmlTags) {
      throw new Error('可视化片段如果包含 HTML 结构标签，必须是完整文档（doctype + html + head + body）')
    }
    // 检查是否有 <meta charset="UTF-8"> 或 <meta charset='UTF-8'>
    if (!/<meta\s+charset=["']?utf-8["']?\s*\/?>|<meta\s+[^>]*charset=["']?utf-8["']?[^>]*>/i.test(html)) {
      throw new Error('包含中文或非 ASCII 字符的完整 HTML 文档必须在 <head> 中声明 <meta charset="UTF-8">')
    }
  }

  validateHtml(html)
  const tree = rehypeRaw()({ type: 'root', children: [{ type: 'raw', value: html }] }, undefined!)
  type Node = typeof tree | typeof tree.children[number]
  const stack: Node[] = [tree]
  while (stack.length) {
    const node = stack.pop()!
    if ('children' in node) stack.push(...node.children)
    if (node.type !== 'element') continue
    if (Object.keys(node.properties).some((name) => /^on/i.test(name))) throw new Error('可视化片段必须使用 addEventListener，不能使用内联事件处理器')
  }
}

export function validateHtml(html: string): void {
  if (!html.trim() || Buffer.byteLength(html, 'utf8') > VISUALIZATION_LIMITS.maxHtmlBytes) throw new Error('可视化 HTML 为空或超过 512 KiB 限制')
  // 复用现有 rehype-raw 的 HTML5 parser；它的 file 运行时参数可省略。
  const tree = rehypeRaw()({ type: 'root', children: [{ type: 'raw', value: html }] }, undefined!)
  type Node = typeof tree | typeof tree.children[number]
  const stack: Node[] = [tree]
  while (stack.length) {
    const node = stack.pop()!
    if ('children' in node) stack.push(...node.children)
    if (node.type !== 'element') continue
    const tag = node.tagName.toLowerCase()
    if (FORBIDDEN_TAGS.has(tag)) throw new Error('可视化 HTML 包含不支持的外部资源标签')
    const properties = node.properties
    if (tag === 'meta' && properties.httpEquiv !== undefined) throw new Error('可视化 HTML 包含外部资源指令')
    for (const [name, value] of Object.entries(properties)) {
      const lower = name.toLowerCase()
      if (lower === 'style' && typeof value === 'string') validateCss(value)
      if (['srcset', 'imagesrcset', 'srcdoc', 'background', 'ping', 'action', 'formaction', 'manifest', 'codebase', 'data'].includes(lower)) {
        throw new Error('可视化 HTML 包含不支持的外部资源属性')
      }
      if (lower === 'src' && !(['img', 'image'].includes(tag) && localImageOrFragment(value))) throw new Error('可视化 HTML 包含外部资源')
      if (lower === 'href' || lower === 'xlinkhref') {
        if (!localImageOrFragment(value) || (tag !== 'image' && typeof value === 'string' && !value.trim().startsWith('#'))) throw new Error('可视化 HTML 包含外部资源链接')
      }
    }
    if (tag === 'style') validateCss(node.children.filter((child) => child.type === 'text').map((child) => child.value).join(''))
  }
}
