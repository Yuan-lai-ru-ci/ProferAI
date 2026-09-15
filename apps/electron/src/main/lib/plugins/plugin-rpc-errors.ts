import type { ProferPluginErrorCode, ProferPluginRpcFailure } from '@profer/plugin-api'

export class PluginRpcError extends Error {
  readonly code: ProferPluginErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, string | number | boolean>

  constructor(code: ProferPluginErrorCode, message: string, retryable = false, details?: Record<string, string | number | boolean>) {
    super(message)
    this.name = 'PluginRpcError'
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

export function isPluginRpcError(error: unknown): error is PluginRpcError {
  return error instanceof PluginRpcError
}

export function toPluginRpcFailure(error: unknown): Omit<ProferPluginRpcFailure, 'requestId' | 'operation'> {
  if (isPluginRpcError(error)) {
    return {
      protocol: 'plugin-host.rpc.v1',
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details && { details: error.details }),
      },
    }
  }
  return {
    protocol: 'plugin-host.rpc.v1',
    ok: false,
    error: { code: 'PLUGIN_INTERNAL_ERROR', message: '插件宿主操作失败', retryable: false },
  }
}

export function pluginRpcErrorFromCode(code: ProferPluginErrorCode, message?: string): PluginRpcError {
  return new PluginRpcError(code, message ?? code, code === 'PLUGIN_REQUEST_TIMEOUT' || code === 'PLUGIN_HOST_NOT_READY')
}
