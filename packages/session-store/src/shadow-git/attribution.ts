/**
 * Agent turn 变更归属（Phase 2）。
 *
 * 职责边界很清楚：
 * - **事实**来自 Shadow Git：两个 tree 之间的差异，是「这个 turn 期间工作区真的变了什么」；
 * - **证据**来自 runtime：受控写入工具（write/edit）在事件流里报出的路径与顺序；
 * - 归属就是这两者的交叉：有证据命中的路径是 `confirmed`，只有树差异的是 `unconfirmed`。
 *
 * 为什么必须这么分：Bash、未知 MCP、外部进程、用户手改都会让工作区变化，但它们
 * 不会给出「这是我做的」声明。把树差异一律当成 Agent 改动，回退时就会抹掉用户自己的编辑；
 * 反过来只信证据，又会漏掉 Bash 生成的文件。所以两个都记，并在同一个记录里标明哪些可确认。
 *
 * 这一层不读 Electron、不读 provider SDK：路径一律以绝对路径传入，由宿主负责从
 * rootId/relativePath 换算。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { GitRunner } from './git-command'
import { parseShadowTreePath, shadowTreePath } from './roots'
import type { ShadowRoot } from './types'

/** 记录里保存的根快照；kind 缺了就无法还原「这是用户项目还是附加目录」。 */
export type ShadowRootSnapshot = Pick<ShadowRoot, 'rootId' | 'rootPath' | 'kind'>

/** 一个 turn 内受控写入证据的顺序与来源。 */
export interface ShadowTurnEvidenceItem {
  /** 同一 turn 内单调递增，来自事件流到达顺序。 */
  seq: number
  toolUseId?: string
  toolName?: string
  /** 写出的绝对路径（宿主给什么记什么，判归属时才做规范化）。 */
  path: string
  /**
   * 证据强度来源：
   * - write/edit：受控写入工具，Profer 自己调出来的，最可信；
   * - bash：Bash 里被识别出的写入，只能算旁证；
   * - unknown：工具名匹配但无法确定语义。
   */
  source: 'write' | 'edit' | 'bash' | 'unknown'
  /**
   * 写入前后内容的对象引用（内容对象库里的 id）。
   *
   * 只记 id、不复制内容：同一个文件已经在 rewind 对象库里存过一份，
   * 再往归属记录里塞一份会让存储翻倍，并且两份内容的生命周期还不同步。
   */
  beforeRef?: string
  afterRef?: string
}

/** 单个路径在本 turn 的归属结论。 */
export interface ShadowTurnChange {
  rootId: string
  /** 相对根目录的路径（正斜杠）。 */
  path: string
  /** 绝对路径；根目录在当前工作区配置里找不到时为空字符串。 */
  absolutePath: string
  status: 'added' | 'modified' | 'deleted'
  /** confirmed = 有受控写入证据命中；unconfirmed = 只有树差异。 */
  attribution: 'confirmed' | 'unconfirmed'
  /** 命中的证据序号，按发生顺序。 */
  evidenceSeq: number[]
  /** 命中证据里最强的一档，便于 UI/诊断区分「工具写的」和「Bash 写的」。 */
  evidenceSource?: ShadowTurnEvidenceItem['source']
  /**
   * 树差异说是「新增」，但证据显示写入前这个路径已经有内容。
   *
   * 出现在「用户在两轮之间新建了文件，Agent 本轮又改了它」：上一轮 turn-after 还是
   * 本轮 before，树的差异会把用户建的文件也当成 Agent 新建。撤「新建」等于删文件，
   * 所以这种变化一律不删，只保留。
   */
  preexisting?: boolean
  /** 命中证据带出的内容引用（去重、按出现顺序）；Phase 3 生成逆向 patch 时用。 */
  beforeRefs?: string[]
  afterRefs?: string[]
  /**
   * 这个路径所在的根是本 turn 才纳入采集的。
   *
   * 语义是「文件出现在差异里，是因为我们刚开始看这个目录」，不是 Agent 新建的。
   * 回退时绝不能据此删除整棵树。
   */
  rootIntroduced?: boolean
}

/** 有证据但没有落成树差异的写入（写入后改回、写入失败、写到了采集排除路径）。 */
export interface ShadowTurnUnchangedEvidence {
  path: string
  absolutePath: string
  seq: number
  toolName?: string
  /** 为什么没落成变化；只有诊断价值。 */
  reason: 'no-net-change' | 'outside-roots' | 'excluded'
}

