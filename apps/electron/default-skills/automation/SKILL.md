---
name: automation
description: "Profer's built-in automation and scheduled-task Skill, shipped with Profer rather than installed temporarily by users. Trigger broadly and redundantly: if the user's words contain any sign of \"something to do in the future,\" \"keep watching this later,\" \"do this repeatedly,\" \"it would be useful to run this again,\" \"regularly / periodically / daily / weekly / monthly / every so often,\" \"keep an eye on / continue observing / long-term follow-up / long-term monitoring,\" \"automatically check / summarize / generate / review / maintain,\" \"unattended,\" \"tell me when something changes,\" \"remind me when something is wrong,\" \"adjust if the results are poor,\" \"view run history,\" \"optimize an existing task,\" or \"pause / resume / delete / run now,\" this Skill should be triggered to first assess whether a Profer scheduled task is appropriate. Ambiguous scenarios may also trigger it: recurring reports, daily/weekly reports, project status, repeated checks of GitHub/email/Lark/files/releases/CI/prices/competitors/data sources, repeated research workflows, periodic knowledge organization, and automation workflow maintenance. Frequent triggering does not mean a task must be created; for one-off tasks, short-term reminders, simple calendar alarms, tasks requiring real-time user judgment, or tasks without lasting value, clearly say that creating a Profer scheduled task is not recommended and provide an alternative."
version: "1.1.2"
group: profer
---

# Profer Automation

You help users assess, create, and maintain Profer scheduled tasks (Automation). This is a built-in Profer Skill distributed with Profer in the default Skills and workspace Skills; it does not depend on users installing anything extra. Scheduled tasks are suitable for work that is valuable, recurring over the long term, and unattended; they are not suitable for temporary reminders or one-off tasks.

Profer provides a built-in `automation` MCP tool. You must use these tools to operate scheduled tasks. Do not use `TaskCreate`, `CronCreate`, Bash `cron`, the system calendar, or hidden-comment protocols to create Profer scheduled tasks.

## Triggering Policy

Keep this Skill's triggering policy broad: **it is better to trigger frequently and then decide "creation is not recommended" than to miss a potential automation opportunity**.

Whenever a user's request contains any of the following signals, first use this Skill to assess it:

- Time signals: regularly, daily, weekly, monthly, every so often, long term, later, next time, continuously.
- Repetition signals: often, repeatedly, routinely, a fixed workflow, every time, will do again.
- Observation signals: watch, follow up, monitor, check, detect changes, alert on anomalies, status updates.
- Deliverable signals: daily report, weekly report, report, summary, retrospective, remind me to review results, organize progress.
- Automation signals: run automatically, unattended, run in the background, run at a set time, maintain this for me.
- Maintenance signals: view tasks, run history, poor results, change frequency, pause, resume, delete, run now.

Triggering this Skill only starts the assessment process; it does not mean a Profer scheduled task must be created. Proactively distinguish "suitable for long-term automation" from "only needs to be done once now."

## Assess Whether It Is Worth Creating

Scenarios where a scheduled task is recommended:

- Long-term recurrence: the work must be done daily, weekly, or every so often, and will continue.
- Unattended execution: the Agent can complete the main work without the user's immediate participation.
- Stable objective: the input sources, evaluation criteria, and deliverables are relatively stable for each run.
- Compounding value: periodic reports, ongoing monitoring, automatic summaries, status tracking, routine retrospectives.
- Verifiability: after each run, success, failure, omissions, or quality issues can be identified.

Scenarios where creating a scheduled task is not recommended:

- A one-off task, or something that only needs to be done once now.
- A short-term reminder, everyday alarm, or simple countdown.
- Something requiring the user's real-time judgment, approval, or substantial context.
- The execution objective is not yet stable, and frequency and deliverables are unclear.
- The result has no lasting value and is only intended to help the user "not forget."

When it is not recommended, explain why directly and provide a more suitable alternative: do it once now, capture the workflow in a Skill, add it to the project plan, or have the user set a reminder in a calendar/reminder tool, etc.

## Clarify Before Creating

Before creating a scheduled task, clarify at least the following:

