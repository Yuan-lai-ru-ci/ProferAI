/**
 * EmojiAvatarPicker — 头像表情选择器
 *
 * 单独成文件是为了懒加载：`@emoji-mart/react` 加上 `@emoji-mart/data` 的原生表情集 JSON
 * 合计约 600kB，只有用户真的点开头像选择器时才需要，不该压进设置面板的 chunk 里。
 */

import * as React from 'react'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'

interface EmojiMartEmoji {
  id: string
  name: string
  native: string
  unified: string
  keywords: string[]
  shortcodes: string
}

/** 宿主只关心 native 字符（如 "😀"），其余字段原样透传。 */
export interface EmojiAvatarSelection {
  native: string
}

interface EmojiAvatarPickerProps {
  /** 选中表情后的回调，契约与 `@emoji-mart/react` 的 onEmojiSelect 保持一致 */
  onEmojiSelect: (emoji: EmojiAvatarSelection) => void
}

export function EmojiAvatarPicker({ onEmojiSelect }: EmojiAvatarPickerProps): React.ReactElement {
  return (
    <Picker
      data={data}
      onEmojiSelect={(emoji: EmojiMartEmoji) => onEmojiSelect(emoji)}
      locale="zh"
      theme="auto"
      previewPosition="none"
      skinTonePosition="search"
      perLine={8}
    />
  )
}
