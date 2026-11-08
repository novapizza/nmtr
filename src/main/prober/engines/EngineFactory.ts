import { NativeEngine } from './NativeEngine'
import { MacEngine } from './MacEngine'
import type { IDiscoveryEngine, IProberEngine } from './IProberEngine'
import type { TraceConfig } from '../../../shared/types'

export type EngineMode = 'pingus' | 'native'

const isMac = process.platform === 'darwin'

export const EngineFactory = {
  /** Route discovery — tracert (Windows) / traceroute (macOS). */
  createDiscovery(): IDiscoveryEngine {
    return isMac ? new MacEngine() : new NativeEngine()
  },

  /** RTT probe engine — native ICMP: IcmpSendEcho (Windows) / unprivileged ICMP socket (macOS).
   *  PingusEngine (TCP/UDP) will be added here once stabilised. */
  async createProber(config: TraceConfig): Promise<{ engine: IProberEngine; mode: EngineMode }> {
    console.log(`[EngineFactory] Probe engine: native/${process.platform} (ipv6=${config.useIPv6 ? 'on' : 'off'})`)
    return { engine: isMac ? new MacEngine() : new NativeEngine(), mode: 'native' }
  }
}