- `name`: a short name describing the long-term objective, not a one-off action.
- `scheduleType` + its corresponding fields: keep the frequency restrained unless the task truly needs high-frequency monitoring. See the table below for selection guidance.
- `prompt`: the complete instruction sent to the Agent on each automatic run.
- Permission mode: the default `bypassPermissions` is suitable for unattended work; high-risk scenarios can use `auto`, but the task may be suspended while awaiting approval.
- Session mode (`sessionMode`): defaults to `daily`; triggers on the same calendar day reuse one child session, and a new one is created across days. `reuse` always reuses the same child session to preserve long-term context. See below for selection guidance.
- Agent preset (`presetId`, optional): built-in `standard`/`code`/`minimal` or a custom preset from the task's workspace; it determines the child session's prompt sections, tool restrictions, and reasoning strength. If omitted at creation, it inherits the current session's preset; unassigned tasks follow the workspace default preset. A preset's permission settings do not override the task's permission mode; unattended safety takes priority.

### Choosing a Schedule Type

| scheduleType | Suitable scenarios | Required fields |
|---|---|---|
| `interval` | High-frequency monitoring (CI status, prices, inventory, chat alerts), minute-level response | `intervalMinutes` |
| `daily` | Daily briefings, daily reports, morning summaries | `timeOfDay` |
| `weekly` | Weekly reports, weekly retrospectives, preparation before a weekly meeting | `dayOfWeek` + `timeOfDay` |
| `monthly` | Monthly reports, beginning-of-month reconciliation, month-end settlement, monthly retrospectives | `dayOfMonth` + `timeOfDay` |

`timeOfDay` uses 24-hour `HH:MM` format (for example, `09:30`, `22:00`). `dayOfWeek`: 0=Sunday, 1=Monday … 6=Saturday. `dayOfMonth`: 1-31.

### Short-Month Fallback for `monthly` (Important)

When `dayOfMonth` is 29/30/31, February (28/29 days) and April/June/September/November (30 days) automatically run on the last day of that month rather than being skipped. This means:

- Choosing the 31st → runs only 7 times in a year in practice (January/March/May/July/August/October/December); in other months it falls on the last day of the month.
- Choosing the 29th → in a common year, February falls on 2/28; in a leap year, it falls on 2/29.

When the user says "at the end of every month," recommend **using the 28th** rather than the 31st, or the user may assume it runs every month when that is not what happens. Alternatively, clearly explain this fallback behavior and let the user decide.

### Choosing `sessionMode`

- `daily` (default): all triggers on the same calendar day write to the same child session, and a new session is created when the date changes. **Use this for the vast majority of scheduled tasks**—it lets multiple runs in one day share context (using fewer sidebar tabs), while resetting daily to prevent long-term token accumulation. For low-frequency tasks (interval ≥ 24 hours), the actual behavior is equivalent to "create a new one each time," so no separate configuration is needed.
- `reuse`: always reuses the same child session and preserves long-term conversation history. Suitable for tasks that **genuinely need cross-day memory and knowingly incur token costs**—tracking the same long-term issue continuously or iteratively improving the same document.

The cost of `reuse`: context grows without bound with the number of runs; long-running tasks may become more expensive due to token accumulation or trigger automatic compaction. If each run produces an independent result (for example, "check what new PRs there are today"), use the default `daily`; do not choose `reuse`.

If the user only says "do X regularly for me" but the frequency or result is unclear, use `AskUserQuestion` at most once to resolve the missing details into an executable configuration. Do not make the user fill out a long form.

## Writing Prompts

A scheduled task's `prompt` should read like "instructions for a task that can be independently executed each time in the future" and must not depend on implicit context from the current conversation.

A high-quality prompt should include:

- Objective: what this automatic run should accomplish.
- Scope: which repositories, files, systems, group chats, emails, documents, or data sources to inspect.
- Evaluation criteria: what counts as abnormal, important, or worth reporting.
- Output format: what to deliver to the user, such as a summary, list, report, or action recommendations.
- Failure handling: how to record and degrade gracefully when access is unavailable, information is insufficient, or a tool fails.
- Cross-run memory (strongly recommended): maintain `.context/automation/<task-slug>/notes.md` in the workspace so each run can build on previous findings instead of starting from scratch. **This section must be included in the prompt itself** for the runtime Agent to execute it:
  - At the start of a run, `Read` the file (skip if it does not exist on the first run) and continue from previous observations, judgments, and to-dos.
  - At the end of a run, `Edit` the same file: prepend a `## YYYY-MM-DD` entry documenting new findings from this run; also **actively remove old entries that are resolved, outdated, or no longer applicable**—the file is rolling working memory, not an infinitely growing log. Whenever this run touches related information (checking a repository, inspecting CI status, reading a document), also assess whether old entries still hold true and remove them when possible, to keep `notes.md` concise and prevent it from becoming another context burden.
- Self-iteration requirement: if there are consecutive failures, low-value results, or an unsuitable frequency, first `Read` the notes and `get_automation` run history, then use `update_automation` to modify the current task (prompt, frequency, `sessionMode`) and pause it if necessary.

