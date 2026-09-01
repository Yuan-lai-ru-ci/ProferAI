/** 全局 Skill 体系共享类型。 */

export type GlobalSkillType = 'builtin-meta' | 'user-global'
export type SkillScope = 'global' | 'workspace'
export type SkillSourceStatus = 'available' | 'modified-legacy-copy' | 'preserved-legacy-disabled-copy' | 'uncertain-legacy-copy' | 'unknown-legacy'
export type WorkspaceOverrideReason = 'user-disabled' | 'replaced-by-workspace-copy' | 'legacy-meta-copy' | 'modified-legacy-copy' | 'preserved-legacy-disabled-copy' | 'uncertain-legacy-copy' | 'unknown-legacy'

export interface GlobalSkillSource {
  sourceSkillId: string
  sourceSkillType: GlobalSkillType
  sourceVersion: string
  copiedAt: string
}

export interface GlobalSkillManifest {
  schemaVersion: 1
  skillId: string
  slug: string
  type: GlobalSkillType
  version: string
  name: string
  description?: string
  createdAt: string
  updatedAt: string
  source?: GlobalSkillSource
}

export interface WorkspaceSkillSource {
  /** 工作区副本/本地 Skill 的稳定 UUID；绝不从 slug 推导。 */
  workspaceSkillId?: string
  sourceSkillId?: string
  sourceSkillType?: GlobalSkillType
  sourceVersion?: string
  copiedAt?: string
  scope: 'workspace'
  replacementForSkillId?: string
  overrideReason?: WorkspaceOverrideReason
  sourceStatus?: SkillSourceStatus
  /** 仅迁移诊断使用；未知来源不会被猜测为某个全局 Skill。 */
  migrationReason?: string
}

export interface WorkspaceGlobalSkillOverride {
  enabled: boolean
  replacementWorkspaceSkillSlug?: string
  replacementWorkspaceSkillId?: string
  disabledReason?: WorkspaceOverrideReason
  sourceStatus?: 'available'
  updatedAt: string
}

export interface WorkspaceSkillOverridesFile {
  schemaVersion: 1
  globalSkills: Record<string, WorkspaceGlobalSkillOverride>
}

export interface GlobalSkillMeta extends GlobalSkillManifest {
  enabledInWorkspace: boolean
  replacedInWorkspace: boolean
  sourceStatus: SkillSourceStatus
  /** 当前工作区实际加载的来源层 */
  actualSource: 'workspace' | 'global' | 'none'
  /** 展平来源字段，供详情 UI 和 IPC 消费 */
  sourceSkillId?: string
  sourceSkillType?: GlobalSkillType
  sourceVersion?: string
  copiedAt?: string
  replacementForSkillId?: string
  workspaceSkillId?: string
}

export interface WorkspaceGlobalSkillMeta {
  skillId: string
  slug: string
  name: string
  type: GlobalSkillType
  version?: string
  enabledInWorkspace: boolean
  replacedInWorkspace: boolean
  sourceStatus: SkillSourceStatus
}

export interface ResolvedSkillMeta {
  /** 工作区 Skill 时为目录 .source.json 中的稳定 UUID。 */
  workspaceSkillId?: string
  slug: string
  name: string
  version?: string
  path: string
  scope: SkillScope
  sourceSkillId?: string
  sourceSkillType?: GlobalSkillType
  sourceVersion?: string
  copiedAt?: string
  replacementForSkillId?: string
  sourceStatus?: SkillSourceStatus
  actualSource: 'workspace' | 'global' | 'none'
}

export interface SkillResolutionDiagnostic {
  code: 'workspace-slug-conflict' | 'replacement-missing'
  message: string
  slug?: string
  skillId?: string
}

export interface RuntimeSkillsProjection {
  path: string
  skills: ResolvedSkillMeta[]
  diagnostics: SkillResolutionDiagnostic[]
}

export interface WorkspaceSkillCopyResult {
  skill: GlobalSkillMeta
  workspaceSlug: string
  workspaceSkillSlug: string
  workspaceSkillId: string
  override: WorkspaceGlobalSkillOverride
}

export interface GlobalSkillEditRequest {
  skillId: string
  workspaceSlug: string
  scope: 'global' | 'workspace'
  content: string
}

export interface GlobalSkillDeleteRequest {
  skillId: string
  confirmationToken?: string
}

/** 统一全局能力页使用的工作区影响记录；仅 Manager 可判定是否阻塞删除。 */
export interface GlobalSkillWorkspaceReference {
  workspaceSlug: string
  /** 当前阶段目录扫描无法取得索引名称时回退为 slug。 */
  workspaceName: string
  status: 'enabled' | 'disabled' | 'replaced-by-workspace-copy' | 'workspace-only'
  actualSource: 'workspace' | 'global' | 'none'
  reason: 'active-global-skill' | 'disabled-in-workspace' | 'workspace-copy-replacement' | 'workspace-local-skill'
  blocksDeletion: boolean
  workspaceSkillId?: string
}

/** 删除前、确认时与删除提交时均要重新计算，避免 UI 检查被绕过。 */
export interface GlobalSkillDeleteBlockers {
  skillId: string
  skillType: GlobalSkillType
  references: GlobalSkillWorkspaceReference[]
}
