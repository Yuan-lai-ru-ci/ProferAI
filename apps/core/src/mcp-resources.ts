import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isEffectiveAgentPresetMcpServerAllowed } from '@profer/shared'
import type { EffectiveAgentPresetPolicy } from '@profer/shared'
import type { PiMcpServers } from '@profer/agent-provider-pi/pi/mcp-tools'

function read(path: string): PiMcpServers {
  if (!existsSync(path)) return {}
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || !('servers' in value) || !value.servers || typeof value.servers !== 'object' || Array.isArray(value.servers)) throw new Error('Core MCP配置servers格式错误')
  const servers = value.servers as PiMcpServers
  if (Object.values(servers).some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error('Core MCP条目无效')
  return servers
}

/** 只读所属Core工作区配置，project本机覆盖层不回写；不扫描桌面或其他Core。 */
export function loadCoreMcpServers(configDir: string | undefined, project: boolean, policy: EffectiveAgentPresetPolicy): PiMcpServers {
  if (policy.allowedMcpServerNames?.length === 0) return {}
  if (!configDir) {
    if (policy.allowedMcpServerNames?.length) throw new Error('Core所需MCP缺少所属工作区')
    return {}
  }
  const base = read(join(configDir, 'mcp.json'))
  const local = project ? read(join(configDir, 'mcp.local.json')) : {}
  const merged = { ...base }
  for (const [name, entry] of Object.entries(local)) merged[name] = { ...base[name], ...entry,
    env: { ...(base[name]?.env as object ?? {}), ...(entry.env as object ?? {}) },
    headers: { ...(base[name]?.headers as object ?? {}), ...(entry.headers as object ?? {}) },
  }
  const selected: PiMcpServers = {}
  for (const [name, entry] of Object.entries(merged)) {
    if (!isEffectiveAgentPresetMcpServerAllowed(policy, name) || entry.enabled === false) continue
    if (name === 'planning' || name === 'goal') throw new Error('用户MCP不能覆盖Core内置控制服务器')
    const { enabled: _enabled, isBuiltin: _builtin, ...transport } = entry
    const type = transport.type ?? (transport.command ? 'stdio' : transport.url ? 'http' : undefined)
    if (!['stdio', 'http', 'sse'].includes(String(type))) throw new Error('Core MCP transport不支持')
    selected[name] = { ...transport, type }
  }
  if (policy.allowedMcpServerNames?.some(name => !Object.hasOwn(selected, name))) throw new Error('Core预设所需MCP不存在、禁用或不可用')
  return selected
}
