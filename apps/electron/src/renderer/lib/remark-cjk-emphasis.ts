import type { Options } from 'react-markdown'

type RemarkPlugin = Extract<NonNullable<Options['remarkPlugins']>[number], (...args: never[]) => unknown>

/** 允许中文标点旁的强调边界，复用 micromark 配对规则，不改源码、代码或转义。 */
export const remarkCjkEmphasis: RemarkPlugin = function () {
  const data = this.data() as { micromarkExtensions?: Array<{ attentionMarkers?: { null: number[] } }> }
  const extensions = data.micromarkExtensions ?? (data.micromarkExtensions = [])
  extensions.push({
    attentionMarkers: { null: Array.from('，。！？：；、（）「」『』【】《》〈〉“”‘’', (char) => char.charCodeAt(0)) },
  })
}
