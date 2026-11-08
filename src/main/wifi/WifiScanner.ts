/**
 * Wi-Fi / Wireless analyzer
 *
 * Reads the wireless adapter's current association and scans for nearby access
 * points using the built-in `netsh wlan` commands on Windows (macOS: see
 * scanWifiMac / macWifiParser.ts — system_profiler). Everything is
 * parsed from stdout — no third-party tools, nothing leaves the machine.
 *
 *   netsh wlan show interfaces          → the connection we're associated with
 *   netsh wlan show networks mode=bssid → every SSID/BSSID in range
 *
 * netsh reports signal as a percentage (0–100), not dBm. We derive an
 * approximate RSSI with the well-known linear mapping Windows itself uses
 * internally: dBm ≈ percent/2 − 100 (so 100% ≈ −50 dBm, 0% ≈ −100 dBm).
 */
import { spawn } from 'child_process'
import { parseSystemProfilerWifi } from './macWifiParser'
import type { WifiBand, WifiConnection, WifiNetwork, WifiChannelUsage, WifiScanResult } from '../../shared/types'

// ── Subprocess helper (argv array, never a shell) ─────────────────────────────

function runSpawn(command: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, timeout: timeoutMs })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', () => resolve(stdout + stderr))
  })
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/** Pull the value after the first colon on a "Key : Value" line. */
function valueOf(line: string): string {
  const idx = line.indexOf(':')
  return idx === -1 ? '' : line.slice(idx + 1).trim()
}

function toInt(s: string): number | null {
  const m = s.match(/-?\d+/)
  return m ? parseInt(m[0], 10) : null
}

/** netsh percentage → approximate RSSI in dBm. */
function percentToDbm(percent: number | null): number | null {
  if (percent === null) return null
  return Math.round(percent / 2 - 100)
}

/** Infer the band from the radio channel number (6 GHz overlaps numerically and
 *  can't be told apart by channel alone, so it's only set from an explicit Band line). */
function bandForChannel(channel: number | null): WifiBand {
  if (channel === null) return 'unknown'
  if (channel >= 1 && channel <= 14) return '2.4 GHz'
  if (channel >= 32 && channel <= 177) return '5 GHz'
  return 'unknown'
}

/**
 * 6 GHz also numbers channels 1‑233, overlapping 2.4/5 GHz. netsh tags the band
 * directly on newer builds via a "Band" line; when present we trust it.
 */
function parseBand(raw: string | null, channel: number | null): WifiBand {
  if (raw) {
    if (/6\s*ghz/i.test(raw)) return '6 GHz'
    if (/5\s*ghz/i.test(raw)) return '5 GHz'
    if (/2\.4\s*ghz/i.test(raw)) return '2.4 GHz'
  }
  return bandForChannel(channel)
}

// ── Current connection (`netsh wlan show interfaces`) ─────────────────────────

function parseInterfaces(out: string): WifiConnection | null {
  // A machine may have several adapters; netsh prints one block each, separated
  // by a blank line. We return the first that is "connected", else the first.
  const blocks = out.split(/\r?\n\s*\r?\n/).filter((b) => /\bSSID\b|\bName\b/i.test(b))
  if (blocks.length === 0) return null

  const parse = (block: string): WifiConnection => {
    const get = (re: RegExp): string | null => {
      for (const line of block.split(/\r?\n/)) {
        if (re.test(line)) {
          const v = valueOf(line)
          return v === '' ? null : v
        }
      }
      return null
    }
    const channel = toInt(get(/^\s*Channel\b/i) ?? '')
    const bandRaw = get(/^\s*Band\b/i)
    const signal = toInt(get(/^\s*Signal\b/i) ?? '')
    return {
      interfaceName: get(/^\s*Description\b/i) ?? get(/^\s*Name\b/i) ?? 'Wi-Fi',
      state: (get(/^\s*State\b/i) ?? 'unknown').toLowerCase(),
      ssid: get(/^\s*SSID\b(?!\s*BSSID)/i),
      bssid: get(/^\s*BSSID\b/i),
      radioType: get(/^\s*Radio type\b/i),
      authentication: get(/^\s*Authentication\b/i),
      cipher: get(/^\s*Cipher\b/i),
      band: parseBand(bandRaw, channel),
      channel,
      signalPercent: signal,
      rssiDbm: percentToDbm(signal),
      rxRateMbps: toInt(get(/^\s*Receive rate/i) ?? ''),
      txRateMbps: toInt(get(/^\s*Transmit rate/i) ?? '')
    }
  }

  const parsed = blocks.map(parse)
  return parsed.find((c) => c.state === 'connected') ?? parsed[0] ?? null
}

// ── Nearby networks (`netsh wlan show networks mode=bssid`) ───────────────────

