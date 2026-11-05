/**
 * GoalCommandSuggestion — 输入框 `/goal` 的发现性提示
 *
 * 背景：`/goal` 是 Agent 内置命令，不是 Skill 引用。原先它在 `/` 触发时被显式跳过，
 * 用户只能靠教程或记忆知道它存在（对比 Claude Code / Codex 的 `/goal` 都有补全与状态查询）。
 *
 * 这里只做「语法提示」：不替换正文、不执行命令，选中后把模板写进输入框由用户继续编辑。
 * 触发条件严格限定为 `/goal` 或 `/goal <已输入子命令前缀>`，不会和 Skill 补全抢占。
 */

import type { Editor } from '@tiptap/react'
import type { SuggestionOptions } from '@tiptap/suggestion'
import { ReactRenderer } from '@tiptap/react'
import { Target } from 'lucide-react'
import { MentionList } from './MentionList'
import type { MentionListRef } from './MentionList'
import { createMentionPopup, positionPopup, isSuggestionTriggerPresent } from './mention-popup-utils'

export interface GoalCommandItem {
  /** 选中后写入输入框的完整文本 */
  insert: string
  /** 列表主标签 */
  label: string
  /** 列表右侧说明 */
  description: string
}

/** 可提示的 Goal 命令模板；子命令与 `parseGoalCommand` 支持的集合一致。 */
export const GOAL_COMMAND_ITEMS: readonly GoalCommandItem[] = [
  { insert: '/goal ', label: '/goal <目标>', description: '启动持续目标，可多行写验收标准' },
  { insert: '/goal status', label: '/goal status', description: '查看当前目标、轮次与最近结果' },
  { insert: '/goal pause', label: '/goal pause', description: '暂停执行，之后可手动恢复' },
  { insert: '/goal resume', label: '/goal resume', description: '恢复已暂停或受阻的目标' },
  { insert: '/goal stop', label: '/goal stop', description: '停止目标（与暂停不同，不会自动续跑）' },
  { insert: '/goal clear', label: '/goal clear', description: '清除状态并归档历史' },
]

/** `/goal` 之后允许继续提示的子命令前缀（含空）。 */
const SUBCOMMAND_PREFIX = /^\/goal\s+([a-z]*)$/i

/**
 * 从触发符到光标的文本判断是否处于 Goal 命令提示范围。
 * 返回 null 表示不提示（交给 Skill 补全或普通输入）。
 */
export function matchGoalCommandQuery(textBeforeCursor: string): { query: string } | null {
  const text = textBeforeCursor.trimStart()
  if (/^\/goal$/i.test(text)) return { query: '' }
  const match = text.match(SUBCOMMAND_PREFIX)
  return match ? { query: (match[1] ?? '').toLowerCase() } : null
}

/** 按子命令前缀过滤；空查询展示全部模板。 */
export function filterGoalCommandItems(query: string): GoalCommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...GOAL_COMMAND_ITEMS]
  return GOAL_COMMAND_ITEMS.filter((item) => {
    const sub = item.insert.replace(/^\/goal\s*/i, '').toLowerCase()
    return sub.startsWith(q) || item.label.toLowerCase().includes(q) || item.description.includes(q)
  })
}

/**
 * 选中模板后把 `/` 到光标的范围替换为模板。
 * 启动模板保留用户已经写下的目标前缀（如 `/goal 完成登录页` 选「/goal <目标>」不会被清空）。
 */
export function replaceGoalCommandRange(editor: Editor, range: { from: number; to: number }, insert: string): void {
  const { from, to } = range
  const typed = editor.state.doc.textBetween(from, to, '\n', '\n').replace(/^\/goal\s*/i, '')
  const chain = editor.chain().focus().deleteRange({ from, to })
  chain.insertContent(insert.endsWith(' ') ? `${insert}${typed}` : insert).run()
}

export function createGoalCommandSuggestion(
  mentionActiveRef: React.MutableRefObject<boolean>,
  mentionItemCountRef: React.MutableRefObject<number>,
): Omit<SuggestionOptions<GoalCommandItem>, 'editor'> {
  return {
    char: '/',
    allowSpaces: false,
    allowedPrefixes: null,
    items: ({ query }) => filterGoalCommandItems(query ?? ''),
    render: () => {
      let renderer: ReactRenderer<MentionListRef> | null = null
      let popup: HTMLDivElement | null = null
      let blurHandler: (() => void) | null = null
      let editorDom: HTMLElement | null = null

      function cleanup() {
        if (blurHandler && editorDom) {
          editorDom.removeEventListener('blur', blurHandler, true)
          blurHandler = null
        }
        editorDom = null
        mentionActiveRef.current = false
        mentionItemCountRef.current = 0
        popup?.remove()
        popup = null
        renderer?.destroy()
        renderer = null
      }

      return {
        onStart(props) {
          if (popup || renderer) cleanup()
          // 异步竞态防御：await 期间触发符可能已被删除。
          if (!isSuggestionTriggerPresent(props.editor, props.range, '/')) return
          // 只接管 `/goal`；其他 `/xxx` 交给 Skill 补全，避免两个弹窗同时出现。
          const textBeforeTrigger = props.editor.state.doc.textBetween(0, props.range.to, '', '')
          if (!matchGoalCommandQuery(textBeforeTrigger)) return
          if (props.items.length === 0) return

          mentionActiveRef.current = true
          mentionItemCountRef.current = props.items.length
          editorDom = props.editor.view.dom
          renderer = new ReactRenderer(MentionList, {
            props: {
              items: props.items,
              emptyText: '无匹配 Goal 命令',
              headerLabel: 'Goal 命令',
              keyExtractor: (item: GoalCommandItem) => item.insert,
              renderItem: (item: GoalCommandItem) => (
                <>
                  <Target className="size-3.5 text-primary flex-shrink-0" />
                  <span className="truncate font-medium flex-1 min-w-0">{item.label}</span>
                  <span className="truncate text-[10px] text-muted-foreground/50 max-w-[140px]">{item.description}</span>
                </>
              ),
              onSelect: (item: GoalCommandItem) => {
                const { from, to } = props.range
                replaceGoalCommandRange(props.editor, { from, to }, item.insert)
                cleanup()
              },
            },
            editor: props.editor,
          })
          popup = createMentionPopup(renderer.element, '/goal')
          positionPopup(popup, props.clientRect?.())
          blurHandler = () => {
            // 与 Skill 补全一致：点击列表项会先触发 blur，延迟到确认焦点真的离开再清理。
            setTimeout(() => {
              if (!props.editor.view.hasFocus() && popup) cleanup()
            }, 100)
          }
          editorDom.addEventListener('blur', blurHandler, true)
        },
        onUpdate(props) {
          renderer?.updateProps({ items: props.items })
          mentionItemCountRef.current = props.items.length
          positionPopup(popup, props.clientRect?.())
        },
        onKeyDown(props) {
          return renderer?.ref?.onKeyDown({ event: props.event }) ?? false
        },
        onExit() {
          cleanup()
        },
      }
    },
  }
}
