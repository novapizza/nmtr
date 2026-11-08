/**
 * macOS Wi-Fi parsing — `system_profiler SPAirPortDataType -json`.
 *
 * The `airport` CLI is gone on current macOS and `wdutil` needs sudo, so
 * system_profiler is the only no-privilege source. It gives channel, band,
 * PHY mode, security and a real signal/noise in dBm for the current network
 * and for nearby ones. Limitation: macOS redacts SSIDs ("<redacted>") for
 * apps without Location access and never reports BSSIDs here.
 *
 * Pure module (no Electron imports) so it can be unit-tested.
 */
import type { WifiBand, WifiConnection, WifiNetwork } from '../../shared/types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type SpNetwork = Record<string, any>

export interface MacWifiParseResult {
  connection: WifiConnection | null
  networks: WifiNetwork[]
  /** true if at least one SSID was hidden by macOS privacy redaction. */
  ssidsRedacted: boolean
  /** null when there is no Wi-Fi interface at all. */
  interfaceFound: boolean
}

/** dBm → 0–100 %, the inverse of the Windows mapping (dBm ≈ % / 2 − 100). */
export function dbmToPercent(dbm: number | null): number | null {
  if (dbm === null) return null
  return Math.max(0, Math.min(100, Math.round((dbm + 100) * 2)))
}