/** 一个 turn 的归属记录。 */
export interface ShadowTurnAttributionRecord {
  schemaVersion: 1
  workspaceId: string
  sessionId: string
  /** turn 身份 = 触发该 turn 的用户消息 uuid；与 JSONL 消息一一对应。 */
  turnId: string
  /**
   * turnId 的可信度。
   *
   * user-message：宿主确实拿到了用户消息 uuid，能和 JSONL 对得上；
   * capture：只有采集 id 兜底（IM/Pocket 等未透传 uuid 的入口），能定位但不能按消息 join。
   * 分开记的原因：回退要按 turn 截断对话，来源不可信时不能假装边界是精确的。
   */
  turnIdSource?: 'user-message' | 'capture'
  runtime: string
  startedAt: number
  endedAt: number
  /** 之前的边界；工作区第一次采集时可能没有。 */
  beforeCommitId?: string
  afterCommitId?: string
  beforeTreeSha?: string
  afterTreeSha?: string
  changes: ShadowTurnChange[]
  unchangedEvidence: ShadowTurnUnchangedEvidence[]
  /**
   * 边界来源。
   *
   * 目前只有 shadow-git 一种：旧的 Pi 整树 checkpoint（`pi-file-checkpoint`）
   * **不会**被换算成归属记录——它只证明「某一刻的整棵树」，不证明「哪次 turn 改了哪个文件」。
   * 显式写出来，是为了让下游在迁移期能区分「有归属」和「只有旧检查点」，
   * 而不是靠「记录里没有 changes」去猜。
   */
  boundarySource: 'shadow-git'
  /**
   * 这个 turn 的根集合快照。
   *
   * 会话级附加目录随会话变化，路径归属必须在记录里还原：
   * 只存 rootId 而不存 rootPath，回退时无法把 `roots/<rootId>/a.ts` 还原成真实文件。
   */
  roots: ShadowRootSnapshot[]
  /**
   * 与上一个边界相比的根集合变化。
   *
   * removed 里的根本次不再采集，它的文件会从 tree 里整体消失；那是「我们不再看它」，
   * 不是「Agent 删了它」，因此这些条目不会进入 changes。
   */
  rootSetChanges?: { added: string[]; removed: string[] }
  /** 本会话是从哪个会话分叉出来的（仅分叉后的第一条 turn 记录携带）。 */
  forkOf?: { sourceSessionId: string; commitId?: string; upToMessageUuid?: string }
  /**
   * 采集不完整（不可读目录、超限文件）。
   *
   * 语义：changes 只代表「观察到的变化」，deleted 不能当成删除证据。
   */
  partial: boolean
  /** 没有可用 diff 时的说明；有它时 changes/unchangedEvidence 一定为空。 */
  note?: string
}

/** 树差异的原始条目（还没判归属）。 */
export interface ShadowTreeDiffEntry {
  rootId: string
  path: string
  status: ShadowTurnChange['status']
}

/**
 * 规范化路径用于比较。
 *
 * macOS 上 `/var` 与 `/private/var` 是同一位置但字面不同，证据里两种写法都可能出现，
 * 只做 resolve 会把它们判成不同路径，进而把 Agent 写入误标成 unconfirmed。
 */
function comparablePath(value: string): string[] {
  const resolved = resolve(value)
  const variants = [resolved]
  if (resolved.startsWith('/private/')) variants.push(resolved.slice('/private'.length))
  else variants.push(`/private${resolved}`)
  return variants
}

function samePath(left: string, right: string): boolean {
  if (!left || !right) return false
  if (left === right) return true
  const a = comparablePath(left)
  const b = comparablePath(right)
  return a.some((candidate) => b.includes(candidate))
}

/** child 是否在 parent 目录内（含 /private 变体，判定规则与 samePath 一致）。 */
function isPathInside(child: string, parent: string): boolean {
  if (!child || !parent) return false
  const parents = comparablePath(parent)
  return comparablePath(child).some((candidate) =>
    parents.some((root) => candidate === root || candidate.startsWith(`${root}/`)),
  )
}

/**
 * 解析 `git diff-tree -r -z --no-renames` 的输出。
 *
 * `-z` 下每条形如 `:<mode> <mode> <sha> <sha> <status>\0<path>\0`；path 用 NUL 分隔，
 * 这样带空格、引号、换行的文件名不需要任何转义处理。
 */
