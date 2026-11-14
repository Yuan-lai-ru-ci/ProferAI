import { atom } from 'jotai'

/** 顶栏提供插槽，ChatView 通过 Portal 保留各自的会话上下文与抽屉回调。 */
export const chatTopBarHostAtom = atom<{ conversationId: string; element: HTMLElement } | null>(null)
