/**
 * Pi Host Harness feature gate.
 *
 * Harness is enabled by default for the next rollout so Pi sessions can be
 * tested without extra launch configuration. The process-local environment
 * override remains available as an emergency kill switch.
 */

import type { AgentRuntime } from '@profer/shared'

export const PI_HARNESS_FEATURE_ENV = 'PROFER_PI_HARNESS'

/**
 * Harness is on by default. Set PROFER_PI_HARNESS=0 to disable it for a
 * process; any other value keeps the default-on behavior.
 */
export function isPiHarnessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PI_HARNESS_FEATURE_ENV]?.trim() !== '0'
}

/**
 * Harness is Pi-only. Keeping the runtime check here prevents callers from
 * creating sidecar state for Claude sessions even while Pi Harness is default-on.
 */
export function shouldStartPiHarness(
  agentRuntime: AgentRuntime,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return agentRuntime === 'pi' && isPiHarnessEnabled(env)
}
