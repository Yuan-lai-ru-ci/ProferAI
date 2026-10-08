import { expect, test } from 'bun:test'
import * as React from 'react'
import { createLoadedHost, nodeText } from './settings-loaded-visual-host'

test('嵌套 effects 完成后输出 loaded 树，切换和 dispose 清理订阅', async () => {
  const subscriptions = new Set<string>()
  function LoadedChild({ id }: { id: string }) {
    const [value, setValue] = React.useState('loading')
    React.useEffect(() => {
      let active = true
      subscriptions.add(id)
      void Promise.resolve(`loaded-${id}`).then((next) => { if (active) setValue(next) })
      return () => { active = false; subscriptions.delete(id) }
    }, [id])
    return <div>{value}</div>
  }
  function LoadedPage() {
    const [id, setId] = React.useState('A')
    return <section><button onClick={() => setId('B')}>切换</button><LoadedChild key={id} id={id} /></section>
  }
  const host = createLoadedHost(() => <LoadedPage />, new Set(['LoadedPage', 'LoadedChild']))
  try {
    await host.settle()
    expect(nodeText(host.tree())).toContain('loaded-A')
    expect([...subscriptions]).toEqual(['A'])
    await host.click('切换')
    expect(nodeText(host.tree())).toContain('loaded-B')
    expect(nodeText(host.tree())).not.toContain('loaded-A')
    expect([...subscriptions]).toEqual(['B'])
  } finally { host.dispose() }
  expect(subscriptions.size).toBe(0)
})

test('同名 keyed 子组件重排保留各自 hook 状态，不按数组下标串值', async () => {
  function LoadedRow({ id }: { id: string }) {
    const [value] = React.useState(() => `state-${id}`)
    return <div>{value}</div>
  }
  function LoadedList() {
    const [ids, setIds] = React.useState(['A', 'B'])
    return <section><button onClick={() => setIds(['B', 'A'])}>重排</button>{ids.map((id) => <LoadedRow key={id} id={id} />)}</section>
  }
  const host = createLoadedHost(() => <LoadedList />, new Set(['LoadedList', 'LoadedRow']))
  try {
    await host.settle()
    expect(nodeText(host.tree())).toBe('重排state-Astate-B')
    await host.click('重排')
    expect(nodeText(host.tree())).toBe('重排state-Bstate-A')
  } finally { host.dispose() }
})

test('未找到真实事件明确失败，不虚构交互完成', async () => {
  const host = createLoadedHost(() => <div>fixture</div>, new Set())
  try {
    await host.settle()
    await expect(host.click('不存在的入口')).rejects.toThrow('真实事件入口未找到')
  } finally { host.dispose() }
})
