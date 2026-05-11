import * as React from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import { cn } from '@/lib/utils'
import { htmlToMarkdown, markdownToHtml } from '@/lib/markdown-rich-text'

interface MarkdownRichEditorProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
  disabled?: boolean
}

export function MarkdownRichEditor({
  value,
  onChange,
  onSave,
  onCancel,
  disabled,
}: MarkdownRichEditorProps): React.ReactElement {
  const onChangeRef = React.useRef(onChange)
  const onSaveRef = React.useRef(onSave)
  const onCancelRef = React.useRef(onCancel)
  const localMarkdownRef = React.useRef(value)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onCancelRef.current = onCancel

  const initialHtml = React.useMemo(() => markdownToHtml(value), [value])
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: false,
        underline: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          class: 'text-primary underline',
        },
      }),
    ],
    content: initialHtml,
    editable: !disabled,
    editorProps: {
      attributes: {
        class: cn(
          'prose prose-sm dark:prose-invert max-w-none min-h-full focus:outline-none',
          'px-4 py-3 text-[13px] leading-relaxed',
          '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          '[&_pre]:rounded-md [&_pre]:p-3',
          '[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]',
          '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        ),
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onCancelRef.current()
          return true
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          onSaveRef.current()
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor: ed }) => {
      const markdown = htmlToMarkdown(ed.getHTML())
      localMarkdownRef.current = markdown
      onChangeRef.current(markdown)
    },
  })

  React.useEffect(() => {
    editor?.setEditable(!disabled)
  }, [disabled, editor])

  React.useEffect(() => {
    if (!editor) return
    if (value === localMarkdownRef.current) return
    const html = markdownToHtml(value)
    localMarkdownRef.current = value
    editor.commands.setContent(html, { emitUpdate: false })
  }, [editor, value])

  React.useEffect(() => {
    if (!editor || disabled) return
    const timer = setTimeout(() => editor.commands.focus('end'), 50)
    return () => clearTimeout(timer)
  }, [disabled, editor])

  return <EditorContent editor={editor} className="h-full overflow-auto" />
}
