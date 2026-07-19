import { atom } from 'jotai'
import type { KnowledgeReference } from '@profer/shared'

/** Agent 主区域资料预览：由 MainArea 统一承载，避免与文件预览分屏竞争。 */
export const agentKnowledgePreviewMapAtom = atom<Map<string, KnowledgeReference>>(new Map())
