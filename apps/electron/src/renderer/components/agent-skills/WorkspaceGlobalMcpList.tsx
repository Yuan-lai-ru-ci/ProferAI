import { coreTargetsAtom, ownsCoreResources } from '@/atoms/core-target-atoms'
import * as React from 'react'
import { useAtomValue } from 'jotai'
import { workspaceCapabilitiesVersionAtom } from '@/atoms/agent-atoms'
import type { WorkspaceGlobalMcpSummary } from '@profer/shared'

interface SummaryState {
  slug: string
  items: WorkspaceGlobalMcpSummary[]
  failed: boolean
}

export function useWorkspaceGlobalMcp(workspaceSlug: string) {
  const target = useAtomValue(coreTargetsAtom)
  const coreOwned = ownsCoreResources(target)
  const version = useAtomValue(workspaceCapabilitiesVersionAtom)
  const [result, setResult] = React.useState<SummaryState | null>(null)
  React.useEffect(() => {
    if (!workspaceSlug || coreOwned) return
    let current = true
    void window.electronAPI.listWorkspaceGlobalMcpServers(workspaceSlug).then(
      items => { if (current) setResult({ slug: workspaceSlug, items, failed: false }) },
      () => { if (current) setResult({ slug: workspaceSlug, items: [], failed: true }) },
    )
    return () => { current = false }
  }, [workspaceSlug, version, coreOwned, target.generation])
  if (coreOwned) return null
  return result?.slug === workspaceSlug ? result : null
}

export function WorkspaceGlobalMcpList({ items }: { items: WorkspaceGlobalMcpSummary[] }) {
  if (!items.length) return null
  return (
    <section className="mb-5 space-y-2">
      <h3 className="font-medium">来自全局配置</h3>
      {items.map(item => (
        <p key={item.name} className="rounded-lg bg-muted/40 px-3 py-2 text-sm">
          {item.name} · {item.shadowed ? '已被同名工作区配置遮蔽' : item.enabled ? '已启用' : '已关闭'}
        </p>
      ))}
    </section>
  )
}
