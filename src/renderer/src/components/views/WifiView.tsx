import React, { useState, useCallback, useEffect } from 'react'
import type { WifiScanResult, WifiConnection, WifiNetwork, WifiChannelUsage, WifiSignalLevel, WifiBand } from '@shared/types'

// ── Signal helpers ────────────────────────────────────────────────────────────

function signalLevel(percent: number | null): WifiSignalLevel {
  const p = percent ?? 0
  if (p >= 75) return 'excellent'
  if (p >= 55) return 'good'
  if (p >= 35) return 'fair'
  return 'weak'
}

function signalColor(level: WifiSignalLevel): string {
  switch (level) {
    case 'excellent': return '#34d399'
    case 'good': return '#22d3ee'
    case 'fair': return '#f59e0b'
    case 'weak': return '#f87171'
  }
}

function bandColor(band: WifiBand): string {
  switch (band) {
    case '2.4 GHz': return '#f59e0b'
    case '5 GHz': return '#60a5fa'
    case '6 GHz': return '#a78bfa'
    default: return '#8b8b98'
  }
}

/** Compact vertical signal-bars icon (1–4 bars filled by strength). */
function SignalBars({ percent }: { percent: number | null }): React.JSX.Element {
  const level = signalLevel(percent)
  const filled = level === 'excellent' ? 4 : level === 'good' ? 3 : level === 'fair' ? 2 : 1
  const color = signalColor(level)
  return (
    <span className="inline-flex items-end gap-0.5 h-3.5">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} style={{
          width: 3, height: 4 + i * 3,
          background: i < filled ? color : '#3f3f4a', borderRadius: 1
        }} />
      ))}
    </span>
  )
}

// ── Current-connection card ─────────────────────────────────────────────────

function ConnectionCard({ conn }: { conn: WifiConnection }): React.JSX.Element {
  const level = signalLevel(conn.signalPercent)
  const color = signalColor(level)
  const connected = conn.state === 'connected'

  const Stat = ({ label, value }: { label: string; value: string | number | null }): React.JSX.Element => (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-fg-subtle font-semibold">{label}</span>
      <span className="text-sm text-fg-default font-mono">{value ?? '—'}</span>
    </div>
  )

  return (
    <div className="rounded-lg border border-border-default bg-canvas-subtle p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col items-center justify-center w-14 h-14 rounded-lg flex-shrink-0"
            style={{ background: color + '14', border: `1px solid ${color}40` }}>
            <span className="text-lg font-bold" style={{ color }}>{conn.signalPercent ?? '—'}</span>
            <span className="text-[9px] text-fg-subtle">%</span>
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold text-fg-default truncate">
              {connected ? (conn.ssid ?? 'Connected') : 'Not connected'}
            </div>
            <div className="text-xs text-fg-muted truncate">{conn.interfaceName}</div>
            {conn.rssiDbm !== null && (
              <div className="text-[11px] text-fg-subtle font-mono mt-0.5">~{conn.rssiDbm} dBm</div>
            )}
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-semibold flex-shrink-0"
          style={{ color, background: color + '14', border: `1px solid ${color}30` }}>
          <span className="w-2 h-2 rounded-full" style={{ background: color }} />
          {level}
        </span>
      </div>

      {connected && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 mt-4 pt-4 border-t border-border-muted">
          <Stat label="Band" value={conn.band} />
          <Stat label="Channel" value={conn.channel} />
          <Stat label="Radio" value={conn.radioType} />
          <Stat label="Security" value={conn.authentication} />
          <Stat label="Cipher" value={conn.cipher} />
          <Stat label="Rx rate" value={conn.rxRateMbps !== null ? `${conn.rxRateMbps} Mbps` : null} />
          <Stat label="Tx rate" value={conn.txRateMbps !== null ? `${conn.txRateMbps} Mbps` : null} />
          <Stat label="BSSID" value={conn.bssid} />
        </div>
      )}
    </div>
  )
}

// ── Channel congestion chart ──────────────────────────────────────────────────

