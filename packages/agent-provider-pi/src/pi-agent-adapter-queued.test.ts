import { expect, test } from 'bun:test'
import type { AgentSession, ResourceLoader } from '@earendil-works/pi-coding-agent'
import { PiAgentAdapter } from './pi-agent-adapter'

for (const priority of ['now', 'later'] as const) {
  for (const change of ['stop', 'replace', 'invalidate'] as const) {
    test(`真实 Pi adapter：Skill reload 期间 ${change} 不得提交 ${priority}`, async () => {
      let release!: () => void
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      let deliveries = 0
      const session = { steer: async () => { deliveries++ }, followUp: async () => { deliveries++ } } as unknown as AgentSession
      const active = {
        session, ready: Promise.resolve(session), abortRequested: false, disposed: false,
        resourceLoader: {
          reload: async () => { entered(); await gate },
          getSkills: () => ({ skills: [], diagnostics: [] }),
        } as unknown as ResourceLoader,
      }
      const adapter = new PiAgentAdapter()
      const sessions = (adapter as unknown as { activeSessions: Map<string, typeof active> }).activeSessions
      sessions.set('queued-generation', active)
      let current = true
      const sending = adapter.sendQueuedMessage('queued-generation', {
        type: 'user', message: { role: 'user', content: '/skill:fixture' },
        parent_tool_use_id: null, session_id: 'queued-generation', priority,
      }, { isCurrent: () => current })
      await started
      if (change === 'stop') active.abortRequested = true
      if (change === 'replace') sessions.set('queued-generation', { ...active })
      if (change === 'invalidate') current = false
      release()
      try {
        await expect(sending).rejects.toThrow()
        expect(deliveries).toBe(0)
      } finally { sessions.clear(); adapter.dispose() }
    })
  }
}
