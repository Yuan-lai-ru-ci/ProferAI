/**
 * WebUI 静态托管层的行为测试。
 * 只 mock 设置读取，其余走真实的路由判定与文件读取，验证「默认 0 个网页」这条安全边界。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let settings: Record<string, unknown> = {}

mock.module('./settings-service', () => ({ getSettings: () => settings }))

const { handleWebuiHttpRequest } = await import('./webui-service')

type FakeResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
  writeHead: (status: number, headers: Record<string, string>) => void
  end: (body: unknown) => void
}

function makeResponse(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(body) { this.body = typeof body === 'string' ? body : String(body) },
  }
  return res
}

function request(
  url: string,
  authorized = true,
  headers: Record<string, string> = {},
  sessionTitle?: (sessionId: string) => string | undefined,
  isSessionServable?: (sessionId: string) => boolean,
): { handled: boolean; res: FakeResponse } {
  const res = makeResponse()
  const handled = handleWebuiHttpRequest(
    { url, headers } as never,
    res as never,
    {
      isAuthorized: () => authorized,
      token: 'test-token',
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(isSessionServable ? { isSessionServable } : {}),
    },
  )
  return { handled, res }
}

let assetDir: string

beforeAll(() => {
  assetDir = mkdtempSync(join(tmpdir(), 'profer-webui-'))
  mkdirSync(join(assetDir, 'assets'))
  writeFileSync(join(assetDir, 'index.html'), '<!doctype html><html><head><title>Profer 会话</title></head><body><div id="root"></div></body></html>')
  writeFileSync(join(assetDir, 'assets', 'app.js'), 'console.log("webui")')
  process.env.PROFER_WEBUI_DIR = assetDir
})

afterAll(() => {
  delete process.env.PROFER_WEBUI_DIR
  rmSync(assetDir, { recursive: true, force: true })
})

describe('WebUI 静态托管', () => {
  test('Given 开关关闭 When 访问已发布会话 Then 404（默认 0 个网页）', () => {
    settings = { webuiEnabled: false, webuiPublishedSessionIds: ['s1'] }
    const { handled, res } = request('/s/s1?token=test-token')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
  })

  test('Given 开关开启且会话已发布 When 访问该会话 Then 返回注入了 boot 的页面', () => {
    settings = { webuiEnabled: true, webuiBindHost: '127.0.0.1', webuiPublishedSessionIds: ['s1'] }
    const { handled, res } = request('/s/s1?token=test-token')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('window.__PROFER_WEBUI_BOOT__')
    expect(res.body).toContain('"sessionId":"s1"')
    expect(res.body).toContain('"token":"test-token"')
    expect(res.headers['set-cookie']).toContain('profer_webui_token=test-token')
  })

  test('Given 会话有标题 When 首屏返回 Then <title> 直接就是会话名（不必等 WS 连上）', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s1?token=test-token', true, {}, () => '把构建修好')
    expect(res.body).toContain('<title>把构建修好</title>')
    expect(res.body).not.toContain('<title>Profer 会话</title>')
  })

  test('Given 会话还没标题 When 首屏返回 Then 保留兜底文案，不注入空 <title>', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s1?token=test-token', true, {}, () => undefined)
    expect(res.body).toContain('<title>Profer 会话</title>')
  })

  test('Given 标题里有 HTML When 首屏返回 Then 转义，不允许往页面里塞标签', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s1?token=test-token', true, {}, () => '<img src=x onerror=alert(1)> & co')
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; co')
    expect(res.body).not.toContain('<img src=x')
  })

  test('Given 会话在要停用名单里（已归档/已删除） When 访问 Then 404 且不注入 boot', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s1?token=test-token', true, {}, undefined, () => false)
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('已停止发布')
    expect(res.body).not.toContain('__PROFER_WEBUI_BOOT__')
  })

  test('Given 会话仍可服务 When 访问 Then 正常返回页面', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s1?token=test-token', true, {}, undefined, () => true)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('__PROFER_WEBUI_BOOT__')
  })

  test('Given 会话未发布 When 访问 Then 404，且不会泄漏页面内容', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s2?token=test-token')
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('__PROFER_WEBUI_BOOT__')
  })

  test('Given 凭据无效 When 访问 Then 401', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s1', false)
    expect(res.statusCode).toBe(401)
  })

  test('Given 静态资源存在 When 请求 /webui/assets/* Then 返回正确内容与类型', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { handled, res } = request('/webui/assets/app.js?token=test-token')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('console.log("webui")')
    expect(res.headers['content-type']).toContain('text/javascript')
  })

  test('Given 浏览器加载静态资源（不带 token） When 请求 Then 仍可访问', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/webui/assets/app.js', false)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('console.log("webui")')
  })

  test('Given 首屏抹掉 URL token 只带 cookie When 刷新会话页 Then 仍可访问', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s1', false, { cookie: 'profer_webui_token=test-token' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('"sessionId":"s1"')
  })

  test('Given cookie 中的凭据不匹配 When 访问会话页 Then 401', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/s/s1', false, { cookie: 'profer_webui_token=wrong' })
    expect(res.statusCode).toBe(401)
  })

  test('Given 目录穿越路径 When 请求 Then 拒绝', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    const { res } = request('/webui/../secret.json?token=test-token')
    expect(res.statusCode).toBe(404)
  })

  test('Given 非 WebUI 路径 When 请求 Then 交回原服务处理', () => {
    settings = { webuiEnabled: true, webuiPublishedSessionIds: ['s1'] }
    expect(request('/health').handled).toBe(false)
    expect(request('/ws').handled).toBe(false)
  })
})
