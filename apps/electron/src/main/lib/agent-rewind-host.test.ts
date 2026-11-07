import { afterEach, describe, expect, test } from 'bun:test'
import { setAgentRewindService } from './agent-rewind-gateway'
import { createElectronAgentRewindService } from './agent-rewind-host'
import { prepareAgentRewind } from './agent-rewind-gateway'

afterEach(() => setAgentRewindService(null))

describe('Electron agent rewind host', () => {
  test('constructs a service for bootstrap registration', () => {
    const service = createElectronAgentRewindService()
    expect(service).toBeDefined()
    setAgentRewindService(service)
  })
})
