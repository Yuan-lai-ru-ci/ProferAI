/**
 * Mock Relay — 模拟 New API 中继站，用于本地测试全链路
 *
 * 启动: node scripts/mock-relay.js
 * 端口: 3080
 *
 * 支持端点:
 *   POST /v1/chat/completions  (OpenAI 格式, stream + non-stream)
 *   POST /v1/messages           (Anthropic 格式, stream + non-stream)
 */
import { createServer } from 'node:http'

const PORT = 3080

function randomId() {
  return 'chatcmpl-' + Math.random().toString(36).slice(2, 14)
}

function now() {
  return Math.floor(Date.now() / 1000)
}

// ---- OpenAI Chat Completions 格式 ----
function buildOpenAIResponse(body, stream) {
  const model = body?.model || 'gpt-5-mini'
  const content = `你好！我是 ${model} 的模拟响应。你的问题是关于"${(body?.messages?.slice(-1)[0]?.content || 'test').slice(0, 40)}"的。这是一个 mock relay 返回的测试数据。`
  const promptTokens = 120
  const completionTokens = 80
  const id = randomId()

  if (stream) {
    // SSE 流式响应
    const chunks = []
    const words = content.split('')
    for (let i = 0; i < words.length; i++) {
      const delta = { content: words[i] }
      if (i === 0) delta.role = 'assistant'
      chunks.push({
        id,
        object: 'chat.completion.chunk',
        created: now(),
        model,
        choices: [{ index: 0, delta, finish_reason: i === words.length - 1 ? 'stop' : null }],
      })
    }
    // 最后一条带 usage（配合 stream_options.include_usage）
    chunks[chunks.length - 1].usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: 20 },
    }
    const sseChunks = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`)
    sseChunks.push('data: [DONE]\n\n')
    return { type: 'stream', contentType: 'text/event-stream', body: '', chunks: sseChunks }
  }

  return {
    type: 'json',
    contentType: 'application/json',
    body: JSON.stringify({
      id,
      object: 'chat.completion',
      created: now(),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    }),
  }
}

// ---- Anthropic Messages 格式 ----
function buildAnthropicResponse(body, stream) {
  const model = body?.model || 'claude-sonnet-4-5-20250929'
  const content = `Hello! I'm a mock ${model} response. This is test data from mock relay.`
  const id = 'msg_' + Math.random().toString(36).slice(2, 14)

  if (stream) {
    // SSE 流式响应 (Anthropic 格式)
    const events = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]
    return { type: 'stream', contentType: 'text/event-stream', body: '', chunks: events }
  }

  return {
    type: 'json',
    contentType: 'application/json',
    body: JSON.stringify({
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
      },
    }),
  }
}

// ---- Server ----
createServer((req, res) => {
  // 收集 body
  let raw = ''
  req.on('data', d => { raw += d })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch {}

    const isStream = body?.stream === true
    const url = req.url || ''

    let result
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      result = buildOpenAIResponse(body, isStream)
    } else if ((url === '/v1/messages' || url === '/messages') && req.method === 'POST') {
      result = buildAnthropicResponse(body, isStream)
    } else if (url === '/health') {
      res.writeHead(200).end(JSON.stringify({ status: 'ok' }))
      return
    } else {
      res.writeHead(404).end(JSON.stringify({ error: 'not found', path: url }))
      return
    }

    if (result.chunks) {
      // 流式：逐块发送，模拟真实 LLM 延迟
      res.writeHead(200, {
        'Content-Type': result.contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      })
      let i = 0
      function next() {
        if (i >= result.chunks.length) {
          res.end()
          return
        }
        res.write(result.chunks[i])
        i++
        setTimeout(next, 30 + Math.random() * 20)
      }
      next()
    } else {
      res.writeHead(200, {
        'Content-Type': result.contentType,
        'Access-Control-Allow-Origin': '*',
      })
      res.end(result.body)
    }

    console.log(`[mock-relay] ${url} stream=${isStream} model=${body?.model || 'unknown'} → ${result.type}`)
  })
}).listen(PORT, () => {
  console.log(`[mock-relay] 已启动: http://localhost:${PORT}`)
  console.log(`  端点: POST /v1/chat/completions (OpenAI)`)
  console.log(`        POST /v1/messages (Anthropic)`)
})
