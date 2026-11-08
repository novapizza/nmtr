import { spawn } from 'child_process'
import type { IDiscoveryEngine, IProberEngine } from './IProberEngine'
import type { ProbeOptions, ProbeResult } from '../../../shared/types'
import { isLikelyIPv6, isValidTarget, resolveIPv4 } from './NativeEngine'
import { MacIcmpSocket } from './MacIcmpSocket'
import { parseMacPingOutput, parseTracerouteOutput } from './macParsers'

// Absolute paths: apps launched from Finder get a minimal PATH.
const TRACEROUTE = '/usr/sbin/traceroute'
const TRACEROUTE6 = '/usr/sbin/traceroute6'
const PING = '/sbin/ping'
const PING6 = '/sbin/ping6'

const DEFAULT_REQUEST_SIZE = 32

function timeoutError(message = 'timeout'): Error {
  const err = new Error(message)
  ;(err as NodeJS.ErrnoException).code = 'TIMEOUT'
  return err
}

/**
 * MacEngine — macOS counterpart of NativeEngine.
 *
 *   • discoverHops(): `traceroute -I` (ICMP, same protocol as the probes so
 *     ECMP load-balancers route discovery and probing the same way). The raw
 *     output is shown in the TracertResultModal, just like tracert on Windows.
 *   • probe(): IPv4 → unprivileged ICMP socket (MacIcmpSocket), no root and no
 *     subprocess per probe. IPv6, or if the socket can't be opened → `ping`.
 */
export class MacEngine implements IProberEngine, IDiscoveryEngine {
  private resolvedIP: string | null = null

  // ─── discoverHops: traceroute ─────────────────────────────────────────────

  async discoverHops(
    target: string,
    maxHops: number,
    useIPv6 = false
  ): Promise<{ hops: Map<number, string>; rawOutput: string; error: string | null }> {
    if (!isValidTarget(target)) {
      return { hops: new Map(), rawOutput: '', error: `Invalid target: ${target}` }
    }
    const v6 = useIPv6 || isLikelyIPv6(target)
    const bin = v6 ? TRACEROUTE6 : TRACEROUTE
    const args = ['-I', '-n', '-m', String(maxHops), '-w', '1', '-q', '1', target]
    console.log(`[MacEngine] ${bin} ${args.join(' ')}`)

    return new Promise((resolve) => {
      let output = ''
      let spawnError: string | null = null
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(bin, args)
      } catch (err) {
        resolve({ hops: new Map(), rawOutput: '', error: `Failed to start traceroute: ${err}` })
        return
      }
      child.stdout?.on('data', (d: Buffer) => { output += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { output += d.toString() })
      child.on('error', (err) => { spawnError = `traceroute process error: ${err.message}` })
      child.on('close', (code) => {
        if (spawnError) { resolve({ hops: new Map(), rawOutput: output, error: spawnError }); return }
        const hops = parseTracerouteOutput(output, maxHops, v6)
        console.log(`[MacEngine] traceroute done (exit=${code}): ${hops.size} hops discovered`)
        const error = code !== 0 && hops.size === 0
          ? `traceroute exited with code ${code}. No hops discovered.`
          : null
        resolve({ hops, rawOutput: output, error })
      })
    })
  }

  // ─── probe ────────────────────────────────────────────────────────────────

  async probe(target: string, ttl: number, opts: ProbeOptions): Promise<ProbeResult> {
    if (!isValidTarget(target)) throw new Error(`Invalid target: ${target}`)
    const v6 = opts.useIPv6 || isLikelyIPv6(target)
    const size = opts.packetSize > 0 ? opts.packetSize : DEFAULT_REQUEST_SIZE

    const sock = v6 ? null : MacIcmpSocket.get()
    if (!sock) return this.pingFallback(target, ttl, opts, v6, size)

    if (!this.resolvedIP) this.resolvedIP = await resolveIPv4(target)
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(this.resolvedIP)) {
      // DNS failed (resolveIPv4 returns the hostname unchanged) — let ping report it.
      this.resolvedIP = null
      return this.pingFallback(target, ttl, opts, v6, size)
    }

    const r = await sock.probe(this.resolvedIP, ttl, size, opts.timeoutMs)
    return { fromIP: r.fromIP, rttMs: r.rttMs, isFinalHop: r.isFinal, hopIndex: ttl }
  }

  // ─── Fallback: ping / ping6 subprocess ────────────────────────────────────

  private pingFallback(target: string, ttl: number, opts: ProbeOptions, v6: boolean, size: number): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      // macOS: -m = TTL, -W = wait in *milliseconds*; ping6: -h = hop limit.
      const bin = v6 ? PING6 : PING
      const args = v6
        ? ['-n', '-c', '1', '-h', String(ttl), '-s', String(size), target]
        : ['-n', '-c', '1', '-m', String(ttl), '-W', String(opts.timeoutMs), '-s', String(size), target]

      const child = spawn(bin, args)
      let output = ''
      // ping keeps waiting after a TTL-exceeded reply, so wall-clock at exit is
      // useless as an RTT — stamp the moment the first reply line arrives.
      let firstReplyAt: number | null = null
      // ping6 has no reply-wait flag, so enforce the timeout ourselves.
      const killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs + 250)
      child.stdout.on('data', (d: Buffer) => {
        output += d.toString()
        if (firstReplyAt === null && /bytes from/i.test(output)) firstReplyAt = Date.now()
      })
      child.stderr.on('data', (d: Buffer) => (output += d.toString()))
      child.on('error', (err) => { clearTimeout(killer); reject(err) })
      child.on('close', () => {
        clearTimeout(killer)
        const res = parseMacPingOutput(output, v6)
        if (res.kind === 'reply') {
          resolve({ fromIP: res.fromIP, rttMs: res.rttMs, isFinalHop: true, hopIndex: ttl })
        } else if (res.kind === 'ttl-exceeded') {
          resolve({ fromIP: res.fromIP, rttMs: (firstReplyAt ?? Date.now()) - started, isFinalHop: false, hopIndex: ttl })
        } else {
          reject(timeoutError())
        }
      })
    })
  }

  destroy(): void {
    // The ICMP socket is process-wide and shared between sessions — not closed here.
  }
}
