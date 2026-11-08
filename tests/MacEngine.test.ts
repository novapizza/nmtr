import { describe, it, expect } from 'vitest'
import {
  buildEchoRequest,
  icmpChecksum,
  parseIcmpReply,
  parseTracerouteOutput,
  parseMacPingOutput,
  ICMP_ECHO_REPLY,
  ICMP_TIME_EXCEEDED
} from '../src/main/prober/engines/macParsers'

// Datagrams captured from a real macOS SOCK_DGRAM/IPPROTO_ICMP socket
// (id 0x4242) — IPv4 header included, as Darwin delivers it.
const TIME_EXCEEDED_HEX =
  '45c0440086ff000040010ce9c0a83201c0a832ab0b00f4ff00000000' + // outer IP + ICMP 11/0
  '45003c001bd5000001019a89c0a832ab08080808' +                 // quoted original IP header
  '0800b3ba42420001' +                                          // quoted echo request: id 0x4242 seq 1
  '2020202020202020'
const ECHO_REPLY_HEX =
  '45202800000000007001473e08080808c0a832ab' + // IP from 8.8.8.8
  '0000bb7b42420040' +                          // echo reply id 0x4242 seq 0x40
  '2020202020202020202020202020202020202020202020202020202020202020'

describe('ICMP packet helpers', () => {
  it('builds an echo request with a valid checksum', () => {
    const pkt = buildEchoRequest(0x4242, 7, 32)
    expect(pkt.length).toBe(40)
    expect(pkt[0]).toBe(8)
    expect(pkt.readUInt16BE(4)).toBe(0x4242)
    expect(pkt.readUInt16BE(6)).toBe(7)
    // A correct checksum makes the checksum of the whole packet 0.
    expect(icmpChecksum(pkt)).toBe(0)
  })

  it('handles odd-length payloads', () => {
    expect(icmpChecksum(buildEchoRequest(1, 1, 33))).toBe(0)
  })

  it('parses a time-exceeded reply and recovers the original id/seq', () => {
    const buf = Buffer.from(TIME_EXCEEDED_HEX, 'hex')
    expect(parseIcmpReply(buf, buf.length)).toEqual({
      type: ICMP_TIME_EXCEEDED, code: 0, fromIP: '192.168.50.1', id: 0x4242, seq: 1
    })
  })

  it('parses an echo reply', () => {
    const buf = Buffer.from(ECHO_REPLY_HEX, 'hex')
    expect(parseIcmpReply(buf, buf.length)).toEqual({
      type: ICMP_ECHO_REPLY, code: 0, fromIP: '8.8.8.8', id: 0x4242, seq: 0x40
    })
  })

  it('parses a header-less ICMP message when a source is supplied', () => {
    const buf = Buffer.from(ECHO_REPLY_HEX, 'hex').subarray(20)
    expect(parseIcmpReply(buf, buf.length, '1.2.3.4')?.fromIP).toBe('1.2.3.4')
  })

  it('rejects truncated datagrams and foreign ICMP types', () => {
    const buf = Buffer.from(TIME_EXCEEDED_HEX, 'hex')
    expect(parseIcmpReply(buf, 30)).toBeNull()
    const other = Buffer.from(ECHO_REPLY_HEX, 'hex')
    other[20] = 13 // timestamp request
    expect(parseIcmpReply(other, other.length)).toBeNull()
  })
})

describe('parseTracerouteOutput (macOS)', () => {
  const out = [
    'traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 72 byte packets',
    ' 1  192.168.50.1  6.284 ms',
    ' 2  *',
    ' 3  203.210.148.97  7.710 ms',
    '10  8.8.8.8  75.1 ms'
  ].join('\n')

  it('extracts hop → IP and skips silent hops', () => {
    const hops = parseTracerouteOutput(out, 30, false)
    expect([...hops.entries()]).toEqual([
      [1, '192.168.50.1'],
      [3, '203.210.148.97'],
      [10, '8.8.8.8']
    ])
  })

  it('ignores hops above maxHops', () => {
    expect(parseTracerouteOutput(out, 5, false).has(10)).toBe(false)
  })

  it('parses traceroute6 output', () => {
    const v6 = 'traceroute6 to 2001:4860:4860::8888\n 1  2001:db8::1  1.2 ms\n 2  2001:4860:4860::8888  9.9 ms'
    expect(parseTracerouteOutput(v6, 30, true).get(2)).toBe('2001:4860:4860::8888')
  })
})

describe('parseMacPingOutput', () => {
  it('reads a decimal RTT from an echo reply', () => {
    const out = 'PING 8.8.8.8 (8.8.8.8): 32 data bytes\n64 bytes from 8.8.8.8: icmp_seq=0 ttl=112 time=75.924 ms\n'
    expect(parseMacPingOutput(out, false)).toEqual({ kind: 'reply', fromIP: '8.8.8.8', rttMs: 75.924 })
  })

  it('detects TTL exceeded from an intermediate router', () => {
    const out = [
      'PING 8.8.8.8 (8.8.8.8): 56 data bytes',
      '92 bytes from 192.168.1.1: Time to live exceeded',
      'Vr HL TOS  Len   ID Flg  off TTL Pro  cks      Src      Dst',
      ' 4  5  00 5400 1124   0 0000  01  01 a522 192.168.50.171  8.8.8.8'
    ].join('\n')
    expect(parseMacPingOutput(out, false)).toEqual({ kind: 'ttl-exceeded', fromIP: '192.168.1.1' })
  })

  it('reports a timeout when nothing came back', () => {
    const out = 'PING 10.255.255.1 (10.255.255.1): 56 data bytes\n\n--- statistics ---\n1 packets transmitted, 0 packets received'
    expect(parseMacPingOutput(out, false)).toEqual({ kind: 'timeout' })
  })

  it('parses ping6 replies', () => {
    const out = '16 bytes from 2001:4860:4860::8888, icmp_seq=0 hlim=117 time=31.4 ms'
    expect(parseMacPingOutput(out, true)).toEqual({ kind: 'reply', fromIP: '2001:4860:4860::8888', rttMs: 31.4 })
  })
})
