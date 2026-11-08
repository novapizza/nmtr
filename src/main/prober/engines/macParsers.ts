/**
 * Pure helpers for the macOS probe engine — no Electron / koffi imports so
 * they can be unit-tested directly.
 *
 *   • ICMP echo packet build + reply parsing (for the unprivileged
 *     SOCK_DGRAM/IPPROTO_ICMP socket used by MacIcmpSocket)
 *   • `traceroute` / `traceroute6` output parsing (route discovery)
 *   • `ping` / `ping6` output parsing (subprocess fallback)
 */

// ─── ICMP ─────────────────────────────────────────────────────────────────────

export const ICMP_ECHO_REPLY = 0
export const ICMP_DEST_UNREACH = 3
export const ICMP_ECHO_REQUEST = 8
export const ICMP_TIME_EXCEEDED = 11

/** RFC 1071 Internet checksum. */
export function icmpChecksum(buf: Buffer): number {
  let sum = 0
  for (let i = 0; i < buf.length; i += 2) {
    sum += (buf[i] << 8) + (i + 1 < buf.length ? buf[i + 1] : 0)
  }
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16)
  return ~sum & 0xffff
}

/** Build an ICMP echo request: 8-byte header + `payloadSize` bytes of 0x20 (WinMTR style). */
export function buildEchoRequest(id: number, seq: number, payloadSize: number): Buffer {
  const pkt = Buffer.alloc(8 + payloadSize, 0x20)
  pkt[0] = ICMP_ECHO_REQUEST
  pkt[1] = 0
  pkt.writeUInt16BE(0, 2)
  pkt.writeUInt16BE(id & 0xffff, 4)
  pkt.writeUInt16BE(seq & 0xffff, 6)
  pkt.writeUInt16BE(icmpChecksum(pkt), 2)
  return pkt
}

export interface ParsedIcmpReply {
  /** ICMP type of the reply (0 echo-reply, 11 time-exceeded, 3 unreachable). */
  type: number
  code: number
  /** Address that sent this ICMP message. */
  fromIP: string
  /** id/seq of the *original* echo request this reply refers to. */
  id: number
  seq: number
}

function ipAt(buf: Buffer, off: number): string {
  return `${buf[off]}.${buf[off + 1]}.${buf[off + 2]}.${buf[off + 3]}`
}

/**
 * Parse a datagram read from a macOS ICMP socket.
 *
 * Darwin delivers the IPv4 header in front of the ICMP message even on
 * SOCK_DGRAM sockets; we detect that by the IP version nibble, so a header-less
 * buffer also parses (`fromIP` then comes from `fallbackFrom`).
 *
 * For error messages (time-exceeded / unreachable) the id/seq are taken from
 * the quoted original request (inner IP header + first 8 bytes of ICMP).
 */
export function parseIcmpReply(buf: Buffer, len: number, fallbackFrom: string | null = null): ParsedIcmpReply | null {
  if (len < 8) return null
  let off = 0
  let fromIP = fallbackFrom
  if (buf[0] >> 4 === 4) {
    const ihl = (buf[0] & 0x0f) * 4
    if (len < ihl + 8) return null
    fromIP = ipAt(buf, 12)
    off = ihl
  }
  if (!fromIP) return null

  const type = buf[off]
  const code = buf[off + 1]

  if (type === ICMP_ECHO_REPLY) {
    return { type, code, fromIP, id: buf.readUInt16BE(off + 4), seq: buf.readUInt16BE(off + 6) }
  }

  if (type === ICMP_TIME_EXCEEDED || type === ICMP_DEST_UNREACH) {
    const inner = off + 8
    if (len < inner + 20) return null
    const innerIhl = (buf[inner] & 0x0f) * 4
    const innerIcmp = inner + innerIhl
    if (len < innerIcmp + 8) return null
    if (buf[innerIcmp] !== ICMP_ECHO_REQUEST) return null
    return {
      type,
      code,
      fromIP,
      id: buf.readUInt16BE(innerIcmp + 4),
      seq: buf.readUInt16BE(innerIcmp + 6)
    }
  }

  return null
}

// ─── traceroute ───────────────────────────────────────────────────────────────

const IPV4_RE = /(\d{1,3}(?:\.\d{1,3}){3})/
const IPV6_RE = /([A-Fa-f0-9]{0,4}:[A-Fa-f0-9:]+[A-Fa-f0-9])/

/**
 * Parse macOS `traceroute -n` / `traceroute6 -n` output:
 *
 *   traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 40 byte packets
 *    1  192.168.50.1  6.284 ms
 *    2  *
 *    3  203.210.148.97  7.710 ms
 */
export function parseTracerouteOutput(output: string, maxHops: number, useIPv6: boolean): Map<number, string> {
  const hops = new Map<number, string>()
  const ipRe = useIPv6 ? IPV6_RE : IPV4_RE
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{1,3})\s+(.*)$/)
    if (!m) continue
    const ttl = parseInt(m[1], 10)
    if (ttl < 1 || ttl > maxHops) continue
    const ip = m[2].match(ipRe)?.[1]
    if (ip && !hops.has(ttl)) hops.set(ttl, ip)
  }
  return hops
}

// ─── ping ─────────────────────────────────────────────────────────────────────

export type MacPingOutcome =
  | { kind: 'reply'; fromIP: string; rttMs: number }
  | { kind: 'ttl-exceeded'; fromIP: string }
  | { kind: 'timeout' }

/**
 * Parse a single-probe macOS `ping -n -c 1 -m <ttl>` (or `ping6 -h <hop>`) run:
 *
 *   64 bytes from 8.8.8.8: icmp_seq=0 ttl=112 time=75.924 ms
 *   92 bytes from 192.168.1.1: Time to live exceeded
 *   16 bytes from 2001:db8::1: Time to live exceeded      (ping6)
 */
export function parseMacPingOutput(output: string, useIPv6: boolean): MacPingOutcome {
  const ipRe = useIPv6 ? IPV6_RE : IPV4_RE
  for (const line of output.split(/\r?\n/)) {
    const from = line.match(/bytes from\s+(.+?):?\s/i)
    if (!from) continue
    const ip = from[1].match(ipRe)?.[1]
    if (!ip) continue
    const time = line.match(/time[=<]\s*(\d+(?:\.\d+)?)\s*ms/i)
    if (time) return { kind: 'reply', fromIP: ip, rttMs: parseFloat(time[1]) }
    if (/time to live exceeded|hop limit|time exceeded/i.test(line)) return { kind: 'ttl-exceeded', fromIP: ip }
  }
  return { kind: 'timeout' }
}