export function parseShadowDiffTreeOutput(stdout: string): ShadowTreeDiffEntry[] {
  const fields = stdout.split('\0')
  const entries: ShadowTreeDiffEntry[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const header = fields[index]
    if (!header || !header.startsWith(':')) continue
    const path = fields[index + 1]
    if (!path) continue
    index += 1
    const statusCode = header.slice(header.lastIndexOf(' ')).trim()
    const status = statusCode.startsWith('A')
      ? 'added'
      : statusCode.startsWith('D')
        ? 'deleted'
        : statusCode.startsWith('M') || statusCode.startsWith('T')
          ? 'modified'
          : null
    // 不认识的状态（重命名/复制/冲突）宁可跳过：Phase 2 不猜语义，Phase 3 再按 patch 处理。
    if (!status) continue
    const parsed = parseShadowTreePath(path)
    if (!parsed || !parsed.relativePath) continue
    entries.push({ rootId: parsed.rootId, path: parsed.relativePath, status })
  }
  return entries
}

/**
 * 计算两个 commit 之间的树差异。
 *
 * `before` 缺省表示工作区第一次采集：用 `--root` 让根提交也能列出全部文件，
 * 而不是输出空列表（那会把「刚导入的基线」记成「这个 turn 什么都没改」）。
 */
export async function diffShadowCommits(
  runner: GitRunner,
  repoDir: string,
  beforeCommitId: string | undefined,
  afterCommitId: string,
): Promise<{ ok: true; entries: ShadowTreeDiffEntry[] } | { ok: false; error: string }> {
  if (!afterCommitId) return { ok: false, error: '缺少结束边界' }
  if (beforeCommitId && beforeCommitId === afterCommitId) return { ok: true, entries: [] }
  const args = beforeCommitId
    ? ['diff-tree', '-r', '-z', '--no-renames', beforeCommitId, afterCommitId]
    : ['diff-tree', '-r', '-z', '--no-renames', '--root', afterCommitId]
  const result = await runner.run(args, { gitDir: repoDir })
  if (!result.ok) return { ok: false, error: result.stderr.trim() || 'git diff-tree 失败' }
  return { ok: true, entries: parseShadowDiffTreeOutput(result.stdout) }
}

export interface BuildShadowTurnAttributionInput {
  workspaceId: string
  sessionId: string
  turnId: string
  turnIdSource?: 'user-message' | 'capture'
  runtime: string
  startedAt: number
  endedAt: number
  beforeCommitId?: string
  afterCommitId?: string
  beforeTreeSha?: string
  afterTreeSha?: string
  diff: ShadowTreeDiffEntry[] | null
  evidence: ShadowTurnEvidenceItem[]
  /** 本次采集的根快照（含会话级附加目录）。 */
  roots: ShadowRootSnapshot[]
  /** 上一个边界的根 id 集合；缺省表示未知（首个 turn），此时不做根集合增删判定。 */
  previousRootIds?: string[]
  partial: boolean
  note?: string
  forkOf?: ShadowTurnAttributionRecord['forkOf']
}

/**
 * 把树差异和证据合成一条归属记录。
 *
 * 顺序语义：证据的 seq 保留事件流顺序，`evidenceSeq` 记录命中的全部序号。
 * 同一路径被多次写入时不去重、不折叠成「最后一次」——Phase 3 生成逆向 patch
 * 需要知道这个 turn 里到底发生了几次写。
 */
