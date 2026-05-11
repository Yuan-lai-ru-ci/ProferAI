import * as React from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { highlightCode, highlightCodeSync } from '@proma/core'
import type { FileAccessOptions } from '@proma/shared'
import { cn } from '@/lib/utils'

type FileAccessRef = React.MutableRefObject<FileAccessOptions | undefined>
type ThemeRef = React.MutableRefObject<string>

function isExternalUrl(src: string): boolean {
  return /^(?:https?:|data:|blob:|file:|proma-file:)/i.test(src)
}

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['iframe', 'video', 'source', 'summary', 'details'],
    ADD_ATTR: [
      'allow',
      'allowfullscreen',
      'controls',
      'frameborder',
      'loading',
      'poster',
      'src',
      'target',
    ],
  })
}

function useResolvedMediaSrc(src: string, fileAccessRef: FileAccessRef): string {
  const [resolvedSrc, setResolvedSrc] = React.useState(src)

  React.useEffect(() => {
    if (!src || isExternalUrl(src)) {
      setResolvedSrc(src)
      return
    }

    let cancelled = false
    window.electronAPI
      .resolveFilePath(src, fileAccessRef.current)
      .then((result) => {
        if (!cancelled) setResolvedSrc(result?.url ?? src)
      })
      .catch(() => {
        if (!cancelled) setResolvedSrc(src)
      })

    return () => { cancelled = true }
  }, [fileAccessRef, src])

  return resolvedSrc
}

function MarkdownImageView({ node }: NodeViewProps, fileAccessRef: FileAccessRef): React.ReactElement {
  const src = String(node.attrs.src ?? '')
  const alt = String(node.attrs.alt ?? '')
  const title = String(node.attrs.title ?? '')
  const resolvedSrc = useResolvedMediaSrc(src, fileAccessRef)

  return (
    <NodeViewWrapper as="figure" className="not-prose my-3">
      <img
        src={resolvedSrc}
        alt={alt}
        title={title || undefined}
        draggable={false}
        className="max-w-full rounded-md border border-border/30 bg-muted/20"
      />
      {title && <figcaption className="mt-1 text-center text-xs text-muted-foreground">{title}</figcaption>}
    </NodeViewWrapper>
  )
}

function MarkdownVideoView({ node }: NodeViewProps, fileAccessRef: FileAccessRef): React.ReactElement {
  const src = String(node.attrs.src ?? '')
  const title = String(node.attrs.title ?? '')
  const poster = String(node.attrs.poster ?? '')
  const resolvedSrc = useResolvedMediaSrc(src, fileAccessRef)
  const resolvedPoster = useResolvedMediaSrc(poster, fileAccessRef)

  return (
    <NodeViewWrapper as="figure" className="not-prose my-3">
      <video
        src={resolvedSrc}
        poster={resolvedPoster || undefined}
        title={title || undefined}
        controls
        className="max-h-[520px] max-w-full rounded-md border border-border/30 bg-black"
      />
      {title && <figcaption className="mt-1 text-center text-xs text-muted-foreground">{title}</figcaption>}
    </NodeViewWrapper>
  )
}

function RawHtmlBlockView({ node }: NodeViewProps): React.ReactElement {
  const html = String(node.attrs.html ?? '')
  return (
    <NodeViewWrapper
      className="not-prose my-3 overflow-auto"
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
    />
  )
}

function RawHtmlInlineView({ node }: NodeViewProps): React.ReactElement {
  const html = String(node.attrs.html ?? '')
  return (
    <NodeViewWrapper
      as="span"
      className="not-prose inline-block align-baseline"
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }}
    />
  )
}

