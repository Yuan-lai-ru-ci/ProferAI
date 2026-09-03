import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import type { CreateModelRuntimeOptions } from '@earendil-works/pi-coding-agent'

/**
 * Pi 0.84 的包只提供 ESM export；Electron main bundle 保持 CJS，因此不能在模块
 * 顶层导入其运行时的 InMemoryCredentialStore。这里保留同一 CredentialStore 契约，
 * 仅供 Profer 的默认隔离运行时使用，避免触碰全局 ~/.pi。
 */
export class IsolatedInMemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>()
  private readonly chains = new Map<string, Promise<void>>()

  async read(providerId: string): Promise<Credential | undefined> {
    return this.credentials.get(providerId)
  }

  async list(): Promise<readonly { providerId: string; type: Credential['type'] }[]> {
    return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }))
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(task)
    const tail = operation.then(() => {}, () => {})
    this.chains.set(providerId, tail)
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId)
    })
    return operation
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const current = this.credentials.get(providerId)
      const next = await fn(current)
      if (next !== undefined) this.credentials.set(providerId, next)
      return next ?? current
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      this.credentials.delete(providerId)
    })
  }
}

/**
 * 创建不读取或写入全局 ~/.pi 的 ModelRuntime 配置。
 * Profer 自行管理渠道凭据，因此 Pi 的凭据与模型缓存均只应存在于当前进程内。
 */
export function createIsolatedModelRuntimeOptions(
  credentials: CredentialStore = new IsolatedInMemoryCredentialStore(),
): CreateModelRuntimeOptions {
  return {
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  }
}