function ChannelChart({ usage }: { usage: WifiChannelUsage[] }): React.JSX.Element {
  if (usage.length === 0) return <></>
  const maxCount = Math.max(...usage.map((u) => u.networkCount), 1)
  // Group by band so each band gets its own row of channels.
  const bands = Array.from(new Set(usage.map((u) => u.band)))
  return (
    <div className="rounded-lg border border-border-default bg-canvas-subtle p-4">
      <div className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-3">Channel usage</div>
      <div className="flex flex-col gap-4">
        {bands.map((band) => {
          const inBand = usage.filter((u) => u.band === band)
          return (
            <div key={band}>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="w-2 h-2 rounded-full" style={{ background: bandColor(band) }} />
                <span className="text-[11px] font-semibold" style={{ color: bandColor(band) }}>{band}</span>
              </div>
              <div className="flex items-end gap-1.5 h-20">
                {inBand.map((u) => {
                  const h = 12 + (u.networkCount / maxCount) * 56
                  return (
                    <div key={u.channel} className="flex flex-col items-center gap-1 flex-1 min-w-[18px]"
                      title={`Channel ${u.channel}: ${u.networkCount} network(s)`}>
                      <span className="text-[9px] text-fg-subtle font-mono">{u.networkCount}</span>
                      <div className="w-full rounded-t"
                        style={{ height: h, background: bandColor(band), opacity: 0.35 + 0.6 * (u.networkCount / maxCount) }} />
                      <span className="text-[9px] text-fg-muted font-mono">{u.channel}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Nearby networks table ─────────────────────────────────────────────────────

function NetworksTable({ networks }: { networks: WifiNetwork[] }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border-default bg-canvas-subtle overflow-hidden">
      <div className="px-4 py-2 border-b border-border-default flex items-center justify-between">
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wide">
          Nearby networks ({networks.length})
        </span>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 360 }}>
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-canvas-inset z-10">
            <tr className="text-fg-subtle text-left border-b border-border-muted">
              <th className="px-4 py-1.5 font-semibold">SSID</th>
              <th className="px-4 py-1.5 font-semibold w-28">Signal</th>
              <th className="px-3 py-1.5 font-semibold w-16">Band</th>
              <th className="px-3 py-1.5 font-semibold w-14">Ch</th>
              <th className="px-3 py-1.5 font-semibold w-24">Security</th>
              <th className="px-4 py-1.5 font-semibold">BSSID</th>
            </tr>
          </thead>
          <tbody>
            {networks.map((n, i) => {
              const color = signalColor(signalLevel(n.signalPercent))
              return (
                <tr key={(n.bssid ?? '') + i}
                  className={`border-b border-border-muted/50 hover:bg-canvas-hover/50 ${n.isCurrent ? 'bg-accent-blue/5' : ''}`}>
                  <td className="px-4 py-1.5">
                    <span className="text-fg-default">{n.ssid || <span className="text-fg-subtle italic">hidden</span>}</span>
                    {n.isCurrent && (
                      <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-semibold"
                        style={{ color: '#34d399', background: '#34d39920' }}>connected</span>
                    )}
                  </td>
                  <td className="px-4 py-1.5">
                    <span className="inline-flex items-center gap-2">
                      <SignalBars percent={n.signalPercent} />
                      <span className="font-mono" style={{ color }}>{n.signalPercent ?? '—'}%</span>
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    <span style={{ color: bandColor(n.band) }}>{n.band === 'unknown' ? '—' : n.band}</span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-fg-muted">{n.channel ?? '—'}</td>
                  <td className="px-3 py-1.5 text-fg-muted truncate">{n.authentication ?? '—'}</td>
                  <td className="px-4 py-1.5 font-mono text-fg-subtle">{n.bssid ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main view ──────────────────────────────────────────────────────────────────

export function WifiView(): React.JSX.Element {
  const [result, setResult] = useState<WifiScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleScan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      setResult(await window.nmtrAPI.wifiScan())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }, [])

  // Auto-scan on first open.
  useEffect(() => { handleScan() }, [handleScan])

  return (
    <div className="flex-1 flex flex-col bg-canvas-default overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-5 py-2 border-b border-border-default bg-canvas-inset flex-shrink-0">
        <span className="text-xs font-semibold text-fg-muted tracking-wide uppercase">Wi-Fi</span>
        {result?.available && (
          <span className="text-[11px] text-fg-subtle font-mono">
            {result.networks.length} network{result.networks.length !== 1 ? 's' : ''} in range
            <span className="mx-1 opacity-40">|</span>
            {(result.scanDurationMs / 1000).toFixed(1)}s
          </span>
        )}
        <div className="ml-auto">
          <button onClick={handleScan} disabled={scanning}
            className="px-3 py-1 text-[11px] font-medium rounded border border-border-default text-fg-muted hover:text-fg-default hover:bg-canvas-hover transition-colors disabled:opacity-50">
            {scanning ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {scanning && !result && (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="wifi-spinner" />
            <p className="text-fg-muted text-sm">Scanning for wireless networks…</p>
            <style>{`.wifi-spinner{width:40px;height:40px;border:3px solid #3f3f4a;border-top-color:#60a5fa;border-radius:50%;animation:wifi-spin .8s linear infinite}@keyframes wifi-spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">{error}</div>
        )}

        {result && !result.available && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5" opacity={0.6}>
              <path d="M5 12.55a11 11 0 0 1 14 0M8.5 16.1a6 6 0 0 1 7 0M2 8.82a15 15 0 0 1 20 0" strokeLinecap="round" />
              <line x1="2" y1="2" x2="22" y2="22" strokeLinecap="round" stroke="#f87171" />
            </svg>
            <p className="text-fg-subtle text-sm font-medium">Wi-Fi unavailable</p>
            <p className="text-fg-muted text-xs max-w-sm">{result.reason}</p>
          </div>
        )}

        {result?.available && (
          <div className="flex flex-col gap-5 max-w-5xl mx-auto">
            {result.notice && (
              <div className="rounded-lg border border-border-default bg-canvas-subtle px-4 py-2.5 text-xs text-fg-muted">
                {result.notice}
              </div>
            )}
            {result.connection && <ConnectionCard conn={result.connection} />}
            {result.channelUsage.length > 0 && <ChannelChart usage={result.channelUsage} />}
            <NetworksTable networks={result.networks} />
          </div>
        )}
      </div>
    </div>
  )
}
