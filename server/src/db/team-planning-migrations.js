/** 团队共享规划中心的版本化 SQLite 迁移。 */
export const teamPlanningMigrations = [
  {
    id: '20260802_01_team_planning_core',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS planning_groups (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('todo','calendar')),
          name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, scope, name)
        );
        CREATE TABLE IF NOT EXISTS planning_tags (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, name)
        );
        CREATE TABLE IF NOT EXISTS planning_todos (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),
          priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
          due_at INTEGER, group_id TEXT, assignee_id TEXT, created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          completed_at INTEGER, deleted_at INTEGER, PRIMARY KEY(workspace_id, id)
        );
        CREATE TABLE IF NOT EXISTS planning_calendar_events (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
          start_at INTEGER NOT NULL, end_at INTEGER, all_day INTEGER NOT NULL DEFAULT 0, group_id TEXT, todo_id TEXT,
          assignee_id TEXT, created_by TEXT NOT NULL, updated_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY(workspace_id, id)
        );
        CREATE TABLE IF NOT EXISTS planning_tag_links (
          workspace_id TEXT NOT NULL, target_type TEXT NOT NULL CHECK(target_type IN ('todo','calendar_event')),
          target_id TEXT NOT NULL, tag_id TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
          PRIMARY KEY(workspace_id, target_type, target_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS planning_reminders (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, target_type TEXT NOT NULL CHECK(target_type IN ('todo','calendar_event')),
          target_id TEXT NOT NULL, trigger_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','cancelled','dispatched')), origin TEXT NOT NULL DEFAULT 'manual',
          created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dispatched_at INTEGER,
          PRIMARY KEY(workspace_id, id)
        );
        CREATE TABLE IF NOT EXISTS planning_reminder_deliveries (
          workspace_id TEXT NOT NULL, id TEXT NOT NULL, reminder_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','completed')),
          snoozed_until INTEGER, delivered_at INTEGER NOT NULL, last_notified_at INTEGER, acknowledged_at INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(workspace_id, id), UNIQUE(workspace_id, reminder_id, recipient_id)
        );
        CREATE TABLE IF NOT EXISTS planning_activities (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
          action TEXT NOT NULL, actor_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_planning_todos_workspace_updated ON planning_todos(workspace_id, deleted_at, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_planning_todos_due ON planning_todos(workspace_id, status, due_at);
        CREATE INDEX IF NOT EXISTS idx_planning_events_workspace_start ON planning_calendar_events(workspace_id, deleted_at, start_at);
        CREATE INDEX IF NOT EXISTS idx_planning_reminders_due ON planning_reminders(status, trigger_at);
        CREATE INDEX IF NOT EXISTS idx_planning_deliveries_active ON planning_reminder_deliveries(workspace_id, recipient_id, status, snoozed_until);
        CREATE INDEX IF NOT EXISTS idx_planning_activities_workspace_time ON planning_activities(workspace_id, created_at DESC);
      `)
    },
  },
]
