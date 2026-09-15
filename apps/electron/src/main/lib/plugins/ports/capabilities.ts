import type {
  PluginCapabilityDeclaration,
  PluginPresetCatalog,
  PluginPresetMetadata,
  PluginRequestContext,
  PluginRuntimeCapabilityView,
  PluginSecretMetadata,
  PluginSecretRef,
  PluginSessionMetadata,
} from '@profer/plugin-api'

/** Provider 只接收宿主已经绑定 owner/page 的上下文，不接收 renderer 或 SDK 对象。 */
export interface PluginProviderContext extends PluginRequestContext {}

export interface SessionProvider {
  list(input: { workspaceId: string }, context: PluginProviderContext): Promise<{ items: PluginSessionMetadata[]; revision: number }>
  get(input: { workspaceId: string; sessionId: string }, context: PluginProviderContext): Promise<PluginSessionMetadata>
  create(input: { workspaceId: string; presetId?: string; title?: string; runtime?: 'claude' | 'pi'; expectedRevision: number }, context: PluginProviderContext): Promise<PluginSessionMetadata>
  configure(input: { workspaceId: string; sessionId: string; title?: string; modelId?: string; expectedRevision: number }, context: PluginProviderContext): Promise<PluginSessionMetadata>
  requestPreset(input: { workspaceId: string; sessionId: string; presetId: string; expectedRevision: number }, context: PluginProviderContext): Promise<{ sessionId: string; presetId: string; effectiveFrom: 'next_turn'; revision: number; auditEventId: string }>
  cancel(input: { workspaceId: string; sessionId: string; expectedRevision: number }, context: PluginProviderContext): Promise<PluginSessionMetadata>
}

export interface PresetProvider {
  list(input: { workspaceId: string }, context: PluginProviderContext): Promise<PluginPresetCatalog>
  get(input: { workspaceId: string; presetId: string }, context: PluginProviderContext): Promise<PluginPresetMetadata>
}

export interface RuntimeCapabilityProvider {
  resolve(input: { workspaceId: string; sessionId?: string; declaration: PluginCapabilityDeclaration; runtime: 'claude' | 'pi' }, context: PluginProviderContext): Promise<PluginRuntimeCapabilityView>
  inject?(input: { workspaceId: string; sessionId?: string; declaration: PluginCapabilityDeclaration; runtime: 'claude' | 'pi'; expectedRevision: number }, context: PluginProviderContext): Promise<PluginRuntimeCapabilityView>
}

/** SecretProvider 永远不返回明文；runtime prepare 由宿主内部 adapter 完成。 */
export interface SecretProvider {
  listMetadata(input: { providerId?: string }, context: PluginProviderContext): Promise<{ items: PluginSecretMetadata[]; revision: number }>
  requestConfigure(input: { providerId: string; field: string; expectedRevision: number }, context: PluginProviderContext): Promise<PluginSecretRef>
  prepare?(input: { secretId: string; providerId: string; field: string }, context: PluginProviderContext): Promise<void>
}

export interface PluginCapabilityProviders {
  sessions?: SessionProvider
  presets?: PresetProvider
  runtime?: RuntimeCapabilityProvider
  secrets?: SecretProvider
}
