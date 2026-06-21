/**
 * 团队 Atoms — 团队工作区状态管理
 *
 * Phase 1: 仅管理团队工作区列表和品牌配置。
 * Phase 2: 扩展成员管理、邀请、同步状态。
 */

import { atom } from 'jotai'
import type { AgentWorkspace, WorkspaceBrand } from '@proma/shared'

/** 团队工作区列表 */
export const teamWorkspacesAtom = atom<AgentWorkspace[]>([])

/** 当前活跃工作区的品牌配置 */
export const activeBrandAtom = atom<WorkspaceBrand | null>(null)
