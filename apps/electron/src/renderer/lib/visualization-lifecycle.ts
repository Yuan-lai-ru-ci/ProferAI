import { VISUALIZATION_LIMITS } from '@profer/shared'
import type { VisualizationCandidate } from '@/atoms/visualization-atoms'

/**
 * 已在渲染中的实例享有惯性。
 *
 * 为什么需要：滚动时候选距离一直在变，纯粹按距离排序会让**正在看的那个**被刚滑进来的邻居抢走名额，
 * 实例随即 `setContent(null)` 变回占位 —— 表现就是「还没滑完就不渲染了」。
 * 512 意味着只要它还在视口附近（含刚从屏幕上沿刚滚出去那一段），后来的邻居就抢不走它的名额；
 * 它自己滑远之后照常被换下，不是锁死。配合 512px 距离分桶，进一步减少换手频率。
 */
const LIVE_KEEP_BONUS = 512

/**
 * 「可见」半径：距视口中心半个视口以内。
 *
 * 为什么需要硬保护：一个会话可以同时有十几个可视化，而名额只有 4 个。滚动时距离每跨一个分桶
 * 边界就变一次，光靠排名会让**指针正下方那个 iframe**被反复卸掉重建（日志里一分钟内同一实例重挂
 * 六次以上）。iframe 被卸载时，Chromium 已经 latch 到它上面的滚轮手势剩余部分会被**整段丢弃**
 * ——表现为「鼠标停在片段上滚不动，动一下鼠标才好」，而渲染主线程其实一直活着。
 * 所以：只要实例还在渲染且没滚出视口，就不允许被排名挤掉。增大到 1024 配合更大的分桶粒度。
 */
const VISIBLE_KEEP_RADIUS = 1024

/** 候选是否必须保留：焦点所在，或已渲染且仍在视口内。 */
function isProtected(candidate: VisualizationCandidate): boolean {
  return candidate.focused || (candidate.live && candidate.distance <= VISIBLE_KEEP_RADIUS)
}

/**
 * 点「激活交互」后的宽限期。
 *
 * 内容挂载要经过 IPC + 建 iframe，这期间占位按钮从 DOM 消失、focus 掉回 body，
 * 内容挂载又必然触发一次 publish（resize）—— 如果 focused 只看 DOM focus，
 * 这次 publish 就会把刚做的激活当场撤销：名额被别的 live 实例抢回去，
 * 内容刚出来又被卸载（用户看到的是「点了激活 → 闪一下 → 又变回占位」）。
 * `active` 落定后由组件把意图清掉（activationAt = 0），之后恢复成按 DOM focus 判定。
 */
export const ACTIVATION_GRACE_MS = 1500

/** 候选的「用户正在操作它」判定：手动激活意图优先于 DOM focus。 */
export function resolveCandidateFocus(input: { activationAt: number; domFocused: boolean; now?: number }): boolean {
  if (input.domFocused) return true
  return (input.now ?? Date.now()) - input.activationAt < ACTIVATION_GRACE_MS
}

/** 可见实例共享一个预算；操作中的结果优先，其次惯性中的实例，最后才比距离。
 *
 * 先选出「必须保留」的（焦点 / 已渲染且可见），再按排名补足剩余名额：
 * 这保证指针下方的实例不会在滚动中被换手（换手会丢掉整段滚轮手势）。
 */
export function chooseVisualizationInstances(candidates: Iterable<VisualizationCandidate>, limit: number = VISUALIZATION_LIMITS.maxActiveInstances): Set<string> {
  const ranked = [...candidates]
    .map((candidate) => ({ candidate, rank: candidate.distance - (candidate.live ? LIVE_KEEP_BONUS : 0) }))
    .sort((a, b) =>
      Number(b.candidate.focused) - Number(a.candidate.focused)
      || a.rank - b.rank
      || a.candidate.id.localeCompare(b.candidate.id))
  const capacity = Math.max(0, limit)
  const kept = ranked.filter((item) => isProtected(item.candidate)).slice(0, capacity)

  if (kept.length >= capacity) return new Set(kept.map((item) => item.candidate.id))
  const keptIds = new Set(kept.map((item) => item.candidate.id))
  for (const item of ranked) {
    if (keptIds.size >= capacity) break
    if (keptIds.has(item.candidate.id)) continue
    keptIds.add(item.candidate.id)
  }

  return keptIds
}

export function visualizationStateKey(sessionId: string, id: string, revision: string): string {
  return JSON.stringify([sessionId, id, revision])
}