export function buildShadowTurnAttribution(
  input: BuildShadowTurnAttributionInput,
): ShadowTurnAttributionRecord {
  const diff = input.diff
  const record: ShadowTurnAttributionRecord = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    ...(input.turnIdSource ? { turnIdSource: input.turnIdSource } : {}),
    runtime: input.runtime,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    ...(input.beforeCommitId ? { beforeCommitId: input.beforeCommitId } : {}),
    ...(input.afterCommitId ? { afterCommitId: input.afterCommitId } : {}),
    ...(input.beforeTreeSha ? { beforeTreeSha: input.beforeTreeSha } : {}),
    ...(input.afterTreeSha ? { afterTreeSha: input.afterTreeSha } : {}),
    changes: [],
    unchangedEvidence: [],
    boundarySource: 'shadow-git',
    roots: input.roots.map((root) => ({ rootId: root.rootId, rootPath: root.rootPath, kind: root.kind })),
    ...(input.forkOf ? { forkOf: input.forkOf } : {}),
    partial: input.partial,
    ...(input.note ? { note: input.note } : {}),
  }
  // diff 拿不到时也要落一条记录：知道「这个 turn 没留下可用的边界」本身就是事实，
  // 比事后把缺失当成「没有改动」安全得多。
  if (!diff) return record

  const rootPaths = new Map(input.roots.map((root) => [root.rootId, root.rootPath]))
  const currentRootIds = new Set(rootPaths.keys())
  const previousRootIds = input.previousRootIds ? new Set(input.previousRootIds) : undefined
  const addedRoots = previousRootIds
    ? input.roots.filter((root) => !previousRootIds.has(root.rootId)).map((root) => root.rootId)
    : []
  const removedRoots = previousRootIds
    ? [...previousRootIds].filter((rootId) => !currentRootIds.has(rootId))
    : []
  if (addedRoots.length > 0 || removedRoots.length > 0) {
    record.rootSetChanges = { added: addedRoots, removed: removedRoots }
  }
  const introducedRoots = new Set(addedRoots)

  const matched = new Set<number>()
  // 被移除的根：tree 里整段消失，但那是「不再采集」，不是删除证据，直接从 changes 剔除。
  const scopedDiff = diff.filter((entry) => currentRootIds.has(entry.rootId))
  const changes: ShadowTurnChange[] = scopedDiff.map((entry) => {
    const rootPath = rootPaths.get(entry.rootId) ?? ''
    const absolutePath = rootPath ? join(rootPath, entry.path) : ''
    const hits = absolutePath
      ? input.evidence.filter((item) => samePath(item.path, absolutePath))
      : []
    for (const hit of hits) matched.add(hit.seq)
    const strongest = hits.find((item) => item.source === 'write' || item.source === 'edit') ?? hits[0]
    const beforeRefs = [...new Set(hits.map((item) => item.beforeRef).filter((ref): ref is string => Boolean(ref)))]
    const afterRefs = [...new Set(hits.map((item) => item.afterRef).filter((ref): ref is string => Boolean(ref)))]
    return {
      rootId: entry.rootId,
      path: entry.path,
      absolutePath,
      status: entry.status,
      attribution: hits.length > 0 ? 'confirmed' : 'unconfirmed',
      evidenceSeq: hits.map((item) => item.seq),
      ...(strongest ? { evidenceSource: strongest.source } : {}),
      ...(beforeRefs.length > 0 ? { beforeRefs } : {}),
      // 有 before 内容引用 = 工具执行时这个文件已经存在（可能是用户刚建的）。
      ...(entry.status === 'added' && beforeRefs.length > 0 ? { preexisting: true } : {}),
      ...(afterRefs.length > 0 ? { afterRefs } : {}),
      ...(introducedRoots.has(entry.rootId) ? { rootIntroduced: true } : {}),
    }
  })

  const unchangedEvidence: ShadowTurnUnchangedEvidence[] = []
  for (const item of input.evidence) {
    if (matched.has(item.seq)) continue
    const absolutePath = resolve(item.path)
    // 证据路径不在任何根里 = 写到了工作区之外（临时目录、绝对路径写盘），
    // 这不是「没生效」，而是本来就不归工作区管。
    const insideRoot = [...rootPaths.values()].some((rootPath) => isPathInside(absolutePath, rootPath))
    unchangedEvidence.push({
      path: insideRoot ? absolutePath : item.path,
      absolutePath,
      seq: item.seq,
      ...(item.toolName ? { toolName: item.toolName } : {}),
      reason: insideRoot ? 'no-net-change' : 'outside-roots',
    })
  }

  record.changes = changes
  record.unchangedEvidence = unchangedEvidence
  return record
}

/** 归属记录文件（JSONL，追加写）。 */
export const SHADOW_TURN_ATTRIBUTIONS_FILE = 'turns.jsonl'
/** 单文件上限：超过后压缩，避免无界增长。 */
const MAX_ATTRIBUTION_FILE_BYTES = 4 * 1024 * 1024
/** 每个会话压缩时保留的最近记录数。 */
const COMPACT_KEEP_PER_SESSION = 200

export interface ShadowAttributionCompactOptions {
  /** 触发阈值（字节）；文件不超过它时直接返回。 */
  maxBytes?: number
  /** 压缩目标（字节）；从最旧记录开始丢弃直到不超过它。 */
  targetBytes?: number
  /** 每个会话保留的最近记录数。 */
  keepPerSession?: number
}

export interface ShadowAttributionCompactResult {
  compacted: boolean
  beforeBytes: number
  afterBytes: number
  keptRecords: number
  droppedRecords: number
}

