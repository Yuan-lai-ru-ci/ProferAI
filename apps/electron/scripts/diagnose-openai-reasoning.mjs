/**
 * OpenAI-compatible reasoning diagnostics.
 *
 * Sends a single streaming Chat Completions request matching Profer's OpenAI
 * compatibility transport and reports which public reasoning fields the relay
 * returns. It never writes secrets or response bodies to disk.
 *
 * Usage from apps/electron:
 *   $env:OPENAI_BASE_URL = 'https://gateway.example.com/v1'
 *   $env:OPENAI_API_KEY = '...'
 *   $env:OPENAI_MODEL = 'gpt-5.6-terra'
 *   bun run diagnose:openai-reasoning
 *
 * Optional:
 *   OPENAI_REASONING_EFFORT=max bun run diagnose:openai-reasoning
 *   bun run diagnose:openai-reasoning -- --responses
 */

const HELP = `
OpenAI-compatible reasoning diagnostics

Required environment variables:
  OPENAI_BASE_URL          Gateway root or full /chat/completions endpoint
  OPENAI_API_KEY           Gateway API key (never printed or persisted)
  OPENAI_MODEL             Model ID exposed by the gateway

Optional environment variables:
  OPENAI_REASONING_EFFORT  Reasoning level to send; default: max

Options:
  --responses              Also probe the optional /responses endpoint.
                            This makes a second request and may consume quota.
  --help                   Show this help.
`

const args = new Set(process.argv.slice(2))
if (args.has('--help')) {
  console.log(HELP.trim())
  process.exit(0)
}

const baseUrl = process.env.OPENAI_BASE_URL?.trim()
const apiKey = process.env.OPENAI_API_KEY?.trim()
const model = process.env.OPENAI_MODEL?.trim()
const effort = process.env.OPENAI_REASONING_EFFORT?.trim() || 'max'

const missing = [
  !baseUrl && 'OPENAI_BASE_URL',
  !apiKey && 'OPENAI_API_KEY',
  !model && 'OPENAI_MODEL',
].filter(Boolean)

if (missing.length > 0) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`)
  console.error('Run with --help for an example.')
  process.exit(1)
}

function resolveEndpoint(input, endpoint) {
  const url = new URL(input)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = url.pathname.replace(/\/(chat\/completions|responses)$/, '')
  url.pathname = `${url.pathname}/${endpoint}`.replace(/\/+/g, '/')
  return url.toString()
}

function redactHeaders(headers) {
  return Object.fromEntries(
    [...headers.entries()]
      .filter(([name]) => ['content-type', 'content-length', 'server', 'via', 'x-request-id', 'cf-ray'].includes(name.toLowerCase()))
      .map(([name, value]) => [name, value.slice(0, 160)]),
  )
}

function summarize(value, limit = 280) {
  if (typeof value !== 'string') return undefined
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function analyzeChatChunk(chunk, state) {
  const choice = chunk?.choices?.[0]
  const delta = choice?.delta
  if (!delta || typeof delta !== 'object') return

  for (const field of ['reasoning_content', 'reasoning', 'analysis', 'thinking']) {
    if (typeof delta[field] === 'string') {
      state.reasoningFields.add(`choices[0].delta.${field}`)
      state.reasoningChars += delta[field].length
      if (state.reasoningSamples.length < 3) state.reasoningSamples.push(summarize(delta[field]))
    }
  }
  if (typeof delta.content === 'string') {
    state.contentChars += delta.content.length
    if (state.contentSamples.length < 2) state.contentSamples.push(summarize(delta.content))
  }
  if (choice?.finish_reason) state.finishReason = choice.finish_reason
  if (chunk?.usage) state.usage = chunk.usage
}

async function readSse(response) {
  const state = {
    contentChars: 0,
    contentSamples: [],
    finishReason: undefined,
    malformedEvents: 0,
    reasoningChars: 0,
    reasoningFields: new Set(),
    reasoningSamples: [],
    usage: undefined,
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Gateway returned an empty streaming response body.')

  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  while (!done) {
    const { value, done: streamDone } = await reader.read()
    done = streamDone
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        analyzeChatChunk(JSON.parse(data), state)
      } catch {
        state.malformedEvents += 1
      }
    }
  }
  return {
    ...state,
    reasoningFields: [...state.reasoningFields],
  }
}

async function probeChatCompletions() {
  const endpoint = resolveEndpoint(baseUrl, 'chat/completions')
  const body = {
    model,
    messages: [{
      role: 'user',
      content: 'Do not call tools. Solve this carefully: among 12 identical coins, exactly one is counterfeit and may be heavier or lighter. With a balance scale and at most three weighings, give a complete strategy and briefly justify why three weighings are sufficient. Do not skip the balanced-first-weighing branch.',
    }],
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: effort,
  }

  console.log('\n=== Chat Completions probe ===')
  console.log(JSON.stringify({ endpoint, request: body }, null, 2))
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  console.log(`HTTP ${response.status} ${response.statusText}`)
  console.log('Response headers:', redactHeaders(response.headers))

  if (!response.ok) {
    const errorText = summarize(await response.text(), 800)
    console.log('Gateway error:', errorText || '(empty response)')
    return { ok: false }
  }

  const result = await readSse(response)
  console.log('Public reasoning fields:', result.reasoningFields.length ? result.reasoningFields : '(none)')
  console.log('Public reasoning characters:', result.reasoningChars)
  console.log('Public reasoning samples:', result.reasoningSamples.length ? result.reasoningSamples : '(none)')
  console.log('Answer characters:', result.contentChars)
  console.log('Answer samples:', result.contentSamples.length ? result.contentSamples : '(none)')
  console.log('Finish reason:', result.finishReason ?? '(not sent)')
  console.log('Usage:', result.usage ?? '(not sent)')
  if (result.malformedEvents > 0) console.log('Non-JSON SSE events ignored:', result.malformedEvents)
  return { ok: true, result }
}

async function probeResponses() {
  const endpoint = resolveEndpoint(baseUrl, 'responses')
  const body = {
    model,
    input: 'Reply with the number 8.',
    reasoning: { effort, summary: 'detailed' },
  }
  console.log('\n=== Optional Responses probe ===')
  console.log(JSON.stringify({ endpoint, request: body }, null, 2))
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  console.log(`HTTP ${response.status} ${response.statusText}`)
  console.log('Response headers:', redactHeaders(response.headers))
  const responseText = await response.text()
  if (!response.ok) {
    console.log('Gateway error:', summarize(responseText, 800) || '(empty response)')
    return
  }
  try {
    const payload = JSON.parse(responseText)
    const output = Array.isArray(payload.output) ? payload.output : []
    const outputTypes = output.map((item) => item?.type).filter(Boolean)
    const reasoningParts = output.filter((item) => item?.type === 'reasoning')
    const summary = reasoningParts.flatMap((item) => Array.isArray(item.summary) ? item.summary : [])
      .map((item) => summarize(item?.text)).filter(Boolean)
    console.log('Response output item types:', outputTypes)
    console.log('Responses reasoning item count:', reasoningParts.length)
    console.log('Responses public summary samples:', summary.length ? summary : '(none)')
  } catch {
    console.log('Non-JSON successful response sample:', summarize(responseText, 800) || '(empty response)')
  }
}

try {
  const chat = await probeChatCompletions()
  if (args.has('--responses')) await probeResponses()
  process.exit(chat.ok ? 0 : 1)
} catch (error) {
  console.error('Probe failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
