import { spawn } from 'child_process'
import { lookup as dnsLookup } from 'dns'
import type { IProberEngine } from './IProberEngine'
import type { ProbeOptions, ProbeResult } from '../../../shared/types'

// ─── Windows ICMP status codes (ipexport.h) ──────────────────────────────────
const IP_SUCCESS             = 0
const IP_TTL_EXPIRED_TRANSIT = 11013
const IP_REQ_TIMED_OUT       = 11010

// ─── ICMP_ECHO_REPLY field offsets (identical on 32/64-bit) ──────────────────
// Address(uint32)=0, Status(uint32)=4, RoundTripTime(uint32)=8
const OFF_ADDRESS = 0
const OFF_STATUS  = 4
const OFF_RTT     = 8

// IP_OPTION_INFORMATION size: 64-bit=16 bytes, 32-bit=8 bytes
// Ttl(1)+Tos(1)+Flags(1)+OptionsSize(1)+[padding]+OptionsData(ptr)
const IP_OPT_SIZE = process.arch === 'x64' || process.arch === 'arm64' ? 16 : 8

// Reply buffer: ICMP_ECHO_REPLY header + request data + 8-byte safety margin
const REPLY_BUFFER_SIZE = 8192 + 64

// WinMTR uses IPFLAG_DONT_FRAGMENT = 0x02
const IPFLAG_DONT_FRAGMENT = 0x02

// Default request payload size (WinMTR uses 32 bytes of ASCII spaces 0x20)
const DEFAULT_REQUEST_SIZE = 32

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert an IPv4 string to a Windows IPAddr (DWORD in network byte order,
 * stored little-endian so the in-memory bytes are [a,b,c,d]).
 * "192.168.1.1" → (192 | 168<<8 | 1<<16 | 1<<24) = 0x0101A8C0
 */
function ipToAddr(ip: string): number {
  const p = ip.split('.').map(Number)
  return ((p[0]) | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0
}

/**
 * Convert a Windows IPAddr back to a dotted-decimal string.
 * Inverse of ipToAddr.
 */
function addrToIp(addr: number): string {
  return [
    (addr >>> 0)  & 0xFF,
    (addr >>> 8)  & 0xFF,
    (addr >>> 16) & 0xFF,
    (addr >>> 24) & 0xFF
  ].join('.')
}

/**
 * Build an IP_OPTION_INFORMATION buffer with the given TTL (WinMTR style).
 * Fields: Ttl, Tos=0, Flags=IPFLAG_DONT_FRAGMENT, OptionsSize=0, OptionsData=NULL
 */
function buildIpOptions(ttl: number): Buffer {
  const buf = Buffer.alloc(IP_OPT_SIZE, 0)
  buf[0] = ttl & 0xFF         // Ttl
  buf[1] = 0                  // Tos
  buf[2] = IPFLAG_DONT_FRAGMENT // Flags
  buf[3] = 0                  // OptionsSize  (OptionsData pointer remains NULL/zeroed)
  return buf
}

// ─── Lazy ICMP handle ────────────────────────────────────────────────────────

interface IcmpApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendEcho: any   // koffi func — call .async() for non-blocking operation
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  closeHandle: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: any
}

function openIcmpApi(): IcmpApi | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const lib = koffi.load('Iphlpapi.dll')

    const IcmpCreateFile  = lib.func('IcmpCreateFile',  'void *', [])
    const IcmpCloseHandle = lib.func('IcmpCloseHandle', 'bool',   ['void *'])
    const IcmpSendEcho    = lib.func('IcmpSendEcho', 'uint32', [
      'void *',  // IcmpHandle
      'uint32',  // DestinationAddress (IPAddr, network byte order)
      'void *',  // RequestData
      'uint16',  // RequestSize
      'void *',  // RequestOptions (IP_OPTION_INFORMATION*, set TTL here)
      'void *',  // ReplyBuffer
      'uint32',  // ReplySize
      'uint32'   // Timeout (ms)
    ])

    const handle = IcmpCreateFile()
    if (!handle) {
      console.error('[NativeEngine] IcmpCreateFile returned null handle')
      return null
    }

    return { sendEcho: IcmpSendEcho, closeHandle: IcmpCloseHandle, handle }
  } catch (err) {
    console.error('[NativeEngine] Failed to load ICMP API via koffi:', err)
    return null
  }
}

