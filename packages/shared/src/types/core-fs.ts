/**
 * Core 文件系统浏览类型（跨 Core 选择项目目录与侧栏文件浏览共用）。
 *
 * 路径一律由所属 Core 返回绝对路径，桌面端不得自行拼接：
 * Windows 反斜杠、盘符和 POSIX 根目录的差异都由 Core 侧解释。
 */

export interface CoreFsEntry {
  name: string
  path: string
  isDirectory: boolean
  /** 目录不填；文件为字节数（Core 只对授权根内的文件返回）。 */
  size?: number
}

export interface CoreFsRootOption {
  label: string
  path: string
}

/** Core 的浏览起点：平台、用户主目录与可快速跳转的根。 */
export interface CoreFsOverview {
  platform: string
  home: string
  roots: CoreFsRootOption[]
}

export interface CoreDirectoryListing {
  path: string
  /** 已到根目录时为 null。 */
  parent: string | null
  entries: CoreFsEntry[]
}

/** 会话可浏览的文件根，与桌面本机文件面板的授权范围对齐。 */
export interface CoreSessionFileRoots {
  project: boolean
  workspaceRoot: string
  sessionStorage: string
  workbench: string
  workspaceFiles: string
  attachedDirectories: string[]
  attachedFiles: string[]
}

/** 目录探测：绑定前判断“不存在 / 不是目录 / 非空”，不读取文件内容。 */
export interface CoreDirectoryProbe {
  path: string
  exists: boolean
  isDirectory: boolean
  empty: boolean
  entryCount: number
  /** 目录里已有 .profer：说明它很可能已经是一个 Profer 项目。 */
  hasProfer: boolean
}

/** 新建项目前的规划结果：父目录缺失段 + 目标文件夹状态，一次请求算清，避免多次往返和前端拼路径。 */
export interface CoreProjectPlan {
  basePath: string
  targetPath: string
  baseExists: boolean
  baseIsDirectory: boolean
  /** 从最近存在的上级到 basePath 之间缺失的目录名（顺序由外到内）。 */
  baseMissingSegments: string[]
  target: CoreDirectoryProbe
}

/** 文件管理操作（系统文件与会话文件共用）。 */
export type CoreFsOpKind = 'rename' | 'move' | 'copy' | 'trash' | 'preview'

export interface CoreFsOpInput {
  op: CoreFsOpKind
  /** 源路径（preview 时为要预览的文件）。 */
  path: string
  /** rename 的新名称（单段）。 */
  name?: string
  /** move/copy 的目标目录。 */
  toDir?: string
  overwrite?: boolean
}

export interface CoreSessionFsOpInput extends CoreFsOpInput {
  sessionId: string
}

export interface CoreFilePreview {
  path: string
  base64: string
  mime: string
  size: number
}