function MathInlineView({ node }: NodeViewProps): React.ReactElement {
  const latex = String(node.attrs.latex ?? '')
  const html = React.useMemo(() => {
    try {
      return katex.renderToString(latex, { throwOnError: false })
    } catch {
      return latex
    }
  }, [latex])

  return (
    <NodeViewWrapper
      as="span"
      className="not-prose inline-block align-baseline"
      data-latex={latex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function MathBlockView({ node }: NodeViewProps): React.ReactElement {
  const latex = String(node.attrs.latex ?? '')
  const html = React.useMemo(() => {
    try {
      return katex.renderToString(latex, { displayMode: true, throwOnError: false })
    } catch {
      return latex
    }
  }, [latex])

  return (
    <NodeViewWrapper
      className="not-prose my-4 overflow-x-auto text-center"
      data-latex={latex}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function ShikiCodeBlockView({ node }: NodeViewProps, themeRef: ThemeRef): React.ReactElement {
  const code = node.textContent
  const language = String(node.attrs.language ?? 'text') || 'text'
  const [highlightedHtml, setHighlightedHtml] = React.useState(() => {
    const result = highlightCodeSync({ code, language, theme: themeRef.current })
    return result ? sanitizeHtml(result.html) : ''
  })

  React.useEffect(() => {
    let cancelled = false
    const sync = highlightCodeSync({ code, language, theme: themeRef.current })
    if (sync) {
      setHighlightedHtml(sanitizeHtml(sync.html))
      return
    }

    highlightCode({ code, language, theme: themeRef.current })
      .then((result) => {
        if (!cancelled) setHighlightedHtml(sanitizeHtml(result.html))
      })
      .catch(() => {
        if (!cancelled) setHighlightedHtml('')
      })

    return () => { cancelled = true }
  }, [code, language, themeRef])

  return (
    <NodeViewWrapper className="not-prose my-3 overflow-hidden rounded-md border border-border/40 bg-muted/30">
      <div className="flex h-8 items-center justify-between border-b border-border/30 px-3 text-xs text-muted-foreground">
        <span>{language === 'text' ? 'Code' : language}</span>
      </div>
      {highlightedHtml ? (
        <div
          className={cn(
            '[&_.shiki]:!m-0 [&_.shiki]:!rounded-none [&_.shiki]:!bg-transparent',
            '[&_.shiki]:overflow-x-auto [&_.shiki]:p-4 [&_.shiki_code]:text-[13px] [&_.shiki_code]:leading-[1.6]',
          )}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <pre className="m-0 overflow-x-auto p-4 text-[13px] leading-[1.6]"><code>{code}</code></pre>
      )}
    </NodeViewWrapper>
  )
}

export function createMarkdownImage(fileAccessRef: FileAccessRef): Node {
  return Node.create({
    name: 'markdownImage',
    group: 'block',
    atom: true,
    draggable: true,

    addAttributes() {
      return {
        src: { default: '' },
        alt: { default: '' },
        title: { default: '' },
      }
    },

    parseHTML() {
      return [{
        tag: 'img[src]',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false
          return {
            src: node.getAttribute('src') || '',
            alt: node.getAttribute('alt') || '',
            title: node.getAttribute('title') || '',
          }
        },
      }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['img', mergeAttributes(HTMLAttributes)]
    },

    addNodeView() {
      return ReactNodeViewRenderer((props) => MarkdownImageView(props, fileAccessRef))
    },
  })
}

export function createMarkdownVideo(fileAccessRef: FileAccessRef): Node {
  return Node.create({
    name: 'markdownVideo',
    group: 'block',
    atom: true,
    draggable: true,

    addAttributes() {
      return {
        src: { default: '' },
        poster: { default: '' },
        title: { default: '' },
      }
    },

    parseHTML() {
      return [{
        tag: 'video[src], video[data-type="markdown-video"]',
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false
          const source = node.querySelector('source')
          return {
            src: node.getAttribute('src') || source?.getAttribute('src') || '',
            poster: node.getAttribute('poster') || '',
            title: node.getAttribute('title') || node.getAttribute('alt') || '',
          }
        },
      }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['video', mergeAttributes({ controls: 'true' }, HTMLAttributes)]
    },

    addNodeView() {
      return ReactNodeViewRenderer((props) => MarkdownVideoView(props, fileAccessRef))
    },
  })
}

export const RawHtmlBlock = Node.create({
  name: 'rawHtmlBlock',
  group: 'block',
  atom: true,

  addAttributes() {
    return { html: { default: '' } }
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="raw-html-block"]',
      getAttrs: (node) => node instanceof HTMLElement ? { html: node.dataset.html || '' } : false,
    }]
  },

  renderHTML({ node }) {
    return ['div', { 'data-type': 'raw-html-block', 'data-html': node.attrs.html }]
  },

  addNodeView() {
    return ReactNodeViewRenderer(RawHtmlBlockView)
  },
})

export const RawHtmlInline = Node.create({
  name: 'rawHtmlInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { html: { default: '' } }
  },

  parseHTML() {
    return [{
      tag: 'span[data-type="raw-html-inline"]',
      getAttrs: (node) => node instanceof HTMLElement ? { html: node.dataset.html || '' } : false,
    }]
  },

  renderHTML({ node }) {
    return ['span', { 'data-type': 'raw-html-inline', 'data-html': node.attrs.html }]
  },

  addNodeView() {
    return ReactNodeViewRenderer(RawHtmlInlineView)
  },
})

export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { latex: { default: '' } }
  },

  parseHTML() {
    return [{
      tag: 'span[data-type="math-inline"]',
      getAttrs: (node) => node instanceof HTMLElement ? { latex: node.dataset.latex || '' } : false,
    }]
  },

  renderHTML({ node }) {
    return ['span', { 'data-type': 'math-inline', 'data-latex': node.attrs.latex }]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathInlineView)
  },
})

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,

  addAttributes() {
    return { latex: { default: '' } }
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="math-block"]',
      getAttrs: (node) => node instanceof HTMLElement ? { latex: node.dataset.latex || '' } : false,
    }]
  },

  renderHTML({ node }) {
    return ['div', { 'data-type': 'math-block', 'data-latex': node.attrs.latex }]
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView)
  },
})