/**
 * Call IcmpSendEcho asynchronously (runs in koffi's thread pool so the
 * Node.js event loop is never blocked — equivalent to WinMTR's per-TTL threads).
 */
function icmpSendEchoAsync(
  api: IcmpApi,
  destAddr: number,
  ipOptions: Buffer,
  replyBuffer: Buffer,
  timeoutMs: number,
  packetSize: number
): Promise<number> {
  const requestData = Buffer.alloc(packetSize, 0x20) // spaces, like WinMTR
  return new Promise<number>((resolve, reject) => {
    api.sendEcho.async(
      api.handle,
      destAddr,
      requestData,
      packetSize,
      ipOptions,
      replyBuffer,
      replyBuffer.length,
      timeoutMs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: any, count: number) => {
        if (err) reject(err)
        else resolve(count)
      }
    )
  })
}

// ─── Input validation ────────────────────────────────────────────────────────

/** Validate that a target is a safe hostname or IP address (no shell metacharacters) */
const VALID_IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
const VALID_IPV6_RE = /^(?:[A-Fa-f0-9]{1,4}(?::[A-Fa-f0-9]{0,4}){1,7}|::1|::)$/
const VALID_HOSTNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,253}[a-zA-Z0-9])?$/

const IPV4_EXTRACT_RE = /(\d{1,3}(?:\.\d{1,3}){3})/
const IPV6_EXTRACT_RE = /([A-Fa-f0-9]{0,4}:[A-Fa-f0-9:]+[A-Fa-f0-9])/

export function isLikelyIPv6(target: string): boolean {
  return target.includes(':')
}

export function isValidTarget(target: string): boolean {
  return VALID_IP_RE.test(target) || VALID_HOSTNAME_RE.test(target) || VALID_IPV6_RE.test(target)
}

function extractIPFromText(text: string, useIPv6: boolean): string | null {
  const match = useIPv6 ? text.match(IPV6_EXTRACT_RE) : text.match(IPV4_EXTRACT_RE)
  return match?.[1] ?? null
}

// ─── DNS resolution (cached per-target) ──────────────────────────────────────

export function resolveIPv4(host: string): Promise<string> {
  // Already an IPv4 address — skip DNS
  if (VALID_IP_RE.test(host)) return Promise.resolve(host)
  return new Promise((resolve) => {
    dnsLookup(host, { family: 4 }, (err, address) => {
      resolve(err ? host : address)
    })
  })
}

// ─── NativeEngine ─────────────────────────────────────────────────────────────

/**
 * NativeEngine — WinMTR-style ICMP probe engine.
 *
 * Instead of spawning ping.exe subprocesses, this engine calls
 * IcmpSendEcho() from Iphlpapi.dll directly through the koffi FFI library,
 * mirroring WinMTR's TraceThread approach:
 *
 *   • One ICMP handle per engine instance (WinMTR: hICMP)
 *   • Each probe() call maps to one async IcmpSendEcho() call running in
 *     koffi's thread pool — all TTLs can fire in parallel with no concurrency
 *     cap (WinMTR: 30 simultaneous threads, one per TTL)
 *   • TTL is set via IP_OPTION_INFORMATION with IPFLAG_DONT_FRAGMENT=0x02
 *   • RoundTripTime comes directly from the ICMP kernel reply, not wall-clock
 *   • IP_SUCCESS  → isFinalHop=true   (destination reached)
 *   • IP_TTL_EXPIRED_TRANSIT → isFinalHop=false (intermediate hop)
 *   • IP_REQ_TIMED_OUT / count=0 → throws Error('timeout')
 *
 * discoverHops() still uses tracert so the raw text output can be shown in
 * the TracertResultModal (UI display purposes only).
 *
 * Falls back to ping.exe if koffi / Iphlpapi.dll cannot be loaded.
 */
export class NativeEngine implements IProberEngine {
  private icmp: IcmpApi | null = null
  private resolvedIP: string | null = null  // cached DNS result for this target

  constructor() {
    this.icmp = openIcmpApi()
  }

  // ─── discoverHops: tracert-based (for UI raw output display) ─────────────

