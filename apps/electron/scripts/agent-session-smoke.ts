/**
 * Agent 会话端到端冒烟测试（真实 Electron 主进程 + 真实渠道）
 *
 * 默认进入候选渠道探测模式：默认渠道 key 若失效，依次尝试候选渠道，
 * 首个认证通过的渠道跑完整流程：
 * 1. 预设创建 → 绑定会话 → 运行时生效（真实 agent-preset-manager / orchestrator 链路）
 * 2. 会话内 preset 工具调用（严格解析 transcript 的 tool_use 块）
 *
 * 可选参数：
 *   --probe-only  只跑解密环境自检，不发起模型调用
 *   --claude      把 Claude runtime 候选排在前面
 *
 * 用法（apps/electron 目录下）：
 *   bunx esbuild scripts/agent-session-smoke.ts --bundle --platform=node --format=cjs \
 *     --outfile=scripts/.smoke/agent-session-smoke.cjs \
 *     --external:electron --external:@anthropic-ai/claude-agent-sdk \
 *     --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-agent-core \
 *     --external:@earendil-works/pi-ai
 *   .\node_modules\electron\dist\electron.exe --disable-gpu --no-sandbox scripts\.smoke\agent-session-smoke.cjs
 */

import { app, safeStorage } from 'electron'
import { getSettings } from '../src/main/lib/settings-service'
import { getAgentWorkspace } from '../src/main/lib/agent-workspace-manager'
import { createAgentSession, getAgentSessionMeta } from '../src/main/lib/agent-session-manager'
import { createAgentPreset, listAgentPresets, deleteAgentPreset, getAgentPreset } from '../src/main/lib/agent-preset-manager'
import { runAgentHeadless } from '../src/main/lib/agent-service'
import { readFileSync, existsSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ===== 文件日志：electron.exe 为 GUI 子系统，控制台输出不可见，全部落盘 =====
const LOG_FILE = join(__dirname, 'smoke.log')
try { writeFileSync(LOG_FILE, '') } catch { /* 目录不存在时忽略，下面 append 会兜底 */ }
function fileLog(line: string): void {
  try { appendFileSync(LOG_FILE, line + '\n') } catch { /* 日志失败不阻塞冒烟 */ }
}
const originalLog = console.log
const originalError = console.error
console.log = (...args: unknown[]) => { fileLog(args.map(String).join(' ')); originalLog(...args) }
console.error = (...args: unknown[]) => { fileLog(`[ERR] ${args.map(String).join(' ')}`); originalError(...args) }
process.on('exit', (code) => fileLog(`[冒烟] 进程退出 code=${code}`))

const OVERALL_TIMEOUT_MS = 8 * 60 * 1000

interface Candidate {
  label: string
  channelId: string
  runtime: 'claude' | 'pi'
  modelId: string
}

/** 默认渠道 key 失效时的候选（按概率排序：先 Pi 兼容的 deepseek/openai，最后 Claude runtime） */
const FALLBACK_CANDIDATES: Candidate[] = [
  { label: 'DeepSeek(已启用)', channelId: '17d5fd4c-4903-4c0a-8d82-d7ab24db871b', runtime: 'pi', modelId: 'deepseek-v4-flash' },
  { label: 'GPT(newapi-8)', channelId: 'newapi-8', runtime: 'pi', modelId: 'gpt-5.6-terra' },
  { label: 'GPT(newapi-5)', channelId: 'newapi-5', runtime: 'pi', modelId: 'gpt-5.6-terra' },
  { label: 'Claude(特价)', channelId: 'newapi-7', runtime: 'claude', modelId: 'claude-opus-4-8' },
]

/** 等待一次 headless 运行结束；把最终助手文本与错误带出来 */
function runTurn(input: Parameters<typeof runAgentHeadless>[0], label: string): Promise<{ finalText: string; error?: string }> {
  return new Promise((resolve) => {
    console.log(`\n[冒烟] ── ${label} 开始 ──`)
    runAgentHeadless(input, {
      source: 'bridge',
      onError: (error) => {
        console.log(`[冒烟] ${label} 错误: ${error}`)
        resolve({ finalText: '', error })
      },
      onComplete: (messages) => {
        const assistant = [...(messages ?? [])].reverse().find((m) => m.role === 'assistant')
        const finalText = extractFinalText(assistant)
        console.log(`[冒烟] ${label} 完成，最终回复 ${finalText.length} 字`)
        resolve({ finalText })
      },
      onTitleUpdated: (title) => {
        console.log(`[冒烟] ${label} 标题: ${title}`)
      },
    }).catch((err) => {
      console.log(`[冒烟] ${label} 异常:`, err instanceof Error ? err.message : String(err))
      resolve({ finalText: '', error: err instanceof Error ? err.message : String(err) })
    })
  })
}

function extractFinalText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const m = message as { content?: unknown }
  if (Array.isArray(m.content)) {
    return m.content
      .map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''))
      .join('')
  }
  return typeof m.content === 'string' ? m.content : ''
}