export function createShikiCodeBlock(themeRef: ThemeRef): Node {
  return Node.create({
    name: 'codeBlock',
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,

    addAttributes() {
      return {
        language: {
          default: 'text',
          parseHTML: (element) => {
            const className = element.querySelector('code')?.className || element.className || ''
            return className.match(/language-(\S+)/)?.[1] || 'text'
          },
          renderHTML: (attrs) => ({
            class: attrs.language ? `language-${attrs.language}` : undefined,
          }),
        },
      }
    },

    parseHTML() {
      return [{ tag: 'pre', preserveWhitespace: 'full' }]
    },

    renderHTML({ node, HTMLAttributes }) {
      const language = node.attrs.language ? `language-${node.attrs.language}` : undefined
      return ['pre', mergeAttributes(HTMLAttributes), ['code', { class: language }, 0]]
    },

    addNodeView() {
      return ReactNodeViewRenderer((props) => ShikiCodeBlockView(props, themeRef))
    },
  })
}

export const TaskList = Node.create({
  name: 'taskList',
  group: 'block',
  content: 'taskItem+',

  parseHTML() {
    return [{ tag: 'ul[data-type="taskList"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes(HTMLAttributes, { 'data-type': 'taskList', class: 'not-prose my-2 space-y-1 pl-0' }), 0]
  },
})

export const TaskItem = Node.create({
  name: 'taskItem',
  content: 'paragraph block*',
  defining: true,

  addAttributes() {
    return {
      checked: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-checked') === 'true',
        renderHTML: (attrs) => ({ 'data-checked': attrs.checked ? 'true' : 'false' }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'li[data-type="taskItem"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'li',
      mergeAttributes(HTMLAttributes, { 'data-type': 'taskItem', class: 'flex items-start gap-2' }),
      ['label', { contenteditable: 'false', class: 'mt-[0.2em] inline-flex shrink-0 items-center' },
        ['input', { type: 'checkbox', checked: node.attrs.checked ? 'checked' : undefined, disabled: 'disabled' }],
      ],
      ['div', { class: 'min-w-0 flex-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0' }, 0],
    ]
  },
})

export const MarkdownTable = Node.create({
  name: 'markdownTable',
  group: 'block',
  content: 'markdownTableRow+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'table' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['table', mergeAttributes(HTMLAttributes, { class: 'not-prose my-3 w-full border-collapse text-sm' }), ['tbody', 0]]
  },
})

export const MarkdownTableRow = Node.create({
  name: 'markdownTableRow',
  content: '(markdownTableCell | markdownTableHeader)+',

  parseHTML() {
    return [{ tag: 'tr' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['tr', mergeAttributes(HTMLAttributes), 0]
  },
})

export const MarkdownTableCell = Node.create({
  name: 'markdownTableCell',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'td' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['td', mergeAttributes(HTMLAttributes, { class: 'border border-border/50 px-2 py-1 align-top' }), 0]
  },
})

export const MarkdownTableHeader = Node.create({
  name: 'markdownTableHeader',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: 'th' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['th', mergeAttributes(HTMLAttributes, { class: 'border border-border/60 bg-muted/50 px-2 py-1 text-left font-medium align-top' }), 0]
  },
})