  async discoverHops(
    target: string,
    maxHops: number,
    useIPv6 = false
  ): Promise<{ hops: Map<number, string>; rawOutput: string; error: string | null }> {
    if (!isValidTarget(target)) {
      return { hops: new Map(), rawOutput: '', error: `Invalid target: ${target}` }
    }
    return new Promise((resolve) => {
      const hops = new Map<number, string>()
      let spawnError: string | null = null

      console.log(`[NativeEngine] tracert ${target} -d -h ${maxHops} -w 1000 ${useIPv6 ? '-6' : ''}`)

      let child: ReturnType<typeof spawn>
      try {
        const args = ['-d', '-h', String(maxHops), '-w', '1000']
        if (useIPv6) args.push('-6')
        args.push(target)
        child = spawn('tracert', args, {
          windowsHide: true
        })
      } catch (err) {
        resolve({ hops, rawOutput: '', error: `Failed to start tracert: ${err}` })
        return
      }

      let output = ''
      child.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString()
        process.stdout.write(chunk)
        output += chunk
      })
      child.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString()
        process.stderr.write(chunk)
        output += chunk
      })
      child.on('error', (err) => { spawnError = `tracert process error: ${err.message}` })
      child.on('close', (code) => {
        if (spawnError) { resolve({ hops, rawOutput: output, error: spawnError }); return }

        // Parse tracert output (locale-agnostic). Robust against:
        //   - CR-only / CRLF line endings (split + strip \r)
        //   - Control chars / BOM / non-printable noise at start of line
        //   - Hop number on its own line, IP on the next visible part
        // Strategy: any line whose first non-whitespace token is a small
        //   integer is treated as a hop line; the IP is extracted from
        //   anywhere on the line.
        for (const rawLine of output.split(/\r?\n/)) {
          // Strip CR + any leading control bytes (BOM, NUL, etc.)
          // eslint-disable-next-line no-control-regex
          const line = rawLine.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F﻿]/g, '')
          const ttlMatch = line.match(/^\s*(\d{1,3})(?:\s|$)/)
          if (!ttlMatch) continue
          const ttl = parseInt(ttlMatch[1], 10)
          // Tracert hop numbers are 1..maxHops — anything outside is noise
          // (e.g. "over a maximum of 30 hops:" starts with a word, so it
          // won't reach here, but guard anyway).
          if (ttl < 1 || ttl > maxHops) continue
          const ip = extractIPFromText(line, useIPv6)
          if (ip) hops.set(ttl, ip)
        }

        console.log(`[NativeEngine] tracert done (exit=${code}): ${hops.size} hops discovered`)
        if (hops.size === 0 && output.length > 0) {
          // Diagnostic: dump first 6 non-empty lines so we can see why
          // parsing fell through (e.g. localised header, weird whitespace).
          const sample = output.split(/\r?\n/).filter((l) => l.trim()).slice(0, 6)
          console.warn('[NativeEngine] tracert output had data but no hops parsed. First lines:')
          sample.forEach((l, i) => console.warn(`  [${i}] ${JSON.stringify(l)}`))
        }
        hops.forEach((ip, ttl) => console.log(`  hop ${ttl}: ${ip}`))

        const exitError =
          code !== 0 && hops.size === 0
            ? `tracert exited with code ${code}. No hops discovered.`
            : null
        if (exitError) console.error(`[NativeEngine] ${exitError}`)

        resolve({ hops, rawOutput: output, error: exitError })
      })
    })
  }

  // ─── probe: IcmpSendEcho via koffi (WinMTR TraceThread logic) ────────────

  async probe(target: string, ttl: number, opts: ProbeOptions): Promise<ProbeResult> {
    if (!isValidTarget(target)) throw new Error(`Invalid target: ${target}`)

    // IcmpSendEcho is IPv4-only. IPv6 uses ping fallback.
    if (opts.useIPv6 || isLikelyIPv6(target)) {
      return this.pingFallback(target, ttl, opts)
    }

    // Fall back to ping.exe if the ICMP API could not be loaded
    if (!this.icmp) return this.pingFallback(target, ttl, opts)

    // Resolve target hostname to IPv4 once; cache for subsequent probes
    if (!this.resolvedIP) {
      this.resolvedIP = await resolveIPv4(target)
    }

    const destAddr  = ipToAddr(this.resolvedIP)
    const ipOptions = buildIpOptions(ttl)
    const replyBuf  = Buffer.alloc(REPLY_BUFFER_SIZE, 0)

    // IcmpSendEcho blocks until a reply arrives or timeout expires.
    // koffi runs it in its own thread pool so the event loop stays free —
    // all TTL probes can be in-flight simultaneously (WinMTR thread-per-TTL).
    const reqSize = opts.packetSize > 0 ? opts.packetSize : DEFAULT_REQUEST_SIZE
    const count = await icmpSendEchoAsync(this.icmp, destAddr, ipOptions, replyBuf, opts.timeoutMs, reqSize)

    if (count === 0) {
      // dwReplyCount == 0 → IcmpSendEcho returned no reply (timeout/error)
      const err = new Error('timeout')
      ;(err as NodeJS.ErrnoException).code = 'TIMEOUT'
      throw err
    }

    const fromAddr = replyBuf.readUInt32LE(OFF_ADDRESS)
    const status   = replyBuf.readUInt32LE(OFF_STATUS)
    const rttMs    = replyBuf.readUInt32LE(OFF_RTT)
    const fromIP   = addrToIp(fromAddr)

    if (status === IP_SUCCESS) {
      // Destination replied — final hop reached
      console.log(`[NativeEngine] hop ${ttl} -> ${fromIP} (${rttMs}ms) [FINAL]`)
      return { fromIP, rttMs, isFinalHop: true, hopIndex: ttl }
    }

    if (status === IP_TTL_EXPIRED_TRANSIT) {
      // Router at hop N replied with ICMP TTL-exceeded
      console.log(`[NativeEngine] hop ${ttl} -> ${fromIP} (${rttMs}ms) [TTL-EXPIRED]`)
      return { fromIP, rttMs, isFinalHop: false, hopIndex: ttl }
    }

    if (status === IP_REQ_TIMED_OUT) {
      const err = new Error('timeout')
      ;(err as NodeJS.ErrnoException).code = 'TIMEOUT'
      throw err
    }

    // Other ICMP errors (net unreachable, host unreachable, etc.) — treat as loss
    const err = new Error(`ICMP error status ${status}`)
    ;(err as NodeJS.ErrnoException).code = 'TIMEOUT'
    throw err
  }

  // ─── Fallback: ping.exe subprocess (used when koffi/ICMP API unavailable) ─

  private pingFallback(target: string, ttl: number, opts: ProbeOptions): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
      const probeStart = Date.now()
      const args = ['-i', String(ttl), '-n', '1', '-w', String(opts.timeoutMs)]
      if (opts.useIPv6 || isLikelyIPv6(target)) args.push('-6')
      args.push(target)
      const child = spawn('ping', args, { windowsHide: true })

      let output = ''
      child.stdout.on('data', (d: Buffer) => (output += d.toString()))
      child.stderr.on('data', (d: Buffer) => (output += d.toString()))

      child.on('close', () => {
        const useIPv6 = !!opts.useIPv6 || isLikelyIPv6(target)
        const lines = output.split('\n')
        const headerIP = lines[0] ? extractIPFromText(lines[0], useIPv6) : null
        const RTT_RE = /[=<](\d+)\s*ms/i

        let replyIP: string | null = null
        let replyRtt: number | null = null
        let ttlExpiredIP: string | null = null

        for (let i = 1; i < lines.length; i++) {
          const ip = extractIPFromText(lines[i], useIPv6)
          if (!ip) continue
          if (ip === headerIP) continue
          const rttM = lines[i].match(RTT_RE)
          if (rttM) { replyIP = ip; replyRtt = parseInt(rttM[1], 10); break }
          else if (!ttlExpiredIP) ttlExpiredIP = ip
        }

        if (replyIP !== null && replyRtt !== null) {
          resolve({ fromIP: replyIP, rttMs: replyRtt, isFinalHop: true, hopIndex: ttl })
        } else if (ttlExpiredIP !== null) {
          resolve({ fromIP: ttlExpiredIP, rttMs: Date.now() - probeStart, isFinalHop: false, hopIndex: ttl })
        } else {
          const err = new Error('timeout')
          ;(err as NodeJS.ErrnoException).code = 'TIMEOUT'
          reject(err)
        }
      })

      child.on('error', (err) => reject(err))
    })
  }

  // ─── destroy ─────────────────────────────────────────────────────────────

  destroy(): void {
    if (this.icmp) {
      try { this.icmp.closeHandle(this.icmp.handle) } catch { /* ignore */ }
      this.icmp = null
    }
  }
}
