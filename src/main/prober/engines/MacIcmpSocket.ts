/**
 * MacIcmpSocket — unprivileged ICMP on macOS via koffi → libSystem.
 *
 * Darwin allows SOCK_DGRAM + IPPROTO_ICMP sockets without root (this is how
 * /sbin/ping works without being setuid). TTL is set per-send with
 * setsockopt(IP_TTL), and the kernel delivers both echo replies and the
 * ICMP time-exceeded errors from intermediate routers to the socket, with the
 * IPv4 header in front — so we get WinMTR-style probing with no subprocesses.
 *
 * Design:
 *   • One socket for the whole process (lazy). Every probe gets a unique
 *     sequence number; replies are matched back by (id, seq) — the id is
 *     random per process, so other pingers on the machine are ignored.
 *   • setsockopt(IP_TTL) + sendto() run synchronously back-to-back in the same
 *     JS tick, so concurrent probes with different TTLs can't race.
 *   • A single reader loop calls recvfrom() via koffi's async API (worker
 *     thread, SO_RCVTIMEO bounded) only while probes are in flight, then
 *     stops — idle cost is zero and only one worker thread is ever used.
 */
import { parseIcmpReply, buildEchoRequest, ICMP_ECHO_REPLY, ICMP_TIME_EXCEEDED } from './macParsers'

const AF_INET = 2
const SOCK_DGRAM = 2
const IPPROTO_IP = 0
const IPPROTO_ICMP = 1
const IP_TTL = 4
const SOL_SOCKET = 0xffff
const SO_RCVTIMEO = 0x1006

const RECV_BUFFER_SIZE = 1500
const RECV_POLL_MS = 250

export interface IcmpProbeReply {
  fromIP: string
  rttMs: number
  /** true = echo reply from the destination, false = TTL exceeded at a router. */
  isFinal: boolean
}

interface Pending {
  resolve: (r: IcmpProbeReply) => void
  reject: (e: Error) => void
  sentAt: bigint
  timer: NodeJS.Timeout
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KoffiFn = any

function timeoutError(message = 'timeout'): Error {
  const err = new Error(message)
  ;(err as NodeJS.ErrnoException).code = 'TIMEOUT'
  return err
}

export class MacIcmpSocket {
  private static instance: MacIcmpSocket | null | undefined

  /** Shared socket, or null if it can't be opened (non-macOS, koffi missing, sandbox…). */
  static get(): MacIcmpSocket | null {
    if (MacIcmpSocket.instance === undefined) {
      MacIcmpSocket.instance = process.platform === 'darwin' ? MacIcmpSocket.open() : null
    }
    return MacIcmpSocket.instance
  }

