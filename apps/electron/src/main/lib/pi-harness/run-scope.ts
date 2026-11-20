import { createPiHarnessRunScope as createScope } from '@profer/agent-provider-pi/harness/run-scope'
import { loadHarnessGraphSnapshot } from '../project-graph-service'
import { appendPiHarnessEvent, loadPiHarnessSnapshot } from './pi-harness-store'
export type { PiHarnessRunScope } from '@profer/agent-provider-pi/harness/run-scope'

export function createPiHarnessRunScope(options: Parameters<typeof createScope>[0]) {
  return createScope(options, { appendPiHarnessEvent, loadPiHarnessSnapshot, loadHarnessGraphSnapshot })
}