/** "52 (5GHz, 160MHz)" / "6 (2GHz, 20MHz)" / "37 (6GHz, 320MHz)" / "149" */
export function parseSpChannel(raw: unknown): { channel: number | null; band: WifiBand } {
  const s = String(raw ?? '')
  const m = s.match(/^\s*(\d+)/)
  const channel = m ? parseInt(m[1], 10) : null
  let band: WifiBand = 'unknown'
  if (/\(\s*2(?:\.4)?\s*GHz/i.test(s)) band = '2.4 GHz'
  else if (/\(\s*5\s*GHz/i.test(s)) band = '5 GHz'
  else if (/\(\s*6\s*GHz/i.test(s)) band = '6 GHz'
  else if (channel !== null) {
    if (channel >= 1 && channel <= 14) band = '2.4 GHz'
    else if (channel >= 32 && channel <= 177) band = '5 GHz'
  }
  return { channel, band }
}

/** "-55 dBm / -91 dBm" → -55 */
export function parseSpSignal(raw: unknown): number | null {
  const m = String(raw ?? '').match(/(-?\d+)\s*dBm/i)
  return m ? parseInt(m[1], 10) : null
}

const SECURITY_LABELS: Record<string, string> = {
  none: 'Open',
  owe: 'OWE (Enhanced Open)',
  wep: 'WEP',
  wpa_personal: 'WPA-Personal',
  wpa_personal_mixed: 'WPA/WPA2-Personal',
  wpa2_personal: 'WPA2-Personal',
  wpa2_personal_mixed: 'WPA/WPA2-Personal',
  wpa3_personal: 'WPA3-Personal',
  wpa3_transition: 'WPA2/WPA3-Personal',
  wpa_enterprise: 'WPA-Enterprise',
  wpa_enterprise_mixed: 'WPA/WPA2-Enterprise',
  wpa2_enterprise: 'WPA2-Enterprise',
  wpa3_enterprise: 'WPA3-Enterprise'
}

/** "spairport_security_mode_wpa2_personal" (sometimes typo'd "pairport_…") → "WPA2-Personal" */
export function parseSpSecurity(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  const key = String(raw).replace(/^s?pairport_security_mode_/, '')
  return SECURITY_LABELS[key] ?? key.replace(/_/g, ' ').toUpperCase()
}

function ssidOf(n: SpNetwork): { ssid: string; redacted: boolean } {
  const name = typeof n._name === 'string' ? n._name : ''
  if (/^<redacted>$/i.test(name)) return { ssid: '', redacted: true }
  return { ssid: name, redacted: false }
}

function toNetwork(n: SpNetwork): WifiNetwork {
  const { channel, band } = parseSpChannel(n.spairport_network_channel)
  const rssi = parseSpSignal(n.spairport_signal_noise)
  return {
    ssid: ssidOf(n).ssid,
    bssid: null,
    signalPercent: dbmToPercent(rssi),
    rssiDbm: rssi,
    band,
    channel,
    radioType: n.spairport_network_phymode ?? null,
    authentication: parseSpSecurity(n.spairport_security_mode),
    cipher: null,
    isCurrent: false
  }
}

export function parseSystemProfilerWifi(json: string): MacWifiParseResult {
  const empty: MacWifiParseResult = { connection: null, networks: [], ssidsRedacted: false, interfaceFound: false }
  let data: any
  try { data = JSON.parse(json) } catch { return empty }

  const ifaces: SpNetwork[] = (data?.SPAirPortDataType ?? [])
    .flatMap((d: SpNetwork) => d?.spairport_airport_interfaces ?? [])
    // awdl0 / llw0 are AirDrop/low-latency virtual links, not the Wi-Fi radio.
    .filter((i: SpNetwork) => typeof i?._name === 'string' && /^en\d+$/.test(i._name))
  if (ifaces.length === 0) return empty

  const iface =
    ifaces.find((i) => i.spairport_status_information === 'spairport_status_connected') ?? ifaces[0]

  const status = String(iface.spairport_status_information ?? 'unknown').replace(/^spairport_status_/, '')
  const cur: SpNetwork | undefined = iface.spairport_current_network_information
  const others: SpNetwork[] = iface.spairport_airport_other_local_wireless_networks ?? []

  let redacted = others.some((n) => ssidOf(n).redacted)

  let connection: WifiConnection | null = null
  let currentNet: WifiNetwork | null = null
  if (cur && cur.spairport_network_channel) {
    const { channel, band } = parseSpChannel(cur.spairport_network_channel)
    const rssi = parseSpSignal(cur.spairport_signal_noise)
    const { ssid, redacted: curRedacted } = ssidOf(cur)
    redacted = redacted || curRedacted
    const rate = typeof cur.spairport_network_rate === 'number' ? cur.spairport_network_rate : null
    connection = {
      interfaceName: `Wi-Fi (${iface._name})`,
      state: status,
      ssid: ssid || null,
      bssid: null,
      radioType: cur.spairport_network_phymode ?? null,
      authentication: parseSpSecurity(cur.spairport_security_mode),
      cipher: null,
      band,
      channel,
      signalPercent: dbmToPercent(rssi),
      rssiDbm: rssi,
      rxRateMbps: null,
      txRateMbps: rate
    }
    currentNet = { ...toNetwork(cur), isCurrent: true }
  } else {
    connection = {
      interfaceName: `Wi-Fi (${iface._name})`,
      state: status === 'connected' ? 'disconnected' : status,
      ssid: null, bssid: null, radioType: null, authentication: null, cipher: null,
      band: 'unknown', channel: null, signalPercent: null, rssiDbm: null, rxRateMbps: null, txRateMbps: null
    }
  }

  const networks = others.map(toNetwork)

  // The scan list usually contains our own AP too. Without BSSIDs we match it
  // by channel + security + PHY mode, and only trust a unique match.
  if (currentNet) {
    const matches = networks.filter((n) =>
      n.channel === currentNet!.channel &&
      n.authentication === currentNet!.authentication &&
      (currentNet!.ssid === '' || n.ssid === currentNet!.ssid)
    )
    if (matches.length === 1) {
      matches[0].isCurrent = true
      if (matches[0].rssiDbm === null) {
        matches[0].rssiDbm = currentNet.rssiDbm
        matches[0].signalPercent = currentNet.signalPercent
      }
    } else {
      networks.push(currentNet)
    }
  }

  networks.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    return (b.signalPercent ?? -1) - (a.signalPercent ?? -1)
  })

  return { connection, networks, ssidsRedacted: redacted, interfaceFound: true }
}
