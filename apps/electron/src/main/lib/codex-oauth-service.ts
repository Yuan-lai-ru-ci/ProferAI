/**
 * ChatGPT (OpenAI Codex) OAuth 登录服务。
 *
 * Pi 0.80.9 将 OAuth 交互收敛到 ModelRuntime。本服务只负责一次登录或刷新，
 * 完整凭据仍由 channel-manager 加密持久化，避免 Pi 写入全局 ~/.pi 配置。
 */

import { shell } from 'electron'
import type { CodexOAuthCredentials } from '@profer/shared'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

type OAuthCredential = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  [key: string]: unknown
}

let piSdkPromise: Promise<PiSdk> | undefined

function loadPiSdk(): Promise<PiSdk> {
  piSdkPromise ??= import('@earendil-works/pi-coding-agent')
  return piSdkPromise
}

/**
 * ModelRuntime 仅需要 CredentialStore 结构。此 store 在本次操作结束后释放，
 * 不读取或写入 Pi 的认证文件。
 */
function createEphemeralCredentialStore(initial?: OAuthCredential) {
  let credential = initial
  return {
    async read(): Promise<OAuthCredential | undefined> { return credential },
    async list(): Promise<readonly { providerId: string; type: 'oauth' }[]> {
      return credential ? [{ providerId: 'openai-codex', type: 'oauth' }] : []
    },
    async modify(
      _providerId: string,
      fn: (current: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>,
    ): Promise<OAuthCredential | undefined> {
      credential = await fn(credential)
      return credential
    },
    async delete(): Promise<void> { credential = undefined },
  }
}

function normalizeCredentials(value: unknown): CodexOAuthCredentials {
  if (!value || typeof value !== 'object') throw new Error('Pi OAuth 未返回有效凭据')
  const credential = value as Partial<OAuthCredential>
  if (typeof credential.access !== 'string' || typeof credential.refresh !== 'string' || typeof credential.expires !== 'number') {
    throw new Error('Pi OAuth 返回的凭据缺少 access、refresh 或 expires')
  }
  return {
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    ...(typeof credential.accountId === 'string' && credential.accountId ? { accountId: credential.accountId } : {}),
  }
}

/** 进行中的登录流程的取消控制器（同一时刻只允许一个登录流程）。 */
let activeLoginAbort: AbortController | undefined

export interface CodexLoginCallbacks {
  /** SDK 生成授权 URL 后回调，用于通知渲染层展示 URL。 */
  onAuthUrl?: (url: string) => void
  /** 进度消息回调。 */
  onProgress?: (message: string) => void
}

/**
 * 发起一次 ChatGPT (Codex) 浏览器 OAuth 登录。
 *
 * 注意：0.80.9 的公开 OAuth API 没有 request-local fetch 注入；OAuth proxy
 * 适配属于后续切片，本次不恢复旧 patch 的全局代理改写。
 */
export async function loginCodexOAuth(callbacks?: CodexLoginCallbacks): Promise<CodexOAuthCredentials> {
  const sdk = await loadPiSdk()

  activeLoginAbort?.abort()
  const abort = new AbortController()
  activeLoginAbort = abort

  try {
    const runtime = await sdk.ModelRuntime.create({
      credentials: createEphemeralCredentialStore(),
      allowModelNetwork: false,
    })
    const credentials = await runtime.login('openai-codex', 'oauth', {
      signal: abort.signal,
      prompt: async (prompt) => {
        // Profer 固定使用浏览器授权；回调服务会处理 authorization code。
        if (prompt.type === 'select') return 'browser'
        return new Promise<string>((_resolve, reject) => {
          prompt.signal?.addEventListener('abort', () => reject(new Error('登录已取消')), { once: true })
          abort.signal.addEventListener('abort', () => reject(new Error('登录已取消')), { once: true })
        })
      },
      notify: (event) => {
        if (event.type === 'auth_url') {
          callbacks?.onAuthUrl?.(event.url)
          shell.openExternal(event.url).catch((error) => console.error('[Codex OAuth] 打开浏览器失败:', error))
        } else if (event.type === 'progress' || event.type === 'info') {
          console.log(`[Codex OAuth] ${event.message}`)
          callbacks?.onProgress?.(event.message)
        }
      },
    })
    return normalizeCredentials(credentials)
  } finally {
    if (activeLoginAbort === abort) activeLoginAbort = undefined
  }
}

/** 取消进行中的 Codex OAuth 登录流程（若有）。 */
export function cancelCodexOAuthLogin(): void {
  activeLoginAbort?.abort()
  activeLoginAbort = undefined
}

/**
 * 用 refresh token 刷新 Codex OAuth 凭据。
 *
 * getAuth() 调用 Pi 的标准 refresh 流程并经内存 store 原子写回新凭据。
 */
export async function refreshCodexOAuth(refreshToken: string): Promise<CodexOAuthCredentials> {
  const sdk = await loadPiSdk()
  const store = createEphemeralCredentialStore({
    type: 'oauth',
    access: '',
    refresh: refreshToken,
    expires: 0,
  })
  const runtime = await sdk.ModelRuntime.create({ credentials: store, allowModelNetwork: false })
  await runtime.getAuth('openai-codex')
  return normalizeCredentials(await store.read())
}
