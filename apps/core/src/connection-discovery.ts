import { createSocket, type Socket } from 'node:dgram'
import { CORE_DISCOVERY_GROUP, CORE_DISCOVERY_PORT, type CoreConnectionState, type CoreDiscoveryAdvertisement } from '@profer/shared'

/** 固定发现端口复用；查询与周期广告均多播，多个 Core/客户端共享端口。 */
export class CoreDiscoveryPublisher {
  private socket?: Socket
  private timer?: ReturnType<typeof setInterval>
  constructor(private state: () => CoreConnectionState) {}
  async start(): Promise<void> {
    const socket = createSocket({ type: 'udp4', reuseAddr: true }); this.socket = socket
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(CORE_DISCOVERY_PORT, '0.0.0.0', () => { socket.off('error', reject); resolve() }) })
    socket.on('error', error => console.warn('[Core] 局域网发现错误', error.message))
    socket.addMembership(CORE_DISCOVERY_GROUP); socket.setMulticastTTL(1); socket.setMulticastLoopback(true)
    let lastQuery = 0
    socket.on('message', data => {
      if (data.length > 256 || Date.now() - lastQuery < 250) return
      try { const query = JSON.parse(data.toString()) as { protocol?: string; version?: number; kind?: string }; if (query.protocol === 'profer-core-discovery' && query.version === 1 && query.kind === 'query') { lastQuery = Date.now(); this.advertise() } } catch {}
    })
    this.advertise(); this.timer = setInterval(() => this.advertise(), 5000); this.timer.unref(); socket.unref()
  }
  advertise(): void {
    const state = this.state()
    const advertisement: CoreDiscoveryAdvertisement = { protocol: 'profer-core-discovery', version: 1, kind: 'advertisement', coreId: state.coreId, endpoints: state.endpoints, pin: state.pin }
    const data = Buffer.from(JSON.stringify(advertisement))
    if (state.sharingEnabled && data.length <= 8192) this.socket?.send(data, CORE_DISCOVERY_PORT, CORE_DISCOVERY_GROUP)
  }
  close(): void { clearInterval(this.timer); const socket = this.socket; this.socket = undefined; if (socket) { try { socket.close() } catch {} } }
}
