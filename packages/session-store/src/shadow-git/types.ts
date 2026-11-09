/**
 * 工作区 Shadow Git 底座的共享契约（Phase 0）。
 *
 * 这一层只描述「工作区状态快照」的稳定形状，不包含 Electron、provider SDK
 * 或回退 UI 的任何概念。实现分文件：
 *
 * - git-command.ts   git 子进程执行（异步，绝不 throw）
 * - roots.ts         rootId + relativePath 的合成命名空间
 * - exclusions.ts    采集排除规则
 * - walk.ts          按根枚举工作区文件（异步、限流、可诊断）
 * - tree-builder.ts  多根子树拼装为 roots/<rootId>/... 的 workspace tree
 * - repository.ts    工作区级仓库编排（队列 + journal + commit + ref）
 * - journal.ts       采集 journal（原子落盘，可重启读取）
 * - queue.ts         工作区级串行写入队列
 */

/** 根目录类型；managed/project 是主根，attached 是附加目录。 */
export type ShadowRootKind = 'managed' | 'project' | 'attached'

/** 一个被 Shadow Git 覆盖的根目录。 */
export interface ShadowRoot {
  /** 稳定身份：主根用 workspace.id，附加根用路径派生 id。 */
  rootId: string
  /** 根的绝对路径。 */
  rootPath: string
  kind: ShadowRootKind
}

/**
 * 采集原因。
 *
 * 只用于诊断与恢复，不进入任何用户可见文案。
 */
export type ShadowCaptureReason =
  | 'initial'
  | 'turn-before'
  | 'turn-after'
  | 'rewind-before'
  /** 回退/逆向 patch 写盘之后的状态边界。 */
  | 'rewind-after'
  | 'startup-reconcile'
  | 'fork-before'

/** 未能纳入基线的路径及原因。 */
export interface ShadowSkipEntry {
  /** `<rootId>/<relativePath>`，便于直接定位。 */
  path: string
  reason: string
}

/** 采集限制；默认值由 walk.ts 提供。 */
export interface ShadowLimits {
  /** 单文件上限（字节）。超限文件进 skipped，不算删除。 */
  maxFileBytes: number
  /** 单根总量上限（字节）。达到后 partial=true。 */
  maxTotalBytes: number
  /** 单根条目上限（文件 + 目录）。达到后 partial=true。 */
  maxEntries: number
}

/** 单根枚举结果。 */
export interface ShadowWalkResult {
  /** 相对根目录的规范路径，统一正斜杠，已排序。 */
  files: string[]
  skipped: ShadowSkipEntry[]
  totalBytes: number
  /**
   * true = 本次枚举不完整（体积/条目上限、不可读目录、超限文件）。
   *
   * 语义是「回退时只恢复、不删除」：不完整的快照里缺失的路径不能被当作删除证据。
   */
  partial: boolean
  /** 根本身是否可读；非 ok 时上层必须拒绝用这棵空树生成快照。 */
  rootStatus: ShadowRootStatus
  /**
   * 每个已纳入文件的 stat 快照，供增量索引判断「能不能复用上次的 sha」。
   *
   * 键与 `files` 一致；没在这里出现的文件不会被复用。
   */
  stats: Record<string, ShadowFileStat>
}

/**
 * 增量索引用的文件身份。
 *
 * 除 size/mtime 外还比较 ctime 与 inode：编辑器的原子替换（写临时文件再 rename）
 * 会换 inode，`touch -r` 把 mtime 改回去也改不掉 ctime，这两项明显降低
 * 「同尺寸、同 mtime 的修改被当成没变」的概率。
 *
 * mode 是低 9 位权限（`stat.mode & 0o777`）：tree 里 100644 / 100755 的差别只能从这里来，
 * 少了它「Agent 删掉 0755 脚本再回退」就只剩内容能恢复，可执行位会丢。
 */
export interface ShadowFileStat {
  size: number
  mtimeMs: number
  ctimeMs: number
  ino: number
  mode: number
}

/** 根本身的状态。missing/not-directory 绝不等于「根里的文件全被删除」。 */
export type ShadowRootStatus = 'ok' | 'missing' | 'not-directory' | 'unreadable'

/** 单根采集结果。 */
export interface ShadowRootCapture {
  rootId: string
  rootPath: string
  kind: ShadowRootKind
  fileCount: number
  treeSha: string
  /** 无法写入对象库的路径（回退时不得当作删除处理）。 */
  failures: string[]
  skipped: ShadowSkipEntry[]
  partial: boolean
  /** 复用上次 sha 的文件数（诊断用；没有增量清单时缺省）。 */
  reused?: number
  /** 本次实际重新哈希的文件数（诊断用）。 */
  hashed?: number
}

/** 一次工作区状态快照的结果。 */
export interface ShadowCaptureResult {
  ok: boolean
  workspaceId: string
  captureId: string
  reason: ShadowCaptureReason
  /** 毫秒时间戳。 */
  startedAt: number
  completedAt: number
  /** 合成 tree（包含 roots/<rootId>/... 前缀）。 */
  treeSha: string
  /** commit 对象 id；失败时为空字符串。 */
  commitId: string
  /**
   * 采集前的边界（上一次成功提交）。
   *
   * 由仓库自己带出来，而不是让调用方在采集**之前**再读一次状态：读和采之间
   * 会插进别人的队列任务，那样拿到的「before」可能已经不是这次的父提交了。
   */
  previousCommitId?: string
  /** 采集前 head 的 tree；tree 未变化时与 treeSha 相同。 */
  previousTreeSha?: string
  roots: ShadowRootCapture[]
  error?: string
}

/** 重启后读回的工作区底座状态。 */
export interface ShadowWorkspaceState {
  workspaceId: string
  repoDir: string
  /** 最近一次成功采集的 commit；没有历史时为 undefined。 */
  headCommitId?: string
  headTreeSha?: string
  lastCapture?: ShadowJournalEntry
}

/** 单根 journal 记录（不含 skipped 明细，避免 journal 无限膨胀）。 */
export interface ShadowJournalRoot {
  rootId: string
  rootPath: string
  kind: ShadowRootKind
  fileCount: number
  treeSha: string
  failures: string[]
  skippedCount: number
  partial: boolean
}

/** 一次采集的 journal 记录。 */
export interface ShadowJournalEntry {
  schemaVersion: 1
  workspaceId: string
  captureId: string
  reason: ShadowCaptureReason
  status: 'pending' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
  commitId?: string
  treeSha?: string
  roots: ShadowJournalRoot[]
  error?: string
}

/** journal 文件形状。 */
export interface ShadowJournalFile {
  schemaVersion: 1
  entries: ShadowJournalEntry[]
}