function parseNetworks(out: string, currentBssid: string | null): WifiNetwork[] {
  const lines = out.split(/\r?\n/)
  const networks: WifiNetwork[] = []

  // Each SSID introduces a group; within it, one or more BSSID sub-blocks carry
  // the per-AP signal/channel/radio. We flatten to one entry per BSSID.
  let curSsid: string | null = null
  let curAuth: string | null = null
  let curCipher: string | null = null
  let pending: Partial<WifiNetwork> | null = null

  const flush = (): void => {
    if (pending && pending.bssid !== undefined) {
      const channel = pending.channel ?? null
      networks.push({
        ssid: curSsid ?? '',
        bssid: pending.bssid ?? null,
        signalPercent: pending.signalPercent ?? null,
        rssiDbm: percentToDbm(pending.signalPercent ?? null),
        band: parseBand(null, channel),
        channel,
        radioType: pending.radioType ?? null,
        authentication: curAuth,
        cipher: curCipher,
        isCurrent: !!currentBssid && pending.bssid?.toLowerCase() === currentBssid.toLowerCase()
      })
    }
    pending = null
  }

  for (const line of lines) {
    // "SSID 3 : MyNetwork"  (NOT "BSSID 1 : ..")
    if (/^\s*SSID\s+\d+\s*:/i.test(line) && !/^\s*BSSID/i.test(line)) {
      flush()
      curSsid = valueOf(line)
      curAuth = null
      curCipher = null
      continue
    }
    if (/^\s*Authentication\b/i.test(line)) { curAuth = valueOf(line) || null; continue }
    if (/^\s*Encryption\b/i.test(line)) { curCipher = valueOf(line) || null; continue }
    // "BSSID 1 : aa:bb:cc:dd:ee:ff"
    if (/^\s*BSSID\s+\d+\s*:/i.test(line)) {
      flush()
      pending = { bssid: valueOf(line) || null }
      continue
    }
    if (!pending) continue
    if (/^\s*Signal\b/i.test(line)) { pending.signalPercent = toInt(valueOf(line)); continue }
    if (/^\s*Radio type\b/i.test(line)) { pending.radioType = valueOf(line) || null; continue }
    if (/^\s*Channel\b/i.test(line)) { pending.channel = toInt(valueOf(line)); continue }
  }
  flush()

  // Strongest first; current connection floats to the top of equal signals.
  networks.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    return (b.signalPercent ?? -1) - (a.signalPercent ?? -1)
  })
  return networks
}

// ── Channel-occupancy roll-up ─────────────────────────────────────────────────

function buildChannelUsage(networks: WifiNetwork[]): WifiChannelUsage[] {
  const map = new Map<string, WifiChannelUsage>()
  for (const n of networks) {
    if (n.channel === null) continue
    const key = `${n.band}:${n.channel}`
    const existing = map.get(key)
    if (existing) {
      existing.networkCount++
      existing.strongestSignalPercent = Math.max(existing.strongestSignalPercent, n.signalPercent ?? 0)
    } else {
      map.set(key, {
        band: n.band,
        channel: n.channel,
        networkCount: 1,
        strongestSignalPercent: n.signalPercent ?? 0
      })
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.band === b.band ? a.channel - b.channel : a.band.localeCompare(b.band)
  )
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function scanWifi(): Promise<WifiScanResult> {
  const start = Date.now()
  const unavailable = (reason: string): WifiScanResult => ({
    available: false, reason, connection: null, networks: [], channelUsage: [], scanDurationMs: Date.now() - start
  })

  if (process.platform === 'darwin') return scanWifiMac(start, unavailable)
  if (process.platform !== 'win32') {
    return unavailable('Wi-Fi analysis is currently supported on Windows and macOS only.')
  }

  let ifaceOut: string
  try {
    ifaceOut = await runSpawn('netsh', ['wlan', 'show', 'interfaces'])
  } catch (err) {
    return unavailable(`Could not run netsh: ${err instanceof Error ? err.message : String(err)}`)
  }

  // No WLAN service / no wireless adapter present.
  if (/There is no wireless interface|not running|AutoConfig service/i.test(ifaceOut) && !/SSID/i.test(ifaceOut)) {
    return unavailable('No wireless adapter found, or the WLAN AutoConfig service is not running.')
  }

  const connection = parseInterfaces(ifaceOut)

  let networks: WifiNetwork[] = []
  try {
    const netOut = await runSpawn('netsh', ['wlan', 'show', 'networks', 'mode=bssid'])
    networks = parseNetworks(netOut, connection?.bssid ?? null)
  } catch {
    // A scan failure (e.g. adapter busy) still leaves us the current connection.
    networks = []
  }

  return {
    available: true,
    reason: null,
    connection,
    networks,
    channelUsage: buildChannelUsage(networks),
    scanDurationMs: Date.now() - start
  }
}

// ── macOS (system_profiler) ───────────────────────────────────────────────────

async function scanWifiMac(
  start: number,
  unavailable: (reason: string) => WifiScanResult
): Promise<WifiScanResult> {
  let out: string
  try {
    // ~3–4 s: system_profiler triggers a fresh scan.
    out = await runSpawn('/usr/sbin/system_profiler', ['SPAirPortDataType', '-json'], 30_000)
  } catch (err) {
    return unavailable(`Could not run system_profiler: ${err instanceof Error ? err.message : String(err)}`)
  }

  const parsed = parseSystemProfilerWifi(out)
  if (!parsed.interfaceFound) return unavailable('No Wi-Fi adapter found.')

  return {
    available: true,
    reason: null,
    notice: parsed.ssidsRedacted
      ? 'macOS hides Wi-Fi network names from apps without Location access, and does not expose BSSIDs. ' +
        'Channel, band, signal (dBm) and security are still accurate.'
      : null,
    connection: parsed.connection,
    networks: parsed.networks,
    channelUsage: buildChannelUsage(parsed.networks),
    scanDurationMs: Date.now() - start
  }
}
