/**
 * ChatGPT (OpenAI Codex) OAuth 登录服务。
 *
 * 通过 Pi Coding Agent 的公开 ModelRuntime API 完成 OAuth，避免依赖已删除的
 * `@earendil-works/pi-ai/oauth` 兼容函数。凭据仅保存在内存 store，持久化仍由
 * Profer 的 channel-manager 负责。
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
 * Pi 的 ModelRuntime 只依赖 CredentialStore 的结构契约。使用内存实现，避免 Pi
 * 写入自己的配置目录；上层会在成功后将规范化凭据加密保存到 Profer 的渠道配置。
 */
function createEphemeralCredentialStore(initial?: OAuthCredential) {
  let credential = initial
  return {
    async read(_providerId: string): Promise<OAuthCredential | undefined> {
      return credential
    },
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
    async delete(_providerId: string): Promise<void> {
      credential = undefined
    },
  }
}

function normalizeCredentials(value: unknown): CodexOAuthCredentials {
  if (!value || typeof value !== 'object') {
    throw new Error('Pi OAuth 未返回有效凭据')
  }

  const credential = value as Partial<OAuthCredential>
  if (
    typeof credential.access !== 'string'
    || typeof credential.refresh !== 'string'
    || typeof credential.expires !== 'number'
  ) {
    throw new Error('Pi OAuth 返回的凭据缺少 access、refresh 或 expires')
  }

  return {
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    ...(typeof credential.accountId === 'string' && credential.accountId
      ? { accountId: credential.accountId }
      : {}),
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
 * Pi 的公开 OAuth API 由 ModelRuntime 承载；它会启动本地回调服务并完成 code 交换。
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
        // Codex 的固定入口是浏览器授权；其余输入会在 callback 成功时被取消。
        if (prompt.type === 'select') return 'browser'
        return new Promise<string>((_resolve, reject) => {
          const rejectCancelled = () => reject(new Error('登录已取消'))
          prompt.signal?.addEventListener('abort', rejectCancelled, { once: true })
          abort.signal.addEventListener('abort', rejectCancelled, { once: true })
        })
      },
      notify: (event) => {
        if (event.type === 'auth_url') {
          callbacks?.onAuthUrl?.(event.url)
          shell.openExternal(event.url).catch((err) => {
            console.error('[Codex OAuth] 打开浏览器失败:', err)
          })
        } else if (event.type === 'progress' || event.type === 'info') {
          console.log(`[Codex OAuth] ${event.message}`)
          callbacks?.onProgress?.(event.message)
        }
      },
    })
    return normalizeCredentials(credentials)
  } finally {
    if (activeLoginAbort === abort) {
      activeLoginAbort = undefined
    }
  }
}

/** 取消进行中的 Codex OAuth 登录流程（若有）。 */
export function cancelCodexOAuthLogin(): void {
  activeLoginAbort?.abort()
  activeLoginAbort = undefined
}

/** 使用 refresh token 刷新 Codex OAuth 凭据。 */
export async function refreshCodexOAuth(refreshToken: string): Promise<CodexOAuthCredentials> {
  const sdk = await loadPiSdk()
  const store = createEphemeralCredentialStore({
    type: 'oauth',
    access: '',
    refresh: refreshToken,
    expires: 0,
  })
  const runtime = await sdk.ModelRuntime.create({
    credentials: store,
    allowModelNetwork: false,
  })

  // getAuth() 走 provider 的标准 refresh 流程，并通过 store 原子更新凭据。
  await runtime.getAuth('openai-codex')
  return normalizeCredentials(await store.read('openai-codex'))
}
