import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./core-target-service.ts', import.meta.url), 'utf8')
const start = source.indexOf('  unsubscribeLocalPlanning = client.addPlanningEventListener(payload => {')
const end = source.indexOf('\n  localClient = client', start)
const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end).replace("import('./planning-reminder-scheduler')", 'loadNotificationPort()'))

test('本机Core提醒listener广播并通知；目标切换后旧listener及延迟通知不投递', async () => {
  const broadcasts: unknown[] = [], notifications: unknown[] = []
  let listener: (payload: unknown) => void = () => undefined
  let selected = 'local'
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const client = { addPlanningEventListener(callback: (payload: unknown) => void) { listener = callback; return () => undefined } }
  const run = new Function('client', 'activeId', 'BrowserWindow', 'PLANNING_IPC_CHANNELS', 'loadNotificationPort', `
    let unsubscribeLocalPlanning;
    const activeClient = client;
    const LOCAL_TARGET_ID = 'local';
    ${body}
  `)
  run(client, () => selected, { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (...args: unknown[]) => broadcasts.push(args) } }] }, { REMINDER_DUE: 'due' }, async () => { await gate; return { showPlanningSystemNotification: (value: unknown) => notifications.push(value) } })
  listener({ type: 'reminders_due', reminders: [{ id: 'one' }] })
  expect(broadcasts).toEqual([['due', [{ id: 'one' }]]])
  release?.(); await Bun.sleep(0)
  expect(notifications).toEqual([{ id: 'one' }])
  listener({ type: 'reminders_due', reminders: [{ id: 'late' }] })
  selected = 'remote'
  await Bun.sleep(0)
  expect(notifications).toHaveLength(1)
  listener({ type: 'reminders_due', reminders: [{ id: 'stale' }] })
  expect(broadcasts).toHaveLength(2)
})
