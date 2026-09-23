import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureShellSnapshot, getOrCreateShellSnapshot, sanitizeShellEnvironment } from './shell-snapshot'

describe('ShellSnapshot', () => {
  test('Given a session cwd When capturing twice Then the persisted snapshot is reused with a stable hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-shell-snapshot-'))
    try {
      const options = {
        sessionId: 'session-1',
        cwd: '/tmp/profer-session',
        platform: 'darwin' as const,
        snapshotRoot: root,
        processEnv: { PATH: '/usr/bin:/bin', SHELL: '/bin/bash', API_KEY: 'do-not-persist' },
        getLoginEnv: async () => ({ PATH: '/usr/bin:/bin', SHELL: '/bin/bash', BUN_VERSION: '1' }),
      }
      const first = await getOrCreateShellSnapshot(options)
      const second = await getOrCreateShellSnapshot(options)

      expect(first).toBeDefined()
      expect(second?.envHash).toBe(first?.envHash)
      expect(second?.id).toBe(first?.id)
      expect(second?.source).toBe('login-shell')
      const bashPath = second?.commandPaths.bash
      expect(bashPath === '/bin/bash' || bashPath === '/usr/bin/bash').toBe(true)
      expect(second?.env.API_KEY).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given rebuild is requested When the login environment changes Then a new hash and command path are captured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'profer-shell-snapshot-'))
    try {
      const first = await getOrCreateShellSnapshot({
        sessionId: 'session-2',
        cwd: '/tmp/profer-session',
        platform: 'darwin',
        snapshotRoot: root,
        processEnv: { PATH: '/usr/bin', SHELL: '/bin/bash' },
        getLoginEnv: async () => ({ PATH: '/usr/bin', SHELL: '/bin/bash' }),
      })
      const rebuilt = await getOrCreateShellSnapshot({
        sessionId: 'session-2',
        cwd: '/tmp/profer-session',
        platform: 'darwin',
        snapshotRoot: root,
        rebuild: true,
        processEnv: { PATH: '/usr/bin', SHELL: '/bin/bash' },
        getLoginEnv: async () => ({ PATH: '/usr/bin:/opt/homebrew/bin', SHELL: '/bin/bash' }),
      })

      expect(rebuilt?.envHash).not.toBe(first?.envHash)
      expect(rebuilt?.pathEntries).toContain('/opt/homebrew/bin')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Given credential-like environment keys When sanitizing Then secrets are excluded while shell metadata remains', () => {
    const env = sanitizeShellEnvironment({
      PATH: '/bin', SHELL: '/bin/bash', ANTHROPIC_API_KEY: 'secret', MY_PASSWORD: 'secret', SAFE_FLAG: '1',
    })
    expect(env).toEqual({ PATH: '/bin', SHELL: '/bin/bash', SAFE_FLAG: '1' })
  })

  test('Given a snapshot write failure When capturing Then execution can continue with an in-memory snapshot', async () => {
    const snapshot = await captureShellSnapshot({
      sessionId: 'session-3',
      cwd: '/tmp/profer-session',
      platform: 'darwin',
      snapshotRoot: join(tmpdir(), 'missing-parent', 'blocked'),
      persist: false,
      processEnv: { PATH: '/usr/bin', SHELL: '/bin/sh' },
      getLoginEnv: async () => ({ PATH: '/usr/bin', SHELL: '/bin/sh' }),
    })
    expect(snapshot.envHash).toHaveLength(64)
  })
})
