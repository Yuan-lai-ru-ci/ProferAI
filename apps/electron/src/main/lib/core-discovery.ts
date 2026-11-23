import { createSocket } from 'node:dgram'
import { CORE_DISCOVERY_GROUP, CORE_DISCOVERY_PORT, parseCoreDiscoveryAdvertisement, type CoreConnectionPin, type CoreDiscoveryAdvertisement } from '@profer/shared'

/** 发现结果仅是候选；调用方仍须 TLS pin 校验及 /identity coreId 校验后更新目标。 */
export async function discoverPairedCore(input: { coreId: string; pin: CoreConnectionPin; timeoutMs?: number }): Promise<CoreDiscoveryAdvertisement | undefined> {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value?: CoreDiscoveryAdvertisement, error?: Error): void => {
      if (settled) return; settled = true; clearTimeout(timer)
      try { socket.close() } catch {}
      if (error) reject(error); else resolve(value)
    }
    const timer = setTimeout(() => finish(), input.timeoutMs ?? 2000)
    socket.once('error', error => finish(undefined, error))
    socket.on('message', data => {
      if (data.length > 8192) return
      const value = parseCoreDiscoveryAdvertisement(data.toString())
      if (value?.coreId === input.coreId && value.pin.algorithm === input.pin.algorithm && value.pin.value === input.pin.value) finish(value)
    })
    socket.bind(CORE_DISCOVERY_PORT, '0.0.0.0', () => {
      try {
        socket.addMembership(CORE_DISCOVERY_GROUP); socket.setMulticastTTL(1); socket.setMulticastLoopback(true)
        socket.send(JSON.stringify({ protocol: 'profer-core-discovery', version: 1, kind: 'query' }), CORE_DISCOVERY_PORT, CORE_DISCOVERY_GROUP)
      } catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))) }
    })
  })
}