Choose `<task-slug>` yourself when creating the task and include it in the prompt: convert the task name to kebab-case (lowercase, replace spaces and punctuation with `-`, retain only alphanumeric characters); for example, the task name "Monthly GitHub PR Summary" → slug `monthly-github-pr-summary`. Do not change it after choosing it, or the notes path will break.

Do not write "please create a scheduled task" in the prompt. The prompt describes the work to execute on each trigger; it is not a creation instruction.

### Prompt Template Example

A prompt template for a monthly report task (use this structure when creating the task; copy the cross-run memory section directly):

    Objective: Summarize the PRs merged into the Yuan-lai-ru-ci/ProferAI repository this month, grouping them by category and noting their impact.
    Scope: Read the closed PR list for Yuan-lai-ru-ci/ProferAI and filter for those merged this month.
    Evaluation criteria: For each PR, determine whether it introduces a breaking change, affects user configuration, or requires documentation updates.
    Output format: A Markdown report with four groups: "Major changes," "New features," "Fixes," and "Documentation."

    Cross-run memory:
    - Before starting, Read .context/automation/monthly-pr-summary/notes.md (skip if it does not exist on the first run), and continue from previous judgments and to-dos
    - After finishing, Edit the same file and prepend a ## YYYY-MM-DD entry; remove resolved/outdated old entries during this run to keep notes.md concise

    Self-iteration: After 2 consecutive failures or low-value outputs, use get_automation to read the current task and adjust the prompt or frequency.

Tasks unsuitable for cross-run memory: each run produces a fully independent result and does not need accumulated context (for example, "check what new PRs there are today"). Such tasks do not need a cross-run memory section in their prompts.

## Tool Usage

Call the `automation` MCP tool according to the scenario. Tool names depend on the runtime: use bare names in the Claude runtime (as listed below); in Pi Runtime, the same tools have the `mcp__automation__` prefix (for example, `mcp__automation__list_automations`).

- `list_automations`: view existing tasks to avoid duplicate creation and check whether they are active or paused.
- `get_automation`: view a task's details and run history; while an automated task is running, omit `id` to read the current task.
- `create_automation`: create a new Profer scheduled task, only for scenarios confirmed to be worth recurring long-term.
- `update_automation`: modify any fields—`name`, `prompt`, `scheduleType`/`intervalMinutes`/`timeOfDay`/`dayOfWeek`/`dayOfMonth` (frequency), `permissionMode` (permission mode), `sessionMode` (session mode), `presetId` (Agent preset), `active` (active/paused). Changes to scheduling fields automatically recalculate the next run time. While an automated task is running, omit `id` to update the current task.
- `delete_automation`: delete a task. Confirm before deleting unless the user explicitly requested it.
- `run_automation_now`: use when the user requests immediate validation or when a task you just changed needs a trial run. Do not trigger a task's own re-entry while it is running.

Before creating a task, use `list_automations` to check for an identical or similar task. If an existing task can be modified, modify it instead of creating a duplicate.

## Maintenance and Self-Iteration

When the user checks or complains that a scheduled task is performing poorly:

1. Use `get_automation` to inspect the prompt, frequency, permission mode, and recent run history.
2. Determine the type of issue: unsuitable frequency, overly broad prompt, unclear scope, insufficient tool permissions, unavailable external system, or a task that is inherently unsuitable for automation.
3. If it can be fixed directly, use `update_automation` to modify the prompt, frequency, or paused state.
4. If validation is needed, use `run_automation_now` for a trial run.
5. Tell the user what changed and how the next trigger will differ.

When you are yourself an Agent automatically triggered by a scheduled task:

- Do not create a new scheduled task.
- Execute this run's task directly first.
- If you find that the current task has consecutive failures, low-value output, excessive frequency, or an incomplete prompt, you can call `get_automation` to read the current task, then use `update_automation` to modify it, pausing it if necessary.
- After modifying your own task, explain the reason and changes in the final response.

## Response Style

- After creating, modifying, pausing, or deleting a task, tell the user the specific result in natural language.
- After creating a task, remind the user that they can click the "Automated Tasks" entry in the top-left corner, find the task they just created, and choose which model it uses when running (models differ in cost and capability, so choose one appropriate to the task's complexity).
- Do not expose internal tool-call JSON.
- If a scheduled task is not recommended, clearly say "creating a Profer scheduled task is not recommended" and explain the more suitable handling.
- For recurring long-term tasks, proactively suggest that the user can later view run history and adjust configuration from the scheduled-tasks entry in the sidebar.
