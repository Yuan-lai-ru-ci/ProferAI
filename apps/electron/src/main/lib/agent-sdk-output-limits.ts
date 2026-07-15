import type { ProviderType } from '@proma/shared'

export function getAgentSdkMaxOutputTokens(provider: ProviderType): string {
  return provider === 'anthropic' ? '64000' : '32768'
}