function attributionFilePath(shadowDir: string): string {
  return join(shadowDir, SHADOW_TURN_ATTRIBUTIONS_FILE)
}

/**
 * 追加一条归属记录。
 *
 * 追加写而不是读改写：turn 收尾路径上并发来自多个会话，读改写会互相覆盖。
 * 单行 JSON 含换行会被 JSON.stringify 转义，天然不会破坏行结构。
 */
export function appendShadowTurnAttribution(shadowDir: string, record: ShadowTurnAttributionRecord): void {
  mkdirSync(shadowDir, { recursive: true })
  const file = attributionFilePath(shadowDir)
  writeFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
  maybeCompactShadowAttributions(file)
}

/**
 * 超过阈值才压缩。
 *
 * 先用 stat 拿大小，小于阈值直接返回：这是每轮 turn 收尾都会走的路径，
 * 不能为了判断「要不要压缩」把整个 4MB 文件读进内存（压缩没生效时，
 * 原来的实现就是这样一个循环：每轮全量重读 + 重写，且什么也没压下去）。
 */
export function maybeCompactShadowAttributions(
  file: string,
  options: ShadowAttributionCompactOptions = {},
): boolean {
  try {
    const maxBytes = options.maxBytes ?? MAX_ATTRIBUTION_FILE_BYTES
    if (statSync(file).size <= maxBytes) return false
    return compactShadowAttributions(file, options).compacted
  } catch {
    /* 压缩只是容量治理，失败不能让采集失败 */
    return false
  }
}

/**
 * 压缩归属记录：按会话保留最近记录，再按时间全局裁剪到目标大小。
 *
 * 两个约束都不能少：
 * 1. **先按 sessionId 分组保留**：全局只留「最近 N 条」会让活跃度低的会话整段消失，
 *    回退时按 turnId 找不到边界，装配层只能退回一个错误编号；
 * 2. **压到阈值的一半**：只裁到刚好低于阈值时，下一轮 append 又会立即触发压缩，
 *    退化成每轮全量重读 + 重写。
 *
 * 记录按文件顺序（= append 顺序 = 时间顺序）保留，不重排；裁剪从最旧的一端开始。
 * 无法解析的行直接丢弃——它们已经是坏数据，留在文件里只会让每次压缩都多读一遍。
 * 写盘仍然走 temp + rename：压缩期间崩溃只会丢掉临时文件，不会留下半截记录文件。
 * I/O 错误会抛给调用方；采集路径一律走 maybeCompactShadowAttributions（它负责吞掉失败）。
 */
export function compactShadowAttributions(
  file: string,
  options: ShadowAttributionCompactOptions = {},
): ShadowAttributionCompactResult {
  const maxBytes = options.maxBytes ?? MAX_ATTRIBUTION_FILE_BYTES
  const targetBytes = options.targetBytes ?? Math.floor(maxBytes / 2)
  const keepPerSession = options.keepPerSession ?? COMPACT_KEEP_PER_SESSION

  const content = readFileSync(file, 'utf8')
  const beforeBytes = Buffer.byteLength(content)
  const result: ShadowAttributionCompactResult = {
    compacted: false,
    beforeBytes,
    afterBytes: beforeBytes,
    keptRecords: 0,
    droppedRecords: 0,
  }
  if (beforeBytes <= maxBytes) return result

  // 保留原始行文本：重新序列化会改变字节形状，也让「压缩后到底多大」变得难以推理。
  const lines: Array<{ line: string; sessionId: string }> = []
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue
    let parsed: ShadowTurnAttributionRecord
    try {
      parsed = JSON.parse(raw) as ShadowTurnAttributionRecord
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) continue
    lines.push({ line: raw, sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '' })
  }

  // 每个会话保留最近 keepPerSession 条；文件顺序就是时间顺序，不需要按字段重排。
  const keptIndexes = new Set<number>()
  const indexesBySession = new Map<string, number[]>()
  lines.forEach((item, index) => {
    const bucket = indexesBySession.get(item.sessionId)
    if (bucket) bucket.push(index)
    else indexesBySession.set(item.sessionId, [index])
  })
  for (const indexes of indexesBySession.values()) {
    for (const index of indexes.slice(Math.max(0, indexes.length - keepPerSession))) keptIndexes.add(index)
  }
  const kept = lines.filter((_, index) => keptIndexes.has(index))

  // 全局裁剪：从最旧记录开始丢弃，直到不超过目标大小。
  // 至少保留最新一条：单条记录就超过目标时宁可让它留到下一轮再压，
  // 也不能把归属历史清空——那等于让所有会话同时失去回退边界。
  let totalBytes = kept.reduce((sum, item) => sum + Buffer.byteLength(item.line) + 1, 0)
  let start = 0
  while (start < kept.length - 1 && totalBytes > targetBytes) {
    const oldest = kept[start]
    if (!oldest) break
    totalBytes -= Buffer.byteLength(oldest.line) + 1
    start += 1
  }
  const finalLines = kept.slice(start)
  const payload = finalLines.length === 0 ? '' : `${finalLines.map((item) => item.line).join('\n')}\n`
  const temp = `${file}.tmp`
  writeFileSync(temp, payload, 'utf8')
  renameSync(temp, file)

  return {
    compacted: true,
    beforeBytes,
    afterBytes: Buffer.byteLength(payload),
    keptRecords: finalLines.length,
    droppedRecords: Math.max(0, lines.length - finalLines.length),
  }
}