  private static open(): MacIcmpSocket | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const koffi = require('koffi')
      const lib = koffi.load('/usr/lib/libSystem.B.dylib')
      const fns = {
        socket: lib.func('int socket(int, int, int)'),
        setsockopt: lib.func('int setsockopt(int, int, int, void *, uint32)'),
        sendto: lib.func('intptr_t sendto(int, void *, size_t, int, void *, uint32)'),
        recvfrom: lib.func('intptr_t recvfrom(int, void *, size_t, int, void *, void *)'),
        close: lib.func('int close(int)')
      }
      const fd = fns.socket(AF_INET, SOCK_DGRAM, IPPROTO_ICMP) as number
      if (fd < 0) {
        console.error(`[MacIcmpSocket] socket() failed, errno=${koffi.errno()}`)
        return null
      }
      // Bound each blocking recvfrom so the reader loop can notice when it's idle.
      const tv = Buffer.alloc(16)
      tv.writeBigInt64LE(0n, 0)
      tv.writeInt32LE(RECV_POLL_MS * 1000, 8)
      fns.setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, tv, 16)
      console.log(`[MacIcmpSocket] unprivileged ICMP socket ready (fd=${fd})`)
      return new MacIcmpSocket(fd, fns)
    } catch (err) {
      console.error('[MacIcmpSocket] failed to open ICMP socket via koffi:', err)
      return null
    }
  }

  private readonly id = Math.floor(Math.random() * 0xffff)
  private seq = 0
  private pending = new Map<number, Pending>()
  private reading = false
  private closed = false
  private readonly recvBuf = Buffer.alloc(RECV_BUFFER_SIZE)
  private readonly ttlBuf = Buffer.alloc(4)

  private constructor(
    private readonly fd: number,
    private readonly fns: Record<'socket' | 'setsockopt' | 'sendto' | 'recvfrom' | 'close', KoffiFn>
  ) {}

  probe(destIP: string, ttl: number, payloadSize: number, timeoutMs: number): Promise<IcmpProbeReply> {
    if (this.closed) return Promise.reject(new Error('ICMP socket closed'))

    // Find a free sequence number (65k in flight is impossible in practice).
    let seq = this.seq
    do { seq = (seq + 1) & 0xffff } while (this.pending.has(seq))
    this.seq = seq

    const packet = buildEchoRequest(this.id, seq, payloadSize)
    const addr = Buffer.alloc(16, 0)            // struct sockaddr_in (BSD layout)
    addr[0] = 16                                // sin_len
    addr[1] = AF_INET                           // sin_family
    destIP.split('.').forEach((o, i) => { addr[4 + i] = Number(o) & 0xff })

    return new Promise<IcmpProbeReply>((resolve, reject) => {
      this.ttlBuf.writeInt32LE(ttl, 0)
      if (this.fns.setsockopt(this.fd, IPPROTO_IP, IP_TTL, this.ttlBuf, 4) !== 0) {
        reject(new Error('setsockopt(IP_TTL) failed'))
        return
      }
      const sentAt = process.hrtime.bigint()
      const sent = this.fns.sendto(this.fd, packet, packet.length, 0, addr, 16) as number
      if (sent < 0) {
        // e.g. EHOSTUNREACH / ENETUNREACH with no route — count as loss.
        reject(timeoutError(`sendto failed`))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(timeoutError())
      }, timeoutMs)
      this.pending.set(seq, { resolve, reject, sentAt, timer })
      this.ensureReading()
    })
  }

  private ensureReading(): void {
    if (this.reading || this.closed) return
    this.reading = true
    this.readOnce()
  }

  private readOnce(): void {
    if (this.closed || this.pending.size === 0) {
      this.reading = false
      return
    }
    this.fns.recvfrom.async(this.fd, this.recvBuf, RECV_BUFFER_SIZE, 0, null, null, (err: unknown, n: number) => {
      const receivedAt = process.hrtime.bigint()
      if (!err && n > 0) this.dispatch(n, receivedAt)
      // n < 0 → SO_RCVTIMEO elapsed (EAGAIN); just poll again while busy.
      setImmediate(() => this.readOnce())
    })
  }

  private dispatch(n: number, receivedAt: bigint): void {
    const reply = parseIcmpReply(this.recvBuf, n)
    if (!reply || reply.id !== this.id) return
    const p = this.pending.get(reply.seq)
    if (!p) return
    this.pending.delete(reply.seq)
    clearTimeout(p.timer)

    const rttMs = Math.round(Number(receivedAt - p.sentAt) / 1e4) / 100 // ns → ms, 2 dp
    if (reply.type === ICMP_ECHO_REPLY) {
      p.resolve({ fromIP: reply.fromIP, rttMs, isFinal: true })
    } else if (reply.type === ICMP_TIME_EXCEEDED) {
      p.resolve({ fromIP: reply.fromIP, rttMs, isFinal: false })
    } else {
      // Destination/net unreachable — treated as loss, same as the Windows engine.
      p.reject(timeoutError(`ICMP unreachable (code ${reply.code}) from ${reply.fromIP}`))
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('ICMP socket closed'))
    }
    this.pending.clear()
    try { this.fns.close(this.fd) } catch { /* ignore */ }
    MacIcmpSocket.instance = undefined
  }
}