/** 严格统计 transcript 中的工具调用（解析 JSONL 的 tool_use 块，不靠子串） */
function countToolUses(transcript: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue
    let obj: unknown
    try { obj = JSON.parse(line) } catch { continue }
    const record = obj as { message?: { content?: unknown }; content?: unknown }
    const content = record.message?.content ?? record.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' || block.type === 'toolUse' || block.type === 'toolCall') {
        const name = block.name ?? block.tool_name ?? block.toolName
        if (typeof name === 'string') counts[name] = (counts[name] ?? 0) + 1
      }
    }
  }
  return counts
}

function readTranscript(sessionId: string): string {
  const meta = getAgentSessionMeta(sessionId)
  // Pi 会话 transcript 记在 piSessionFile；Claude 会话走 SDK JSONL
  const candidates = [meta?.piSessionFile, meta?.sdkSessionFile]
  for (const file of candidates) {
    if (file && existsSync(file)) return readFileSync(file, 'utf-8')
  }
  // 兜底：Pi transcript 目录 ~/.profer-dev/sdk-config/sessions/pi/，按 sdkSessionId 定位文件
  const piDir = join(app.getPath('home'), '.profer-dev', 'sdk-config', 'sessions', 'pi')
  try {
    if (meta?.sdkSessionId) {
      const exact = join(piDir, `${meta.sdkSessionId}.jsonl`)
      if (existsSync(exact)) return readFileSync(exact, 'utf-8')
      for (const name of readdirSync(piDir)) {
        if (!name.endsWith('.jsonl')) continue
        const content = readFileSync(join(piDir, name), 'utf-8')
        if (content.includes(meta.sdkSessionId)) return content
      }
    }
  } catch { /* 目录不存在等场景忽略 */ }
  return ''
}

const presetTurnPrompt = (runtime: 'claude' | 'pi'): string => {
  const list = runtime === 'pi' ? 'mcp__agent-presets__preset_list' : 'preset_list'
  const create = runtime === 'pi' ? 'mcp__agent-presets__preset_create' : 'preset_create'
  return `先调用 ${list} 列出当前全部预设；再调用 ${create} 创建一个名为「冒烟验证」的预设（description 写"端到端冒烟"）。完成后只回复：预设总数和新建预设的 id。`
}

