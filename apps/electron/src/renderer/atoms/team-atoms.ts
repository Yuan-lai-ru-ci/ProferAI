/**
 * 团队 Atoms — 团队工作区状态管理
 *
 * Phase 1: 管理团队工作区列表。
 * Phase 2: 扩展成员管理、邀请、同步状态。
 */

import { atom } from 'jotai'
import type { AgentWorkspace } from '@profer/shared'

/** 团队工作区列表 */
export const teamWorkspacesAtom = atom<AgentWorkspace[]>([])
