import { expect, test } from 'bun:test'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'

test('真实 TipTap 未挂载 view 时读取 DOM 会报错，事件订阅无需访问 view', () => {
  const editor = new Editor({ element: null, extensions: [StarterKit], content: {type:'doc',content:[{type:'paragraph'}]} })
  expect(() => editor.view.dom).toThrow('view is not available')
  let focused = 0
  const listener = () => { focused += 1 }
  expect(() => editor.on('focus', listener)).not.toThrow()
  editor.emit('focus', {} as Parameters<typeof editor.options.onFocus>[0])
  expect(focused).toBe(1)
  editor.off('focus', listener)
  editor.destroy()
})
