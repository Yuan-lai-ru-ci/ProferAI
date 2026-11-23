import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { inferAgentRuntimeModes, PROVIDER_CAPABILITIES, PROVIDER_DEFAULT_URLS, type Channel, type ProviderType } from '@profer/shared'
import { strFlag, type ParsedArgs } from '../args'
import { connectLocalCore } from '../local-core'
import { emitJson, emitText, EXIT_OK, info, UsageError } from '../output'
import { register } from '../registry'

type ChannelSummary = Pick<Channel, 'id' | 'name' | 'provider' | 'models' | 'enabled' | 'agentRuntimes' | 'credentialMode'>
const summaries = {
  list: ['channel list', '查看 Core 的可用模型渠道（不显示密钥）'],
  add: ['channel add --name NAME --provider PROVIDER --model MODEL [--base-url URL]', '在 Core 保存自带 API Key 和模型（隐藏提示或 stdin）'],
  'rotate-key': ['channel rotate-key ID', '替换指定 Core 渠道的 API Key（隐藏提示或 stdin）'],
} as const
const MAX_KEY_BYTES = 8192

async function readApiKey(): Promise<string> {
  let raw = ''
  if (process.stdin.isTTY) {
    // readline 接管 TTY 的回显与恢复；输入字符只写到丢弃输出，不进终端或日志。
    const sink = new Writable({ write(_chunk, _encoding, done) { done() } })
    const input = createInterface({ input: process.stdin, output: sink, terminal: true })
    try {
      process.stderr.write('API Key（输入隐藏）：')
      raw = await new Promise<string>(resolve => {
        input.once('close', () => resolve(''))
        input.once('SIGINT', () => input.close())
        input.question('', resolve)
      })
    } finally { input.close(); sink.end(); process.stderr.write('\n') }
  } else {
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_KEY_BYTES) throw new UsageError('API Key 输入过长')
      chunks.push(buffer)
    }
    raw = Buffer.concat(chunks).toString('utf8')
  }
  const key = raw.trim()
  if (!key || /[\r\n\x00]/.test(key) || Buffer.byteLength(key) > MAX_KEY_BYTES) throw new UsageError('请通过标准输入提供一行 API Key，不要把密钥写入命令参数')
  // 旧 Codex/xAI OAuth 在渠道存储里是 JSON 对象，不把它当作一行 API Key 导入。
  if (key.startsWith('{')) {
    throw new UsageError('此命令只支持 API Key，不接收 OAuth 凭据')
  }
  return key
}

function requiredFlag(args: ParsedArgs, flag: string): string {
  const value = strFlag(args.flags, flag)?.trim()
  if (!value) throw new UsageError(`请提供 --${flag}`)
  return value
}

function addInput(args: ParsedArgs) {
  const name = requiredFlag(args, 'name')
  const provider = requiredFlag(args, 'provider') as ProviderType
  if (!Object.hasOwn(PROVIDER_CAPABILITIES, provider)) throw new UsageError('未知模型供应商')
  if (PROVIDER_CAPABILITIES[provider].catalogKind === 'oauth-builtin') throw new UsageError('此供应商使用 OAuth，不能以 API Key 配置')
  const model = requiredFlag(args, 'model')
  const baseUrl = Object.hasOwn(args.flags, 'base-url') ? requiredFlag(args, 'base-url') : PROVIDER_DEFAULT_URLS[provider]
  try {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
  } catch { throw new UsageError('请提供有效的 HTTP(S) --base-url，不要把凭据放进地址') }
  // 终端创建的是 Agent 渠道，xAI API Key 明确启用对应的 Pi 能力。
  const agentExperimentalEnabled = provider === 'xai'
  return { name, provider, baseUrl, credentialMode: 'api-key', agentExperimentalEnabled,
    agentRuntimes: inferAgentRuntimeModes({ provider, agentExperimentalEnabled }), models: [{ id: model, name: model, enabled: true }], enabled: true }
}

// 输出只选取必要字段；即使未来服务端响应扩展，也不透传凭据或可嵌入凭据的地址。
function describeChannel({ id, name, provider, models, enabled, agentRuntimes }: ChannelSummary) {
  return { id, name, provider, models: models.map(({ id, name, enabled }) => ({ id, name, enabled })), enabled, agentRuntimes }
}

for (const name of ['list', 'add', 'rotate-key'] as const) {
  const [usage, summary] = summaries[name]
  register({ namespace: 'channel', name, summary, usage: `${usage} [--config-dir DIR] [--json]`, async run({ args, pathOpts, json }) {
    if (args.flags.help === true || args.positionals.length === 1 && args.positionals[0] === '-h') {
      emitText(`用法: profer ${usage} [--config-dir DIR] [--json]`)
      return EXIT_OK
    }
    const allowed = ['config-dir', 'dev', 'json', ...(name === 'add' ? ['name', 'provider', 'model', 'base-url'] : [])]
    if (Object.keys(args.flags).some(flag => !allowed.includes(flag))) throw new UsageError('不支持的参数；请勿把 API Key 写入命令参数')
    if (args.positionals.length !== (name === 'rotate-key' ? 1 : 0)) throw new UsageError('位置参数不正确')
    if (Object.hasOwn(args.flags, 'config-dir')) requiredFlag(args, 'config-dir')
    const input = name === 'add' ? addInput(args) : undefined
    const core = await connectLocalCore(pathOpts, { autoStart: true })
    const list = () => core.json<{ channels: ChannelSummary[] }>('/channels')
    if (name === 'list') {
      const { channels } = await list()
      if (json) emitJson(channels.map(describeChannel))
      else if (!channels.length) info('尚未配置模型。使用 profer channel add 添加渠道。')
      else for (const channel of channels) emitText(`${channel.id}  ${channel.name}  (${channel.provider})  ${channel.models.map(model => model.id).join(', ')}`)
      return EXIT_OK
    }
    const id = args.positionals[0]
    const selected = input ?? (await list()).channels.find(channel => channel.id === id)
    if (!selected) throw new Error('Core 上没有该渠道')
    if (selected.credentialMode === 'oauth' || selected.provider === 'openai-codex') throw new UsageError('此渠道使用 OAuth，不能替换为 API Key')
    const apiKey = await readApiKey()
    let channel: ChannelSummary
    try {
      const response = await core.request(input ? '/channels' : `/channels/${encodeURIComponent(id!)}`, {
        method: input ? 'POST' : 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, apiKey }), signal: AbortSignal.timeout(5000),
      })
      channel = await response.json() as ChannelSummary
    } catch { throw new Error('Core 未确认保存模型配置；请先查询渠道状态再重试') }
    if (json) emitJson(describeChannel(channel))
    else emitText(`${input ? '已添加 Core 渠道' : '已更新 Core 渠道的 API Key'}：${channel.id}`)
    return EXIT_OK
  } })
}
