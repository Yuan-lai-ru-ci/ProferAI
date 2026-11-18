import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./planning-reminder-scheduler.ts', import.meta.url), 'utf8')
const start = source.indexOf('function checkDueReminders(): void {')
const end = source.indexOf('\nexport function startPlanningReminderScheduler', start)
if (start < 0 || end < start) throw new Error('Planning reminder scheduler boundary missing')
const body = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))

function fixture(targetId: string) {
  const calls: string[] = []
  const run = new Function('getCurrentCoreTargetId', 'claimDuePlanningReminders', 'showPlanningSystemNotification', 'broadcastPlanningRemindersDue', 'broadcastPlanningChanged', `
    let checking = false;
    ${body}
    return checkDueReminders;
  `)(
    () => targetId,
    () => { calls.push('claim'); return [{ id: 'reminder' }] },
    () => calls.push('system'),
    () => calls.push('due'),
    () => calls.push('changed'),
  ) as () => void
  return { run, calls }
}

describe('Planning reminder Core ownership', () => {
  test('does not claim or notify local reminders while a remote Core is selected', () => {
    const f = fixture('remote')
    f.run()
    expect(f.calls).toEqual([])
  })
  test('claims and notifies in local mode and releases checking guard', () => {
    const f = fixture('local')
    f.run()
    expect(f.calls).toEqual(['claim', 'system', 'due', 'changed'])
    f.run()
    expect(f.calls.filter(call => call === 'claim')).toHaveLength(2)
  })
})
