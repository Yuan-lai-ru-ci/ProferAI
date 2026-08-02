import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runMigrations } from '../db/migration-runner.js'
import { teamPlanningMigrations } from '../db/team-planning-migrations.js'
import { dispatchDuePlanningReminders, listActiveDeliveries } from './reminder-service.js'

function setup() {
  const db = new Database(':memory:')
  runMigrations(db, teamPlanningMigrations)
  const now = 1000
  db.prepare(`INSERT INTO planning_todos(workspace_id,id,title,priority,created_by,updated_by,assignee_id,created_at,updated_at) VALUES ('ws','todo','团队任务','medium','author','author','owner',?,?)`).run(now, now)
  db.prepare(`INSERT INTO planning_reminders(workspace_id,id,target_type,target_id,trigger_at,created_by,created_at,updated_at) VALUES ('ws','r1','todo','todo',500,'author',?,?)`).run(now, now)
  return db
}

test('到期团队提醒为创建者和负责人各投递一次，重复扫描幂等', () => {
  const db = setup()
  try {
    const first = dispatchDuePlanningReminders(db, 1000)
    assert.equal(first.length, 2)
    assert.deepEqual(new Set(first.map((item) => item.recipientId)), new Set(['author', 'owner']))
    assert.equal(dispatchDuePlanningReminders(db, 2000).length, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM planning_reminder_deliveries').get().n, 2)
  } finally { db.close() }
})

test('创建者与负责人相同只收到一条，确认不会影响其他成员', () => {
  const db = setup()
  try {
    db.prepare("UPDATE planning_todos SET assignee_id='author' WHERE workspace_id='ws' AND id='todo'").run()
    dispatchDuePlanningReminders(db, 1000)
    assert.equal(listActiveDeliveries(db, 'ws', 'author').length, 1)
    assert.equal(listActiveDeliveries(db, 'ws', 'owner').length, 0)
  } finally { db.close() }
})

test('origin=todo_due_at 的自动完工提醒与手动提醒一样会被正常到期投递', () => {
  const db = setup()
  try {
    // 追加一条 origin='todo_due_at' 的自动完工提醒，模拟“团队 todo 基于 due_at 自动生成的提醒”。
    db.prepare("INSERT INTO planning_reminders(workspace_id,id,target_type,target_id,trigger_at,origin,created_by,created_at,updated_at) VALUES ('ws','r2','todo','todo',1000,'todo_due_at','author',?,?)").run(1000, 1000)
    const first = dispatchDuePlanningReminders(db, 1000)
    // r1(manual) + r2(todo_due_at) 都应各投递给作者和负责人
    assert.equal(first.length, 4)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM planning_reminder_deliveries').get().n, 4)
    // 再次扫描不重复投递
    assert.equal(dispatchDuePlanningReminders(db, 2000).length, 0)
  } finally { db.close() }
})
