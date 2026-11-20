import type { CoreTargetSummary } from '@/types/settings'

interface ConnectionInput {
  name: string
  baseUrl: string
  token: string
}

interface ConnectionAPI {
  testCoreTarget(input: ConnectionInput): Promise<{ coreId: string }>
  addCoreTarget(input: ConnectionInput & { expectedCoreId: string }): Promise<unknown>
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}

export function validateCoreUrl(value: string): string {
  let url: URL | undefined
  try { url = new URL(value.trim()) } catch { /* 统一给出输入提示 */ }
  const validProtocol = url && (url.protocol === 'https:' || isLoopbackHttp(url))
  if (!url || !validProtocol || url.username || url.password || url.search || url.hash) {
    throw new Error('请输入 HTTPS 地址；内部测试版也允许本机隧道，例如 http://127.0.0.1:17788。')
  }
  return url.href.replace(/\/+$/, '')
}

export async function saveVerifiedConnection(
  api: ConnectionAPI,
  input: ConnectionInput,
  targets: readonly CoreTargetSummary[],
  confirmAdditionalEndpoint: (target: CoreTargetSummary) => Promise<boolean>,
): Promise<boolean> {
  const connection = { name: input.name.trim(), baseUrl: validateCoreUrl(input.baseUrl), token: input.token.trim() }
  const identity = await api.testCoreTarget(connection)
  const sameAddress = targets.find(target => target.kind === 'remote' &&
    (target.endpoints?.map(endpoint => endpoint.baseUrl) ?? [target.baseUrl]).some(address => {
      try { return address !== undefined && validateCoreUrl(address) === connection.baseUrl } catch { return false }
    }))
  if (sameAddress && sameAddress.coreId !== identity.coreId) {
    throw new Error('这个地址现在指向不同的 Core，不能替换已保存的内核。请为新的 Core 使用另一个地址，或先移除旧连接再单独添加。')
  }
  const sameCore = targets.find(target => target.kind === 'remote' && target.coreId === identity.coreId)
  if (sameAddress) throw new Error('这个地址已保存。若要更新 Token，请编辑该线路。')
  if (sameCore && !await confirmAdditionalEndpoint(sameCore)) return false
  await api.addCoreTarget({ ...connection, expectedCoreId: identity.coreId })
  return true
}
