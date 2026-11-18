/**
 * 本地调试 Core 启动器（临时）。
 * - 固定回环端口与持久化 token，方便桌面开发版反复添加/重连
 * - 默认开启 /debug/* 与合成 Agent 回复，不需要真实渠道
 * - 数据放在系统临时目录，可用 PROFER_DEV_CORE_DIR 指定
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startCore } from './index'

const dataDir = process.env.PROFER_DEV_CORE_DIR?.trim() || join(tmpdir(), 'profer-core-dev')
const port = process.env.PROFER_DEV_CORE_PORT?.trim() || '17791'
const tokenPath = join(dataDir, 'token')

mkdirSync(dataDir, { recursive: true })
let token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : ''
if (!token) {
  token = randomUUID()
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
}

process.env.PROFER_CONFIG_DIR = dataDir
process.env.PROFER_CORE_WORKSPACE_ROOT = join(dataDir, 'workspaces')
process.env.PROFER_CORE_LISTEN = `127.0.0.1:${port}`
process.env.PROFER_CORE_API_KEY = token
process.env.PROFER_CORE_DEBUG = '1'
process.env.PROFER_CORE_MOCK_AGENT ??= '1'

const mockAgent = process.env.PROFER_CORE_MOCK_AGENT === '1'
// 合成回复不依赖渠道，但桌面需要至少一个渠道/模型才能打开发送闸门。
// 仅在首次启动且没有渠道存储时写入一个假渠道，方便纯 UI 验收。
const seededChannel = mockAgent && process.env.PROFER_CORE_CHANNELS_JSON === undefined && !existsSync(join(dataDir, 'channels.enc.json'))
if (seededChannel) {
  process.env.PROFER_CORE_CHANNELS_JSON = JSON.stringify([{
    id: 'debug-mock',
    name: '调试合成模型',
    provider: 'anthropic',
    apiKey: 'mock',
    enabled: true,
    agentRuntimes: ['pi'],
    models: [{ id: 'mock-model', name: 'Mock Model', enabled: true }],
  }])
}

process.stdout.write([
  '[Core][dev] 本地调试内核',
  `[Core][dev] 地址: http://127.0.0.1:${port}`,
  `[Core][dev] Token: ${token}`,
  `[Core][dev] 数据目录: ${dataDir}`,
  `[Core][dev] 合成 Agent 回复: ${mockAgent ? '开启（不调用真实模型）' : '关闭（使用已配置渠道）'}`,
  ...(seededChannel ? ['[Core][dev] 已写入调试渠道：调试合成模型 / Mock Model'] : []),
  '',
  '桌面开发版操作：',
  '  1. bun run dev',
  '  2. 左下角 CPU 图标 → 添加远程内核',
  `  3. 地址填 http://127.0.0.1:${port}，Token 填上面的值`,
  '  4. 切换到该内核后新建工作区/会话，发送任意消息',
  '',
  `排查接口：GET /debug/state（Bearer Token），POST /debug/reset {"confirm":"reset"}`,
  '',
].join('\n'))

startCore().catch((error: unknown) => {
  console.error('[Core][dev] 启动失败', error)
  process.exitCode = 1
})
