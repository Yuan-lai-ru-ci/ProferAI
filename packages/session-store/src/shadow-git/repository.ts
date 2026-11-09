/**
 * 工作区级 Shadow Git 仓库编排。
 *
 * 一次 capture 把「根目录枚举 → 子树拼装 → commit → ref」串成一次原子写入：
 * 队列保证同一 workspace 只有一个写入者（跨实例共享，避免两个进程同时改同一索引/ref），
 * journal 保证崩溃重启后仍能知道最后一次成功快照在哪里。
 *
 * 生命周期约定：`open` 允许 throw（调用方需要知道底座起不来），
 * 而 `capture` 永远返回结果数据——采集失败不能把用户的对话流程一起带崩。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GitCommandResult, GitRunner } from './git-command'
import { createGitRunner } from './git-command'
import { ShadowJournal } from './journal'
import { ShadowManifest } from './manifest'
import { WorkspaceTaskQueue } from './queue'
import { normalizeShadowRoots } from './roots'
import type {
  ShadowCaptureReason,
  ShadowCaptureResult,
  ShadowJournalEntry,
  ShadowJournalRoot,
  ShadowLimits,
  ShadowRoot,
  ShadowRootCapture,
  ShadowWalkResult,
  ShadowWorkspaceState,
} from './types'
import {
  buildShadowWorkspaceTree,
  commitShadowTree,
  resolveCommitTree,
  isObjectId,
  isSafeShadowRef,
  resolveShadowCommit,
  shadowWorkspaceHeadRef,
  updateShadowRef,
} from './tree-builder'
import type { ShadowTreeRootInput, ShadowTreeRootResult } from './tree-builder'
import { walkShadowRoot } from './walk'

export interface WorkspaceShadowRepositoryOptions {
  workspaceId: string
  repoDir: string
  journalPath: string
  gitPath: string
  tempDir?: string
  /** 增量清单路径；缺省为 `<repoDir>/../manifest.json`。 */
  manifestPath?: string
  limits?: Partial<ShadowLimits>
  /** 返回绝对路径，遍历时跳过；每次采集重新调用。 */
  excludeAbsolutePaths?: () => string[]
  now?: () => number
  captureId?: () => string
}

/**
 * 队列属于「工作区磁盘」而不是「某个实例」：同一 workspace 可能在主窗口、
 * 后台任务、恢复流程里各有一个 repository 对象，它们必须排在同一条队上。
 */
const captureQueue = new WorkspaceTaskQueue()

/** 仓库初始化完成标记；内容只用于诊断，存在性才是判断依据。 */
const SHADOW_REPO_MARKER = 'profer-shadow-repo.json'

const SHADOW_CONFIG: Array<[string, string]> = [
  ['core.autocrlf', 'false'],
  ['core.safecrlf', 'false'],
  ['gc.auto', '0'],
  ['core.longpaths', 'true'],
]

export class WorkspaceShadowRepository {
  readonly workspaceId: string
  readonly repoDir: string
  readonly manifestPath: string

  private readonly runner: GitRunner
  private readonly journal: ShadowJournal
  /** 上次成功采集的 stat+sha；只影响性能，坏了就回退全量哈希。 */
  private readonly manifest: ShadowManifest
  private readonly tempDir: string
  private readonly limits: Partial<ShadowLimits> | undefined
  private readonly excludeAbsolutePaths: (() => string[]) | undefined
  private readonly now: () => number
  private readonly nextCaptureId: () => string

