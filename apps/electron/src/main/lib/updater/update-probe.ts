import type { UpdateSource } from './update-sources'

export interface SourceProbeOutcome {
  source: UpdateSource
  reachable: boolean
  latencyMs: number
}

/**
 * 对参与探测的源并发探活，据此重排实际尝试顺序。
 *
 * 背景（2026-10-08）：更新源的请求超时是 30s，而 DNS 指向黑洞 IP 时（丢包、不回 RST）
 * 每个死源都会实打实吃满 30s。`runWithUpdateSourceFallback` 是串行的，于是「先试主源、
 * 失败再试备用源」在故障时退化成「每检查一次白等 30s」。这里用秒级探活把不可达的源
 * 从尝试序列里摘掉，让顺序由「可达性 + 延迟」决定，而不是由声明顺序决定。
 *
 * 取舍：
 * - 至少一个源可达 → 只按延迟升序尝试可达的那些，外加不参与探测的 GitHub（保持兜底位置）；
 *   探活判定不可达的源直接摘掉。摘掉是安全的：此刻它已被测出不可达，而 GitHub 仍在末尾兜底。
 * - 全部不可达 → 退回原始声明顺序，行为与改造前一致。探活本身可能被代理策略挡住，
 *   而真实请求能通，所以不能因为探测失败就放弃所有源。
 *
 * @param probe 返回 true 表示该源可达。独立注入以便单测不依赖网络。
 */
export async function orderSourcesByReachability(
  sources: readonly UpdateSource[],
  probe: (source: UpdateSource) => Promise<boolean>,
): Promise<UpdateSource[]> {
  const probeable = sources.filter((source) => source.probeUrl !== null)
  if (probeable.length === 0) return [...sources]

  const unprobeable = sources.filter((source) => source.probeUrl === null)

  const outcomes: SourceProbeOutcome[] = await Promise.all(
    probeable.map(async (source) => {
      const startedAt = Date.now()
      try {
        return { source, reachable: await probe(source), latencyMs: Date.now() - startedAt }
      } catch {
        return { source, reachable: false, latencyMs: Date.now() - startedAt }
      }
    }),
  )

  const reachable = outcomes
    .filter((outcome) => outcome.reachable)
    .sort((left, right) => left.latencyMs - right.latencyMs)

  if (reachable.length === 0) return [...sources]

  return [
    ...reachable.map((outcome) => outcome.source),
    ...unprobeable,
  ]
}

/** 便于日志与排查：把探测结果格式化成一行。 */
export function describeProbeOutcomes(
  sources: readonly UpdateSource[],
  ordered: readonly UpdateSource[],
): string {
  const order = ordered.map((source) => source.id).join(' → ')
  const dropped = sources
    .filter((source) => !ordered.includes(source))
    .map((source) => source.id)
  return dropped.length > 0
    ? `顺序 ${order}（探活不可达已跳过: ${dropped.join(', ')}）`
    : `顺序 ${order}`
}