/** 读取归属记录；损坏行直接跳过（诊断数据不能反过来打断启动）。 */
export function readShadowTurnAttributions(
  shadowDir: string,
  filter: { sessionId?: string; limit?: number } = {},
): ShadowTurnAttributionRecord[] {
  const file = attributionFilePath(shadowDir)
  if (!existsSync(file)) return []
  const records: ShadowTurnAttributionRecord[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as ShadowTurnAttributionRecord
      if (parsed?.schemaVersion !== 1) continue
      if (filter.sessionId && parsed.sessionId !== filter.sessionId) continue
      // 早期记录（Phase 2-B1 之前）没有 roots 快照。类型上它是必填，
      // 但磁盘上的历史行不会因此长出来，所以在读取边界补齐并保持形状稳定：
      // 下游一律可以假设 roots/changes 是数组，不必各自防御 undefined。
      records.push({
        ...parsed,
        roots: Array.isArray(parsed.roots) ? parsed.roots : [],
        changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      })
    } catch {
      continue
    }
  }
  const limit = filter.limit ?? records.length
  return limit >= records.length ? records : records.slice(records.length - limit)
}

/** 按 turn 精确定位一条记录（回退时用它找边界）。 */
export function findShadowTurnAttribution(
  shadowDir: string,
  sessionId: string,
  turnId: string,
): ShadowTurnAttributionRecord | undefined {
  const records = readShadowTurnAttributions(shadowDir, { sessionId })
  return records.find((record) => record.turnId === turnId)
}

/** 把树路径还原成 `<rootId>/<relativePath>` 形式，便于测试与诊断对齐。 */
export function shadowTurnChangeTreePath(change: ShadowTurnChange): string {
  return shadowTreePath(change.rootId, change.path)
}

// ===== 分叉关系 =====

/**
 * 分叉关系：新会话从哪个会话、哪个边界分出来。
 *
 * 单独一份文件而不是塞进 turn 记录：分叉发生在「新会话还没有任何 turn」的时刻，
 * 那时没有地方可以挂这条事实；等新会话的第一条 turn 记录再回填，才能保证
 * 「fork 之后立刻重启」也不会丢掉这段关系。
 */
export interface ShadowForkRelation {
  schemaVersion: 1
  workspaceId: string
  sourceSessionId: string
  newSessionId: string
  /** 分叉时的工作区边界；采集失败时缺省，关系本身仍然保留。 */
  commitId?: string
  /** 从源会话的哪条消息处开始分叉（用户消息 uuid）。 */
  upToMessageUuid?: string
  at: number
}

export const SHADOW_FORK_FILE = 'forks.jsonl'

function forkFilePath(shadowDir: string): string {
  return join(shadowDir, SHADOW_FORK_FILE)
}

export function appendShadowForkRelation(shadowDir: string, relation: ShadowForkRelation): void {
  mkdirSync(shadowDir, { recursive: true })
  writeFileSync(forkFilePath(shadowDir), `${JSON.stringify(relation)}\n`, { encoding: 'utf8', flag: 'a' })
}

/** 读取某个新会话的分叉关系；同一会话重复分叉时取最后一条。 */
export function readShadowForkRelation(shadowDir: string, newSessionId: string): ShadowForkRelation | undefined {
  const file = forkFilePath(shadowDir)
  if (!existsSync(file)) return undefined
  let found: ShadowForkRelation | undefined
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as ShadowForkRelation
      if (parsed?.schemaVersion === 1 && parsed.newSessionId === newSessionId) found = parsed
    } catch {
      continue
    }
  }
  return found
}
