import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve(import.meta.dir, 'AgentView.tsx'), 'utf8')

describe('AgentView rewind entry contract', () => {
  test('legacy rewindSession is not called by AgentView', () => {
    expect(source).not.toMatch(/window\.electronAPI\.rewindSession/)
  })

  test('rewind actions use the typed client and shared preview dialog', () => {
    expect(source).toContain('window.electronAPI.prepareRewind(input)')
    expect(source).toContain('window.electronAPI.executeRewind(input)')
    expect(source).toContain('<RewindDialog')
    expect(source).toContain("intent: 'edit-resend'")
    expect(source).toContain("intent: 'regenerate'")
  })
})

// 执行真实目录 effect 及其依赖表达式，不挂载无关的对话业务树。
for (const entry of ['agent', 'chat'] as const) for (const targetId of ['remote', 'local']) {
  test(`${entry}/${targetId}: Given 首次目录失败 When 同目标同代恢复 connected Then 重读且忽略普通广播与旧回执`, async () => {
    const text = entry === 'agent' ? source : readFileSync(resolve(import.meta.dir, '../chat/ModelSelector.tsx'), 'utf8')
    const marker = entry === 'agent' ? '    let active = true\n    const targetId' : '    if (!usesCoreCatalog) return\n    let active = true'
    const start = text.indexOf(marker)
    const end = text.indexOf('\n  }, [', start)
    const depsEnd = text.indexOf('])', end)
    const body = text.slice(start, end)
    const deps = text.slice(end + '\n  }, '.length, depsEnd + 1)
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const run = new Function('env', `with (env) { return { effect: () => { ${transpiler.transformSync(body)} }, deps: ${deps} } }`)
    let snapshot = { currentId: targetId, generation: 7, targets: [{ id: targetId, status: targetId === 'local' ? 'restoring' : 'disconnected' }] }
    let channels: unknown[] = []
    let loaded: unknown = null
    const pending: Array<{ resolve: (items: unknown[]) => void; reject: (error: Error) => void }> = []
    const env: Record<string, unknown> = {
      usesCoreCatalog: true, independentCoreStatus: undefined, catalogStatus: 'disconnected', catalogRevision: 0,
      store: { get: () => snapshot }, coreTargetsAtom: {},
      setRemoteChannels: (items: unknown[]) => { channels = items }, setCoreChannels: (items: unknown[]) => { channels = items },
      setRemoteChannelsLoaded: (value: unknown) => { loaded = value }, setCoreLoaded: (value: unknown) => { loaded = value },
      window: { electronAPI: { listCoreChannels: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) } },
      console: { error: () => {} }, toast: { error: () => {} },
    }
    let previous: unknown[] = []
    let cleanup: (() => void) | undefined
    const render = () => {
      env.coreTarget = snapshot; env.target = snapshot
      env.catalogStatus = snapshot.targets[0]!.status
      env.independentCoreStatus = targetId === 'local' ? snapshot.targets[0]!.status : undefined
      const next = run(env) as { effect: () => (() => void) | undefined; deps: unknown[] }
      if (next.deps.length !== previous.length || next.deps.some((value, index) => !Object.is(value, previous[index]))) {
        cleanup?.(); previous = next.deps; cleanup = next.effect()
      }
    }
    const flush = async () => { await Promise.resolve(); await Promise.resolve() }
    render(); expect(pending).toHaveLength(1)
    pending[0]!.reject(new Error('offline')); await flush()
    snapshot = { ...snapshot, targets: [{ id: targetId, status: 'connected' }] }; render()
    expect(pending).toHaveLength(2)
    pending[1]!.resolve([{ id: 'fresh' }]); await flush()
    expect(channels[0]).toMatchObject({ id: 'fresh' }); expect(loaded).toEqual({ targetId, generation: 7 })
    snapshot = { ...snapshot, targets: snapshot.targets.map(target => ({ ...target })) }; render()
    expect(pending).toHaveLength(2); expect(channels[0]).toMatchObject({ id: 'fresh' })
    snapshot = { ...snapshot, generation: 8 }; render()
    snapshot = { ...snapshot, generation: 9 }; render()
    pending[2]!.resolve([{ id: 'stale-generation' }]); await flush()
    expect(channels).toEqual([]); expect(loaded).toBeNull()
    snapshot = { ...snapshot, currentId: 'other' }; render()
    pending[3]!.resolve([{ id: 'stale-target' }]); await flush()
    expect(channels).toEqual([]); expect(loaded).toBeNull()
    pending[4]!.resolve([{ id: 'current' }]); await flush()
    expect(channels[0]).toMatchObject({ id: 'current' }); expect(loaded).toEqual({ targetId: 'other', generation: 9 })
    env.catalogRevision = 1; render()
    expect(pending).toHaveLength(6)
    pending[5]!.resolve([{ id: 'account-refreshed' }]); await flush()
    expect(channels[0]).toMatchObject({ id: 'account-refreshed' })
    expect(snapshot.generation).toBe(9)
    cleanup?.()
  })
}