async function main(): Promise<void> {
  // 关键：Electron 43 的 safeStorage 为 app-bound 加密（v10 头），必须与真实 dev 应用
  // 完全相同的身份才能解出渠道密钥/令牌，否则 decryptToken 静默回退"明文"（实为密文）→ 401：
  // - 启动 exe：必须用 .bun 规范路径（与 electronmon 启动的进程一致）
  // - appPath：apps/electron（本 bundle 放在 apps/electron 根下启动）
  // - app name：profer-dev（index.ts:64）
  // - userData：%APPDATA%\@profer\electron-dev（index.ts:12；注意需要 dev 应用先退出，避免 profile 单例锁冲突）
  app.setName('profer-dev')
  app.setPath('userData', join(app.getPath('appData'), '@profer/electron-dev'))
  await app.whenReady()
  console.log('[冒烟] Electron 就绪，配置目录为开发模式 ~/.profer-dev')

  // 密钥解密诊断：查清 app-bound 加密解不开的确切原因
  try {
    const selected = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.()
    console.log(`[冒烟] safeStorage 可用=${safeStorage.isEncryptionAvailable()} backend=${selected ?? '(api 无)'}`)
    console.log(`[冒烟] appPath=${app.getAppPath()}`)
    console.log(`[冒烟] userData=${app.getPath('userData')}`)
    console.log(`[冒烟] execPath=${process.execPath}`)
    // 往返自检：本实例加密→解密是否闭环
    try {
      const probe = safeStorage.encryptString('smoke-roundtrip-probe')
      const roundtrip = safeStorage.decryptString(probe)
      console.log(`[冒烟] 往返自检: ${roundtrip === 'smoke-roundtrip-probe' ? 'OK' : `FAIL(${roundtrip})`}`)
    } catch (err) {
      console.log(`[冒烟] 往返自检异常: ${err instanceof Error ? err.message : String(err)}`)
    }
    // 直接解密存量密文（默认渠道的 apiKey 字段）
    const { getChannelsPath } = await import('../src/main/lib/config-paths')
    const channelsRaw = JSON.parse(readFileSync(getChannelsPath(), 'utf-8')) as { channels?: Array<{ id: string; apiKey?: string }> }
    const stored = channelsRaw.channels?.find((c) => c.id === getSettings().agentChannelId)?.apiKey ?? ''
    console.log(`[冒烟] 存量密文长度=${stored.length} 前缀=${stored.slice(0, 8)}`)
    try {
      const decrypted = safeStorage.decryptString(Buffer.from(stored, 'base64'))
      console.log(`[冒烟] 存量密文直接解密: 成功, 长度=${decrypted.length}`)
    } catch (err) {
      console.log(`[冒烟] 存量密文直接解密失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  } catch (err) {
    console.log(`[冒烟] 解密诊断失败: ${err instanceof Error ? err.message : String(err)}`)
  }

  // --probe-only：只跑诊断，不发起任何模型调用
  if (process.argv.includes('--probe-only')) {
    console.log('[冒烟] probe-only 模式退出')
    app.exit(0)
    return
  }

  const settings = getSettings()
  const workspaceId = settings.agentWorkspaceId
  const workspaceSlug = workspaceId ? getAgentWorkspace(workspaceId)?.slug : undefined
  console.log(`[冒烟] 工作区=${workspaceSlug ?? '(无)'}，默认渠道=${settings.agentChannelId} 模型=${settings.agentModelId} runtime=${settings.agentRuntime}`)

  // 候选队列：默认渠道优先，失败后依次回退；--claude 强制 Claude runtime 候选前置
  const candidates: Candidate[] = [
    { label: `默认(${settings.agentChannelId})`, channelId: settings.agentChannelId, runtime: settings.agentRuntime ?? 'pi', modelId: settings.agentModelId },
    ...FALLBACK_CANDIDATES,
  ]
    .filter((c) => Boolean(c.channelId && c.modelId))
    .sort((a, b) => {
      if (!process.argv.includes('--claude')) return 0
      const aClaude = a.runtime === 'claude' ? 1 : 0
      const bClaude = b.runtime === 'claude' ? 1 : 0
      return bClaude - aClaude
    })

  // ① 用 manager 直接创建自定义预设（真实落盘链路）
  let smokePresetId: string | undefined
  if (workspaceSlug) {
    const preset = createAgentPreset(workspaceSlug, {
      name: '冒烟验证预设',
      description: '端到端冒烟测试用，验证后可删除',
      promptSections: ['## 冒烟测试模式\n\n当前会话处于冒烟测试。保持回复简洁，只做被要求的事。'],
      effort: 'medium',
    })
    smokePresetId = preset.id
    console.log(`[冒烟] 已创建预设: ${preset.name} (${preset.id})`)
  }

  // ①.5 派生预设合并自检（B2-2）：真实主进程走 manager 合并链路，无网络成本。
  // 取证：basePresetId 落盘 → getAgentPreset 合并（suppress/工具组并集 + 基座提示词段）→ 清理。
  let derivedMergeOk = false
  if (workspaceSlug) {
    try {
      const derived = createAgentPreset(workspaceSlug, {
        name: '冒烟派生预设',
        description: '基于极简派生的冒烟自检，验证后删除',
        basePresetId: 'minimal',
        disabledToolGroups: ['automation'],
      })
      const resolved = getAgentPreset(workspaceSlug, derived.id)
      derivedMergeOk = (resolved.suppressPromptSections ?? []).length === 4
        && (resolved.disabledToolGroups ?? []).length === 4
        && (resolved.promptSections?.some((s) => s.includes('极简模式')) ?? false)
      console.log(`[冒烟] 派生预设合并自检: ${derivedMergeOk ? '是 ✅' : '否 ❌'}（suppress=${resolved.suppressPromptSections?.join('/')}，工具组=${resolved.disabledToolGroups?.join('/')}）`)
      deleteAgentPreset(workspaceSlug, derived.id)
    } catch (err) {
      console.log(`[冒烟] 派生预设自检异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ①.6 单工具裁剪自检（B2-3）：真实主进程验证 Pi builtin tools 按 disabledTools 短名过滤，
  // 不发起模型调用（仅构建工具清单后丢弃）。
  let toolFilterOk = false
  try {
    const piSdk = await import('@earendil-works/pi-coding-agent')
    const { buildPiBuiltinTools: buildProbeTools } = await import('../src/main/lib/adapters/pi-builtin-tools')
    const probe = await buildProbeTools(piSdk, {
      sessionId: 'smoke-b2c3-probe',
      channelId: settings.agentChannelId,
      workspaceSlug,
      triggeredBy: 'user',
      disabledTools: ['proma_task_create'],
    })
    toolFilterOk = !probe.tools.some((t) => t.name === 'mcp__task-graph__proma_task_create')
      && probe.tools.some((t) => t.name === 'mcp__task-graph__proma_task_update')
    console.log(`[冒烟] 单工具裁剪自检: ${toolFilterOk ? '是 ✅' : '否 ❌'}（proma_task_create 被过滤，proma_task_update 保留）`)
  } catch (err) {
    console.log(`[冒烟] 单工具裁剪自检异常: ${err instanceof Error ? err.message : String(err)}`)
  }

  let working: Candidate | undefined
  let sessionId = ''
  let run1: { finalText: string; error?: string } | undefined
  const sessionIds: string[] = []

  // ② 逐候选探测：首个认证通过的渠道继续跑完整流程
  for (const candidate of candidates) {
    console.log(`\n[冒烟] ── 尝试候选: ${candidate.label}（${candidate.runtime}）──`)
    const session = createAgentSession('冒烟测试', candidate.channelId, workspaceId, candidate.modelId, candidate.runtime, false, smokePresetId)
    sessionIds.push(session.id)
    sessionId = session.id

    const baseInput = {
      sessionId: session.id,
      channelId: candidate.channelId,
      modelId: candidate.modelId,
      agentRuntime: candidate.runtime,
      workspaceId,
      permissionModeOverride: 'bypassPermissions' as const,
      triggeredBy: 'automation' as const,
    }

    run1 = await runTurn({ ...baseInput, userMessage: presetTurnPrompt(candidate.runtime) }, '第一轮（preset 工具）')
    // 成功判定以 onError 为准：headless 的 onComplete 消息里不一定含最终文本（deepseek 走 result 事件）
    const success = !run1.error
    if (!success) {
      console.log(`[冒烟] 候选 ${candidate.label} 失败（${run1.error ?? '无回复'}），尝试下一个`)
      continue
    }
    working = candidate
    console.log(`[冒烟] ✅ 候选 ${candidate.label} 运行成功（终端状态 completed）`)

    // ③ 工具调用证据（严格解析 transcript）
    const counts = countToolUses(readTranscript(session.id))
    const listName = candidate.runtime === 'pi' ? 'mcp__agent-presets__preset_list' : 'preset_list'
    const createName = candidate.runtime === 'pi' ? 'mcp__agent-presets__preset_create' : 'preset_create'
    console.log(`[冒烟] 第一轮工具调用统计: ${JSON.stringify(counts)}`)
    console.log(`[冒烟] 证据: ${listName}=${counts[listName] ?? 0} 次, ${createName}=${counts[createName] ?? 0} 次`)

    break
  }

  // ⑤ 结果汇总 + 清理
  console.log('\n[冒烟] ═══ 结果汇总 ═══')
  const session = sessionId ? getAgentSessionMeta(sessionId) : undefined
  console.log(`[冒烟] 生效渠道: ${working?.label ?? '（全部失败）'}`)
  console.log(`[冒烟] 会话: ${sessionId || '（无）'}`)
  console.log(`[冒烟] 会话 meta.presetId: ${session?.presetId ?? '（无）'}`)
  console.log(`[冒烟] 工作区预设: ${listAgentPresets(workspaceSlug).map((p) => p.name).join(' / ')}`)
  if (run1) {
    console.log(`[冒烟] ── 第一轮最终回复（前 400 字）──\n${run1.finalText.slice(0, 400)}`)
    if (run1.error) console.log(`[冒烟] 第一轮错误: ${run1.error}`)
  }

  // 清理：删掉冒烟创建的预设（会话保留，可在应用内查看）
  const agentCreated = listAgentPresets(workspaceSlug).filter((p) => p.name === '冒烟验证')
  for (const preset of agentCreated) {
    deleteAgentPreset(workspaceSlug, preset.id)
  }
  if (agentCreated.length > 0) console.log(`[冒烟] 已清理会话内创建的预设「冒烟验证」×${agentCreated.length}`)
  if (smokePresetId) {
    try {
      deleteAgentPreset(workspaceSlug, smokePresetId)
      console.log('[冒烟] 已清理预设「冒烟验证预设」')
    } catch { /* 已被删除则忽略 */ }
  }
  console.log(`[冒烟] 本次创建的会话: ${sessionIds.join(', ') || '无'}`)

  // 无工作区时跳过派生/单工具自检（视为通过）；有工作区则必须取证成功。
  const presetChecksOk = !workspaceSlug || (derivedMergeOk && toolFilterOk)
  const ok = Boolean(working && run1 && !run1.error && presetChecksOk)
  console.log(`[冒烟] 派生合并/单工具裁剪自检计入判定: ${presetChecksOk ? '是' : '否'}`)
  console.log(`[冒烟] ═══ 判定: ${ok ? 'PASS ✅' : 'FAIL ❌'} ═══`)
  app.exit(ok ? 0 : 1)
}

const watchdog = setTimeout(() => {
  console.error('[冒烟] 超时，强制退出')
  app.exit(2)
}, OVERALL_TIMEOUT_MS)

main().catch((err) => {
  console.error('[冒烟] 失败:', err)
  clearTimeout(watchdog)
  app.exit(1)
})
