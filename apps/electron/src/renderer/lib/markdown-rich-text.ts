import MarkdownIt from 'markdown-it'

const markdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

export function markdownToHtml(markdown: string): string {
  if (!markdown) return ''
  return markdownIt.render(markdown)
}

/** 将 TipTap 输出的 HTML 转换为 Markdown 格式 */
export function htmlToMarkdown(html: string): string {
  if (!html || html === '<p></p>') return ''

  const div = document.createElement('div')
  div.innerHTML = html

  function processNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || ''
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return ''
    }

    const el = node as HTMLElement
    const tagName = el.tagName.toLowerCase()
    const children = Array.from(el.childNodes).map(processNode).join('')

    switch (tagName) {
      case 'p':
        return children + '\n'
      case 'br':
        return '\n'
      case 'strong':
      case 'b':
        return `**${children}**`
      case 'em':
      case 'i':
        return `*${children}*`
      case 'u':
        return `<u>${children}</u>`
      case 's':
      case 'strike':
      case 'del':
        return `~~${children}~~`
      case 'code':
        if (el.parentElement?.tagName.toLowerCase() === 'pre') {
          return children
        }
        return `\`${children}\``
      case 'pre': {
        const codeEl = el.querySelector('code')
        const langClass = codeEl?.className || ''
        const langMatch = langClass.match(/language-(\w+)/)
        const lang = langMatch ? langMatch[1] : ''
        const codeContent = codeEl ? processNode(codeEl) : children
        return `\`\`\`${lang}\n${codeContent}\n\`\`\`\n`
      }
      case 'a': {
        const href = el.getAttribute('href') || ''
        return `[${children}](${href})`
      }
      case 'ul':
        return Array.from(el.children)
          .map((li) => `- ${processNode(li).trim()}`)
          .join('\n') + '\n'
      case 'ol':
        return Array.from(el.children)
          .map((li, i) => `${i + 1}. ${processNode(li).trim()}`)
          .join('\n') + '\n'
      case 'li':
        return children
      case 'blockquote':
        return children
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n') + '\n'
      case 'h1': return `# ${children}\n`
      case 'h2': return `## ${children}\n`
      case 'h3': return `### ${children}\n`
      case 'h4': return `#### ${children}\n`
      case 'h5': return `##### ${children}\n`
      case 'h6': return `###### ${children}\n`
      case 'hr': return '---\n'
      case 'span': {
        const dataType = el.getAttribute('data-type')
        const dataId = el.getAttribute('data-id') || ''
        const suggestionChar = el.getAttribute('data-mention-suggestion-char') || '@'
        if (dataType === 'mention') {
          if (suggestionChar === '/') return `/skill:${dataId}`
          if (suggestionChar === '#') return `#mcp:${dataId}`
          return `@file:${dataId}`
        }
        return children
      }
      default: return children
    }
  }

  return processNode(div).trim()
}