  private constructor(options: WorkspaceShadowRepositoryOptions, runner: GitRunner, journal: ShadowJournal) {
    this.workspaceId = options.workspaceId
    this.repoDir = resolve(options.repoDir)
    this.runner = runner
    this.journal = journal
    // 临时索引放在仓库旁边而不是系统临时目录：同一磁盘、便于整体清理。
    this.tempDir = resolve(options.tempDir ?? join(this.repoDir, '..', 'tmp'))
    this.manifestPath = resolve(options.manifestPath ?? join(this.repoDir, '..', 'manifest.json'))
    this.manifest = ShadowManifest.open(this.manifestPath)
    this.limits = options.limits
    this.excludeAbsolutePaths = options.excludeAbsolutePaths
    this.now = options.now ?? (() => Date.now())
    this.nextCaptureId = options.captureId ?? (() => `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  }

  static async open(options: WorkspaceShadowRepositoryOptions): Promise<WorkspaceShadowRepository> {
    const repoDir = resolve(options.repoDir)
    // workspaceId 会直接进入 ref 路径；在这里就拒掉，避免每个 capture 都返回失败。
    if (!options.workspaceId || !isSafeShadowRef(shadowWorkspaceHeadRef(options.workspaceId))) {
      throw new Error(`工作区标识无法生成安全 ref：${options.workspaceId}`)
    }
    mkdirSync(repoDir, { recursive: true })
    const runner = createGitRunner({ gitPath: options.gitPath })

    // 首次初始化要做 7 次 git 调用（init + rev-parse + 5 次 config），每次采集都做
    // 等于给固定开销白付约 80ms。用一个自述标记文件跳过；同时校验 HEAD 还在，
    // 仓库被外部清理掉时仍然会重新初始化，不会带着假前提继续写。
    const markerPath = join(repoDir, SHADOW_REPO_MARKER)
    const ready = existsSync(markerPath) && existsSync(join(repoDir, 'HEAD'))
    if (!ready) {
      // init 在已有 bare 仓库上是幂等的，因此不需要额外判存在。
      const init = await runner.run(['init', '--bare', '--quiet', repoDir])
      if (!init.ok) throw new Error(`初始化 Shadow Git 仓库失败：${describeGitFailure(init)}`)

      const bare = await runner.run(['rev-parse', '--is-bare-repository'], { gitDir: repoDir })
      if (!bare.ok || bare.stdout.trim() !== 'true') {
        throw new Error(`Shadow Git 仓库不是 bare 仓库：${repoDir}`)
      }

      // 排除规则完全由 walk/exclusions 给出；一个空 excludesFile 才能保证用户的全局
      // gitignore 不会偷偷改变快照语义（否则同一份工作区在不同机器上采出不同 tree）。
      const emptyExcludes = join(repoDir, 'empty-excludes')
      try {
        writeFileSync(emptyExcludes, '', 'utf8')
      } catch (error) {
        throw new Error(`写入 Shadow Git 空排除文件失败：${describeError(error)}`)
      }
      const configs: Array<[string, string]> = [['core.excludesfile', emptyExcludes], ...SHADOW_CONFIG]
      for (const [key, value] of configs) {
        const result = await runner.run(['config', key, value], { gitDir: repoDir })
        if (!result.ok) throw new Error(`配置 Shadow Git（${key}）失败：${describeGitFailure(result)}`)
      }
      try {
        writeFileSync(markerPath, JSON.stringify({ schemaVersion: 1, createdAt: Date.now() }), 'utf8')
      } catch {
        // 标记写不进去只意味着下次多做一遍初始化，不影响正确性。
      }
    }

    const journal = await ShadowJournal.open(options.journalPath, options.workspaceId)
    return new WorkspaceShadowRepository(options, runner, journal)
  }

  capture(input: { reason: ShadowCaptureReason; roots: ShadowRoot[] }): Promise<ShadowCaptureResult> {
    // 串行键用 workspaceId：同一工作区的两次采集在时间上重叠会互相覆盖索引与 head ref。
    // 队列参数误用是唯一的同步抛点，这里兜住以保证 capture 永远返回数据。
    try {
      return captureQueue.run(this.workspaceId, () => this.captureUnlockedSafely(input))
    } catch (error) {
      const startedAt = this.now()
      return Promise.resolve({
        ok: false,
        workspaceId: this.workspaceId,
        captureId: this.nextCaptureId(),
        reason: input.reason,
        startedAt,
        completedAt: startedAt,
        treeSha: '',
        commitId: '',
        roots: [],
        error: `排入采集队列失败：${describeError(error)}`,
      })
    }
  }

  async readState(): Promise<ShadowWorkspaceState> {
    const headRef = shadowWorkspaceHeadRef(this.workspaceId)
    const lastCapture = await this.readLatestCapture()
    let headCommitId = (await resolveShadowCommit(this.runner, this.repoDir, headRef)) ?? undefined
    let headTreeSha: string | undefined

    if (headCommitId) {
      // ref 存在不代表对象完整（例如对象被外部 gc 掉），所以要显式验类型。
      const type = await this.runner.run(['cat-file', '-t', headCommitId], { gitDir: this.repoDir })
      if (type.ok && type.stdout.trim() === 'commit') {
        const tree = await this.runner.run(['rev-parse', `${headCommitId}^{tree}`], { gitDir: this.repoDir })
        if (tree.ok) {
          const sha = tree.stdout.trim()
          if (isObjectId(sha)) headTreeSha = sha
        }
      } else {
        headCommitId = undefined
      }
    }

    // ref 被删/损坏时以 journal 为准：恢复流程依赖「最后一次成功提交」而非 ref 现状。
    if (!headCommitId && lastCapture?.commitId && isObjectId(lastCapture.commitId)) {
      headCommitId = lastCapture.commitId
      headTreeSha = lastCapture.treeSha && isObjectId(lastCapture.treeSha) ? lastCapture.treeSha : undefined
    }

    return {
      workspaceId: this.workspaceId,
      repoDir: this.repoDir,
      ...(headCommitId === undefined ? {} : { headCommitId }),
      ...(headTreeSha === undefined ? {} : { headTreeSha }),
      ...(lastCapture === undefined ? {} : { lastCapture }),
    }
  }

  /**
   * captureExclusive 内部已经逐步兜错，这一层是最后一道保险：
   * 采集可能被调用在 turn 收尾路径上，任何逃出的异常都会变成用户可见的失败。
   */
  private async captureUnlockedSafely(input: {
    reason: ShadowCaptureReason
    roots: ShadowRoot[]
  }): Promise<ShadowCaptureResult> {
    try {
      return await this.captureExclusive(input)
    } catch (error) {
      const startedAt = this.now()
      return failureResult(
        {
          workspaceId: this.workspaceId,
          captureId: this.nextCaptureId(),
          reason: input.reason,
          startedAt,
        },
        [],
        startedAt,
        `采集异常：${describeError(error)}`,
      )
    }
  }

  /**
   * 不排队的采集实现（调用方必须已经持有该工作区的队列位置）。
   *
   * turn 边界入口在队列任务里包住「打开仓库 + 采集」整段，因此这里不能再排一次队——
   * 同一个 key 上嵌套 run 会自锁。
   */
  async captureExclusive(input: {
    reason: ShadowCaptureReason
    roots: ShadowRoot[]
  }): Promise<ShadowCaptureResult> {
    const startedAt = this.now()
    const captureId = this.nextCaptureId()
    const reason = input.reason
    const headRef = shadowWorkspaceHeadRef(this.workspaceId)
    const meta = { workspaceId: this.workspaceId, captureId, reason, startedAt }

    let roots: ShadowRoot[]
    try {
      roots = normalizeShadowRoots(input.roots)
    } catch (error) {
      // 还没有 journal 记录可失败，只能直接把错误交回去。
      return failureResult(meta, [], this.now(), `根目录规范化失败：${describeError(error)}`)
    }
    if (roots.length === 0) {
      return failureResult(meta, [], this.now(), '没有可采集的根目录')
    }
    if (!isSafeShadowRef(headRef)) {
      return failureResult(meta, [], this.now(), `工作区标识无法生成安全 ref：${this.workspaceId}`)
    }

    const fail = async (captures: ShadowRootCapture[], message: string): Promise<ShadowCaptureResult> => {
      const completedAt = this.now()
      try {
        await this.journal.fail(captureId, message, completedAt)
      } catch {
        /* journal 写失败不能盖掉原始错误 */
      }
      return failureResult(meta, captures, completedAt, message)
    }

    try {
      await this.journal.begin({ captureId, reason, startedAt })
    } catch (error) {
      return failureResult(meta, [], this.now(), `写入采集 journal 失败：${describeError(error)}`)
    }

    const treeInputs: ShadowTreeRootInput[] = []
    const walkedByRoot = new Map<string, ShadowWalkResult>()
    try {
      const excludeAbsolutePaths = this.excludeAbsolutePathsResolved()
      for (const root of roots) {
        const walked = await walkShadowRoot({
          root,
          ...(excludeAbsolutePaths.length === 0 ? {} : { excludeAbsolutePaths }),
          ...(this.limits === undefined ? {} : { limits: this.limits }),
        })
        const previous = this.manifest.root(root.rootId)?.files
        treeInputs.push({
          rootId: root.rootId,
          rootPath: root.rootPath,
          files: walked.files,
          stats: walked.stats,
          ...(previous === undefined ? {} : { previous }),
        })
        walkedByRoot.set(root.rootId, walked)
      }
    } catch (error) {
      return fail([], `枚举工作区文件失败：${describeError(error)}`)
    }

    // 根本身不可见（未挂载、被删除、权限不足）时绝不能生成一棵空树：
    // 空树在后续 diff 里等价于「这个根的文件全被删除了」，会把不可见误记成删除。
    // 宁可让本次采集失败、在 journal 里留下记录，等下一次边界重试。
    const unavailable = roots.filter((root) => (walkedByRoot.get(root.rootId)?.rootStatus ?? 'ok') !== 'ok')
    if (unavailable.length > 0) {
      const detail = unavailable
        .map((root) => `${root.rootPath}(${walkedByRoot.get(root.rootId)?.rootStatus ?? 'unknown'})`)
        .join('、')
      return fail(
        toRootCaptures(roots, treeInputs, [], walkedByRoot),
        `根目录不可用，拒绝生成可能误导的快照：${detail}`,
      )
    }

    const build = await buildShadowWorkspaceTree(this.runner, {
      repoDir: this.repoDir,
      tempDir: this.tempDir,
      roots: treeInputs,
    })
    if (!build.ok) {
      const partialCaptures = toRootCaptures(roots, treeInputs, build.perRoot, walkedByRoot)
      return fail(partialCaptures, build.error ?? '构建工作区 tree 失败')
    }

    const captures = toRootCaptures(roots, treeInputs, build.perRoot, walkedByRoot)

    // 父链只用来保留历史可达性；父提交解析失败不应阻塞新快照。
    const parentCommitId = (await resolveShadowCommit(this.runner, this.repoDir, headRef)) ?? undefined

    // 绝大多数 Agent turn 不写文件。tree 与当前 head 完全一致时不再造一个内容相同的提交：
    // 历史里堆满空 diff 只会让后续按 turn 定位边界更难，也让对象库无谓增长。
    const currentTree = parentCommitId ? await resolveCommitTree(this.runner, this.repoDir, parentCommitId) : null
    const unchanged = currentTree !== null && currentTree === build.treeSha
    let commitId = parentCommitId ?? ''
    if (!unchanged) {
      const commit = await commitShadowTree(this.runner, {
        repoDir: this.repoDir,
        treeSha: build.treeSha,
        message: `profer-shadow: ${reason} ${captureId}`,
        ...(parentCommitId === undefined ? {} : { parentCommitId }),
      })
      if (!commit.ok) {
        return fail(captures, '写入 commit 对象失败')
      }
      const updated = await updateShadowRef(this.runner, this.repoDir, headRef, commit.commitId)
      if (!updated) {
        return fail(captures, '更新工作区 head ref 失败')
      }
      commitId = commit.commitId
    }

    // 清单落盘必须在「commit + ref 更新都成功之后」：清单描述的是已经提交的 tree，
    // 提前写入会让一次失败的采集毒化下一次的复用判断。
    //
    // tree 与 head 相同时也必须写：父提交本身就代表当前树，写清单是安全的；
    // 而旧清单可能缺少 mode 之类的字段，不写回去就会出现「每轮都判定不能复用 →
    // 全量重新哈希 → tree 又没变 → 清单永远补不上」的死循环。
    // 这里不能为了写清单去造空提交：commit 行为完全不变。
    // save() 内部已吞掉异常，清单写失败不影响本次采集结论。
    const nextRoots: Record<string, { rootPath: string; files: typeof build.perRoot[number]['manifest'] }> = {}
    for (const entry of build.perRoot) {
      const root = roots.find((item) => item.rootId === entry.rootId)
      if (!root) continue
      nextRoots[entry.rootId] = { rootPath: root.rootPath, files: entry.manifest }
    }
    this.manifest.replaceRoots(nextRoots)
    this.manifest.save()

    const completedAt = this.now()
    const journalRoots: ShadowJournalRoot[] = captures.map((capture) => ({
      rootId: capture.rootId,
      rootPath: capture.rootPath,
      kind: capture.kind,
      fileCount: capture.fileCount,
      treeSha: capture.treeSha,
      failures: capture.failures,
      skippedCount: capture.skipped.length,
      partial: capture.partial,
    }))
    try {
      await this.journal.complete(captureId, {
        completedAt,
        commitId,
        treeSha: build.treeSha,
        roots: journalRoots,
      })
    } catch (error) {
      // commit 已经落库、ref 已经更新：状态是可信的，journal 缺一条只影响诊断。
      return {
        ok: true,
        ...meta,
        completedAt,
        treeSha: build.treeSha,
        commitId,
        roots: captures,
        ...(parentCommitId ? { previousCommitId: parentCommitId } : {}),
        ...(currentTree ? { previousTreeSha: currentTree } : {}),
        error: `采集已完成但 journal 写入失败：${describeError(error)}`,
      }
    }

    return {
      ok: true,
      ...meta,
      completedAt,
      treeSha: build.treeSha,
      commitId,
      roots: captures,
      ...(parentCommitId ? { previousCommitId: parentCommitId } : {}),
      ...(currentTree ? { previousTreeSha: currentTree } : {}),
    }
  }

  /** 排除路径每次采集重新取：挂载点/临时目录可能在会话中途变化。 */
  private excludeAbsolutePathsResolved(): string[] {
    if (!this.excludeAbsolutePaths) return []
    try {
      return this.excludeAbsolutePaths()
    } catch {
      // 排除规则是性能优化，取不到就退化为不排除，不能因此中断采集。
      return []
    }
  }

  private async readLatestCapture(): Promise<ShadowJournalEntry | undefined> {
    try {
      return (await this.journal.latestCompleted()) ?? undefined
    } catch {
      return undefined
    }
  }
}

interface CaptureMeta {
  workspaceId: string
  captureId: string
  reason: ShadowCaptureReason
  startedAt: number
}

function failureResult(
  meta: CaptureMeta,
  roots: ShadowRootCapture[],
  completedAt: number,
  error: string,
): ShadowCaptureResult {
  return {
    ok: false,
    ...meta,
    completedAt,
    treeSha: '',
    commitId: '',
    roots,
    error,
  }
}

/**
 * 在该工作区的队列里登记一个任务。
 *
 * 登记是同步的：调用返回时 `pendingWorkspaceShadowCaptures` 已经 +1，
 * 下一轮 turn 才能可靠地判断「上一轮采集还没落盘，需要等」。
 */
export function runWorkspaceShadowTask<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
  return captureQueue.run(workspaceId, task)
}

/** 该工作区当前排队/执行中的采集数量；0 表示可以零等待直接开新一轮。 */
export function pendingWorkspaceShadowCaptures(workspaceId: string): number {
  return captureQueue.pending(workspaceId)
}

/**
 * 等待某个工作区当前排队/执行中的采集全部结束。
 *
 * 交给 turn 边界用：上一轮的 turn-after 还在后台跑时，本轮开始写文件前必须先等它落盘，
 * 否则两轮写入会被并进同一份快照。链尾永不 reject，所以这里不会抛。
 */
export async function waitForWorkspaceShadowIdle(workspaceId: string): Promise<void> {
  await captureQueue.drainKey(workspaceId)
}

/**
 * 把 tree 层结果与 walk 结果合并成对外形状。
 *
 * tree 层只返回「哪些路径进了对象库」，文件数/skipped/partial 仍来自 walk，
 * 两者按 rootId 对齐——rootId 在 normalize 后保证唯一。
 */
function toRootCaptures(
  roots: ShadowRoot[],
  inputs: ShadowTreeRootInput[],
  perRoot: ShadowTreeRootResult[],
  walkedByRoot: Map<string, ShadowWalkResult>,
): ShadowRootCapture[] {
  const byRootId = new Map(perRoot.map((entry) => [entry.rootId, entry]))
  return roots.map((root) => {
    const input = inputs.find((entry) => entry.rootId === root.rootId)
    const built = byRootId.get(root.rootId)
    const walked = walkedByRoot.get(root.rootId)
    return {
      rootId: root.rootId,
      rootPath: root.rootPath,
      kind: root.kind,
      fileCount: walked?.files.length ?? input?.files.length ?? 0,
      treeSha: built?.treeSha ?? '',
      failures: built?.failures ?? [],
      ...(built === undefined ? {} : { reused: built.reused, hashed: built.hashed }),
      skipped: walked?.skipped ?? [],
      // 写不进对象库的文件同样从 tree 里缺位：必须拉高 partial，
      // 否则后续会把「没采到」当成「用户删了」。
      partial: (walked?.partial ?? false) || (built?.failures.length ?? 0) > 0,
    }
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeGitFailure(result: GitCommandResult): string {
  const detail = result.stderr.trim()
  return detail.length > 0 ? detail : `exit code ${result.code ?? 'null'}`
}
