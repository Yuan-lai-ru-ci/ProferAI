import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createSessionStorePaths, sessionGraphPath, sessionHarnessPath } from '@profer/session-store'
import { createPiHarnessRuntime } from '@profer/agent-provider-pi/harness/runtime'
import { shouldStartPiHarness } from '@profer/agent-provider-pi/harness/feature-gate'
import { buildGraphFromEvents, isSafeSessionId, parseEventsFromJsonl, selectHarnessFocus, serializeEvent } from '../../../packages/project-core/src/index'
import { replayPiHarnessEvents } from './native-harness-reducer'
import type { PiHarnessDiagnostic, PiHarnessEvent } from './native-harness-types'

/** 每个 Core 实例创建一次；调用前由 runtime 注册会话所属布局。 */
export function createCoreHarnessRuntime(options: {
  configDir: string
  assertSession: (sessionId: string) => void
  onChanged?: (sessionId: string) => void
}) {
  const paths = createSessionStorePaths(options.configDir)
  const pathFor = (sessionId: string, kind: 'graph' | 'harness') => {
    if (!isSafeSessionId(sessionId)) throw new Error('无效的会话标识')
    options.assertSession(sessionId)
    const path = kind === 'graph' ? sessionGraphPath(paths, sessionId) : sessionHarnessPath(paths, sessionId)
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Harness 日志不允许使用符号链接')
    return path
  }
  const append = (sessionId: string, kind: 'graph' | 'harness', line: string) => {
    const path = pathFor(sessionId, kind)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
    options.onChanged?.(sessionId)
  }
  const manager = createPiHarnessRuntime({
    appendGraphEvent: (sessionId, event) => append(sessionId, 'graph', serializeEvent(event)),
    appendPiHarnessEvent: (sessionId, event) => {
      if (event.sessionId !== sessionId || event.version !== 1) throw new Error('Harness 事件归属或版本无效')
      append(sessionId, 'harness', JSON.stringify(event))
    },
    loadHarnessGraphSnapshot: (sessionId, previousFocusTaskId) => {
      const path = pathFor(sessionId, 'graph')
      const graph = buildGraphFromEvents(existsSync(path) ? parseEventsFromJsonl(readFileSync(path, 'utf8')) : [])
      return { graph, focusTaskId: selectHarnessFocus(graph, previousFocusTaskId).task?.id }
    },
    loadPiHarnessSnapshot: sessionId => {
      const path = pathFor(sessionId, 'harness')
      const events: PiHarnessEvent[] = [], diagnostics: PiHarnessDiagnostic[] = []
      if (existsSync(path)) readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return
        try {
          const event = JSON.parse(line) as PiHarnessEvent
          if (event.version !== 1) diagnostics.push({ line: index + 1, code: 'unsupported_version', message: '忽略未知 Harness 版本' })
          else if (typeof event.eventId !== 'string' || typeof event.timestamp !== 'number' || typeof event.goalId !== 'string' || typeof event.type !== 'string' || !event.payload) diagnostics.push({ line: index + 1, code: 'invalid_event', message: '忽略无效 Harness 事件' })
          else events.push(event)
        } catch { diagnostics.push({ line: index + 1, code: 'invalid_json', message: '忽略损坏的 Harness 日志行' }) }
      })
      return replayPiHarnessEvents(sessionId, events, diagnostics)
    },
  })
  return { ...manager, shouldStartPiHarness }
}

export type CoreHarnessRuntime = ReturnType<typeof createCoreHarnessRuntime>
export type { PiHarnessRunScope } from '@profer/agent-provider-pi/harness/run-scope'
export type { ToolFactInput } from '@profer/agent-provider-pi/harness/tool-facts'
