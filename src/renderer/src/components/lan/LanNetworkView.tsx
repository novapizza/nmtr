import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { LanScanResult, LanDevice, NetworkInterface, DeviceType } from '@shared/types'
import { useUIStore } from '../../store/useUIStore'

// ── Topology layout constants ────────────────────────────────────────────────

const TIER_GAP = 160        // vertical space between tiers
const NODE_GAP_X = 170      // horizontal space between device nodes
const DEVICE_COLS_MAX = 6   // max devices per row before wrapping
const PAD_X = 80
const PAD_TOP = 50

// ── SVG icon paths (inline, no emoji) ────────────────────────────────────────

function CloudIcon({ x, y }: { x: number; y: number }): React.JSX.Element {
  return (
    <g transform={`translate(${x - 30},${y - 20}) scale(1.5)`}>
      <path
        d="M8 28h24a8 8 0 0 0 1.6-15.8A10 10 0 0 0 14 8a10 10 0 0 0-9.8 12.1A6 6 0 0 0 8 28z"
        fill="#2a2a32" stroke="#6b6b78" strokeWidth={1.2}
      />
      <text x={20} y={22} textAnchor="middle" fontSize={8} fill="#8b8b98"
        fontWeight={600} style={{ userSelect: 'none', pointerEvents: 'none' }}>
        WAN
      </text>
    </g>
  )
}

function RouterIcon({ x, y, size }: { x: number; y: number; size: number }): React.JSX.Element {
  const s = size
  return (
    <g transform={`translate(${x - s},${y - s})`}>
      <rect x={0} y={0} width={s * 2} height={s * 2} rx={6} ry={6}
        fill="#1e3a5f" stroke="#3b82f6" strokeWidth={2} />
      {/* Router arrows icon */}
      <path d={`M${s - 6},${s} h12 M${s + 3},${s - 4} l3,4 l-3,4`}
        stroke="#60a5fa" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d={`M${s + 6},${s} h-12 M${s - 3},${s - 4} l-3,4 l3,4`}
        stroke="#60a5fa" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round"
        transform={`translate(0,${s * 0.55})`} />
    </g>
  )
}

function SwitchIcon({ x, y, w, h }: { x: number; y: number; w: number; h: number }): React.JSX.Element {
  return (
    <g>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={4} ry={4}
        fill="#1a2e1a" stroke="#059669" strokeWidth={1.5} />
      {/* Port dots */}
      {Array.from({ length: Math.min(8, Math.floor(w / 16)) }).map((_, i) => {
        const dotX = x - w / 2 + 12 + i * 14
        return (
          <rect key={i} x={dotX} y={y - 3} width={6} height={6} rx={1}
            fill="#34d399" opacity={0.7} />
        )
      })}
    </g>
  )
}

function DeviceIcon({ x, y, size, deviceType }: { x: number; y: number; size: number; deviceType: DeviceType }): React.JSX.Element {
  const s = size
  const colors = deviceTypeColor(deviceType)

  if (deviceType === 'phone') {
    return (
      <g transform={`translate(${x - s * 0.5},${y - s})`}>
        <rect x={0} y={0} width={s} height={s * 1.8} rx={3} ry={3}
          fill={colors.bg} stroke={colors.stroke} strokeWidth={1.5} />
        <rect x={s * 0.15} y={s * 0.2} width={s * 0.7} height={s * 1.1} rx={1}
          fill="#1e1e24" stroke="none" />
        <circle cx={s * 0.5} cy={s * 1.6} r={2} fill={colors.stroke} opacity={0.5} />
      </g>
    )
  }

  if (deviceType === 'tablet') {
    return (
      <g transform={`translate(${x - s * 0.75},${y - s * 0.65})`}>
        <rect x={0} y={0} width={s * 1.5} height={s * 1.3} rx={3} ry={3}
          fill={colors.bg} stroke={colors.stroke} strokeWidth={1.5} />
        <rect x={s * 0.12} y={s * 0.12} width={s * 1.1} height={s * 1.06} rx={1}
          fill="#1e1e24" stroke="none" />
        <circle cx={s * 1.38} cy={s * 0.65} r={1.5} fill={colors.stroke} opacity={0.5} />
      </g>
    )
  }

  if (deviceType === 'camera') {
    return (
      <g transform={`translate(${x - s * 0.7},${y - s * 0.7})`}>
        <circle cx={s * 0.7} cy={s * 0.7} r={s * 0.7}
          fill={colors.bg} stroke={colors.stroke} strokeWidth={1.5} />
        <circle cx={s * 0.7} cy={s * 0.7} r={s * 0.35}
          fill="#1e1e24" stroke={colors.stroke} strokeWidth={1} />
        <circle cx={s * 0.7} cy={s * 0.7} r={s * 0.12} fill={colors.stroke} opacity={0.6} />
      </g>
    )
  }

  if (deviceType === 'iot') {
    return (
      <g transform={`translate(${x - s * 0.6},${y - s * 0.6})`}>
        <rect x={0} y={0} width={s * 1.2} height={s * 1.2} rx={s * 0.3}
          fill={colors.bg} stroke={colors.stroke} strokeWidth={1.5} />
        <circle cx={s * 0.6} cy={s * 0.5} r={s * 0.18} fill={colors.stroke} opacity={0.8} />
        <path d={`M${s * 0.3},${s * 0.9} Q${s * 0.6},${s * 0.7} ${s * 0.9},${s * 0.9}`}
          stroke={colors.stroke} strokeWidth={1} fill="none" opacity={0.5} />
      </g>
    )
  }

  if (deviceType === 'printer') {
    return (
      <g transform={`translate(${x - s * 0.7},${y - s * 0.55})`}>
        <rect x={0} y={s * 0.2} width={s * 1.4} height={s * 0.8} rx={2}
          fill={colors.bg} stroke={colors.stroke} strokeWidth={1.5} />
        <rect x={s * 0.2} y={0} width={s} height={s * 0.35} rx={1}
          fill={colors.bg} stroke={colors.stroke} strokeWidth={1} />
        <rect x={s * 0.3} y={s * 0.75} width={s * 0.8} height={s * 0.35} rx={1}
          fill="#1e1e24" stroke="none" />
      </g>
    )
  }

  if (deviceType === 'media') {
    return (
      <g transform={`translate(${x - s * 0.7},${y - s * 0.5})`}>
        <rect x={0} y={0} width={s * 1.4} height={s} rx={3}
          fill={colors.bg} stroke={colors.stroke} strokeWidth={1.5} />
        <polygon points={`${s * 0.5},${s * 0.25} ${s * 0.5},${s * 0.75} ${s * 0.95},${s * 0.5}`}
          fill={colors.stroke} opacity={0.7} />
      </g>
    )
  }

  // Default: laptop/desktop shape
  return (
    <g transform={`translate(${x - s},${y - s * 0.7})`}>
      <rect x={s * 0.15} y={0} width={s * 1.7} height={s * 1.1} rx={2} ry={2}
        fill={colors.bg} stroke={colors.stroke} strokeWidth={1.5} />
      <rect x={s * 0.3} y={s * 0.15} width={s * 1.4} height={s * 0.8} rx={1}
        fill="#1e1e24" stroke="none" />
      <rect x={0} y={s * 1.2} width={s * 2} height={s * 0.2} rx={1}
        fill={colors.bg} stroke={colors.stroke} strokeWidth={1} />
    </g>
  )
}

function deviceTypeColor(dt: DeviceType): { bg: string; stroke: string; text: string } {
  switch (dt) {
    case 'router': case 'ap': return { bg: '#1e3a5f', stroke: '#3b82f6', text: '#60a5fa' }
    case 'phone': return { bg: '#2d1f4e', stroke: '#8b5cf6', text: '#a78bfa' }
    case 'tablet': return { bg: '#2d1f4e', stroke: '#8b5cf6', text: '#a78bfa' }
    case 'laptop': case 'desktop': return { bg: '#2d2040', stroke: '#7c3aed', text: '#a78bfa' }
    case 'camera': return { bg: '#1a2e3a', stroke: '#06b6d4', text: '#22d3ee' }
    case 'iot': return { bg: '#2a2a1a', stroke: '#84cc16', text: '#a3e635' }
    case 'printer': return { bg: '#2a2020', stroke: '#f97316', text: '#fb923c' }
    case 'media': return { bg: '#2a1a2a', stroke: '#ec4899', text: '#f472b6' }
    case 'server': return { bg: '#1a2a2a', stroke: '#14b8a6', text: '#2dd4bf' }
    default: return { bg: '#2d2040', stroke: '#7c3aed', text: '#a78bfa' }
  }
}

function deviceTypeLabel(dt: DeviceType): string {
  switch (dt) {
    case 'router': return 'Router'
    case 'ap': return 'Access Point'
    case 'phone': return 'Phone'
    case 'tablet': return 'Tablet'
    case 'laptop': return 'Laptop'
    case 'desktop': return 'Desktop'
    case 'camera': return 'Camera'
    case 'iot': return 'IoT'
    case 'printer': return 'Printer'
    case 'media': return 'Media'
    case 'server': return 'Server'
    default: return 'Device'
  }
}

function VpnShieldIcon({ x, y }: { x: number; y: number }): React.JSX.Element {
  return (
    <g transform={`translate(${x - 20},${y - 22}) scale(1.4)`}>
      <path d="M14 2 L2 8 L2 16 C2 24 14 30 14 30 C14 30 26 24 26 16 L26 8 Z"
        fill="#3b2f0a" stroke="#f59e0b" strokeWidth={1.2} />
      <path d="M10 16 l3 3 l5 -6" stroke="#f59e0b" strokeWidth={1.8} fill="none"
        strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

interface TooltipState {
  device: LanDevice
  x: number
  y: number
}

function DeviceTooltip({ device, x, y }: TooltipState): React.JSX.Element {
  const dtColor = deviceTypeColor(device.deviceType)
  return (
    <div style={{
      position: 'fixed', left: x + 14, top: y - 14,
      background: '#17171d', border: '1px solid #3f3f4a', borderRadius: 8,
      padding: '10px 14px', fontSize: 11, color: '#e2e2e8',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)', pointerEvents: 'none',
      zIndex: 9999, minWidth: 210, lineHeight: '1.7'
    }}>
      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>
        {device.hostname ?? device.ip}
      </div>
      <div style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{device.ip}</div>
      {device.mac && (
        <div style={{ color: '#6b6b78', fontFamily: 'monospace', fontSize: 10 }}>
          {device.mac}
          {device.isRandomizedMac && (
            <span style={{ color: '#f59e0b', marginLeft: 6, fontFamily: 'inherit' }}>randomized</span>
          )}
        </div>
      )}
      {device.vendor && (
        <div style={{ color: '#a78bfa', fontSize: 10, marginTop: 2 }}>{device.vendor}</div>
      )}
      <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid #3f3f4a', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <span style={{
          display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: 9,
          background: dtColor.text + '20', color: dtColor.text, border: `1px solid ${dtColor.text}40`
        }}>{deviceTypeLabel(device.deviceType)}</span>
        {device.isGateway && (
          <span style={{
            display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: 9,
            background: '#3b82f620', color: '#60a5fa', border: '1px solid #3b82f640'
          }}>Gateway</span>
        )}
        {device.isSelf && (
          <span style={{
            display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: 9,
            background: '#34d39920', color: '#34d399', border: '1px solid #34d39940'
          }}>This Device</span>
        )}
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ifaceColor(type: NetworkInterface['type']): string {
  switch (type) {
    case 'wifi': return '#60a5fa'
    case 'ethernet': return '#34d399'
    case 'vpn': return '#f59e0b'
    case 'warp': return '#fb923c'
    default: return '#8b8b98'
  }
}

function ifaceIcon(type: NetworkInterface['type']): string {
  switch (type) {
    case 'wifi': return 'Wi-Fi'
    case 'ethernet': return 'ETH'
    case 'vpn': return 'VPN'
    case 'warp': return 'WARP'
    default: return 'NET'
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max - 1) + '\u2026' : s
}

// ── Curved connection path ───────────────────────────────────────────────────

function ConnectionPath({ x1, y1, x2, y2, color, dash }: {
  x1: number; y1: number; x2: number; y2: number; color: string; dash?: boolean
}): React.JSX.Element {
  const midY = (y1 + y2) / 2
  const d = `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`
  return (
    <path d={d} fill="none" stroke={color} strokeWidth={1.5}
      strokeDasharray={dash ? '4 3' : undefined} opacity={0.6} />
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export function LanNetworkView(): React.JSX.Element {
  const [scanResult, setScanResult] = useState<LanScanResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(900)
  const scanPortsFor = useUIStore((s) => s.scanPortsFor)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleScan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      const result = await window.nmtrAPI.lanScan()
      setScanResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }, [])

  // ── Compute topology layout ──
  const topo = useMemo(() => {
    if (!scanResult) return null

    const { devices, vpnInterfaces } = scanResult
    const gateway = devices.find((d) => d.isGateway)
    const self = devices.find((d) => d.isSelf && !d.isGateway)
    const others = devices.filter((d) => !d.isGateway && !d.isSelf)
    const hasVpn = vpnInterfaces.length > 0

    // Available width for device grid
    const availW = Math.max(containerWidth - PAD_X * 2, 400)
    const cols = Math.min(others.length || 1, DEVICE_COLS_MAX, Math.floor(availW / NODE_GAP_X))
    const rows = Math.ceil(others.length / cols)

    // Tier Y positions (top-down)
    const tierCloud = PAD_TOP
    const tierGw = tierCloud + TIER_GAP * 0.8
    const tierVpn = hasVpn ? tierGw + TIER_GAP * 0.7 : tierGw
    const tierSwitch = tierVpn + TIER_GAP * 0.7
    const tierDevicesStart = tierSwitch + TIER_GAP * 0.8

    const centerX = Math.max(availW / 2 + PAD_X, 300)

    // Device grid positions
    const devicePositions = others.map((d, i) => {
      const row = Math.floor(i / cols)
      const col = i % cols
      const rowCount = Math.min(cols, others.length - row * cols)
      const rowWidth = (rowCount - 1) * NODE_GAP_X
      const x = centerX - rowWidth / 2 + col * NODE_GAP_X
      const y = tierDevicesStart + row * (TIER_GAP * 0.85)
      return { device: d, x, y }
    })

    const svgH = Math.max(tierDevicesStart + rows * (TIER_GAP * 0.85) + 80, 500)
    const svgW = Math.max(availW + PAD_X * 2, 700)

    // Switch bar width
    const switchW = others.length > 0
      ? Math.min(Math.max((cols - 1) * NODE_GAP_X + 60, 120), availW - 40)
      : 120

    return {
      gateway, self, others, hasVpn, vpnInterfaces,
      centerX, tierCloud, tierGw, tierVpn, tierSwitch, tierDevicesStart,
      devicePositions, svgH, svgW, switchW
    }
  }, [scanResult, containerWidth])

  // ── Empty state ──
  if (!scanResult && !scanning) {
    return (
      <div className="flex-1 flex flex-col bg-canvas-default">
        <div className="flex-1 flex flex-col items-center justify-center gap-5">
          <svg width="72" height="72" viewBox="0 0 40 40" fill="none" stroke="#4b5563" strokeWidth="1.2" opacity={0.5}>
            <rect x="14" y="2" width="12" height="8" rx="2" />
            <rect x="2" y="30" width="12" height="8" rx="2" />
            <rect x="26" y="30" width="12" height="8" rx="2" />
            <path d="M20 10v8M20 18H8M20 18h12M8 18v12M32 18v12" strokeLinecap="round" />
          </svg>
          <div className="text-center">
            <p className="text-fg-subtle text-base font-medium mb-1">LAN Network Topology</p>
            <p className="text-fg-muted text-sm">Discover devices on your local network</p>
          </div>
          <button onClick={handleScan}
            className="px-6 py-2 text-sm font-semibold rounded-lg bg-accent-blue text-canvas-default hover:opacity-90 transition-opacity">
            Scan Network
          </button>
          {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
        </div>
      </div>
    )
  }

  if (scanning) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-canvas-default gap-4">
        <div className="lan-topo-spinner" />
        <p className="text-fg-muted text-sm">Discovering network devices...</p>
        <p className="text-fg-subtle text-xs">Pinging subnet & resolving hostnames</p>
        <style>{`
          .lan-topo-spinner {
            width: 40px; height: 40px;
            border: 3px solid #3f3f4a;
            border-top-color: #34d399;
            border-radius: 50%;
            animation: lan-topo-spin 0.8s linear infinite;
          }
          @keyframes lan-topo-spin { to { transform: rotate(360deg); } }
        `}</style>
      </div>
    )
  }

  if (!scanResult || !topo) return <></>

  const {
    gateway, self, others, hasVpn, vpnInterfaces,
    centerX, tierCloud, tierGw, tierVpn, tierSwitch, tierDevicesStart,
    devicePositions, svgH, svgW, switchW
  } = topo

  const handleMouse = (d: LanDevice) => ({
    onMouseEnter: (e: React.MouseEvent) => {
      setHovered(d.ip)
      setTooltip({ device: d, x: e.clientX, y: e.clientY })
    },
    onMouseMove: (e: React.MouseEvent) => {
      setTooltip((prev) => prev ? { ...prev, x: e.clientX, y: e.clientY } : null)
    },
    onMouseLeave: () => {
      setHovered(null)
      setTooltip(null)
    }
  })

  return (
    <div className="flex-1 flex flex-col bg-canvas-default overflow-hidden">
      {/* ── Top bar ── */}
      <div className="flex items-center gap-3 px-5 py-2 border-b border-border-default bg-canvas-inset flex-shrink-0 flex-wrap">
        <span className="text-xs font-semibold text-fg-muted tracking-wide uppercase">Topology</span>
        <div className="h-4 w-px bg-border-default" />

        {/* Interface badges */}
        {scanResult.interfaces.map((iface) => (
          <span key={iface.name + iface.ip}
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium"
            style={{
              color: ifaceColor(iface.type),
              background: ifaceColor(iface.type) + '12',
              border: `1px solid ${ifaceColor(iface.type)}30`
            }}>
            <span className="font-bold text-[9px] opacity-80">{ifaceIcon(iface.type)}</span>
            {iface.name}
            <span className="opacity-60 font-mono">{iface.ip}</span>
          </span>
        ))}

        {hasVpn && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold"
            style={{ color: '#f59e0b', background: '#f59e0b12', border: '1px solid #f59e0b30' }}>
            VPN Active
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          <span className="text-[11px] text-fg-subtle font-mono">
            {scanResult.devices.length} device{scanResult.devices.length !== 1 ? 's' : ''}
            <span className="mx-1 opacity-40">|</span>
            {(scanResult.scanDurationMs / 1000).toFixed(1)}s
          </span>
          <button onClick={handleScan} disabled={scanning}
            className="px-3 py-1 text-[11px] font-medium rounded border border-border-default text-fg-muted hover:text-fg-default hover:bg-canvas-hover transition-colors">
            Rescan
          </button>
        </div>
      </div>

      {scanResult.notice && (
        <div className="px-5 py-2 border-b border-border-default bg-canvas-subtle text-xs text-fg-muted flex-shrink-0">
          {scanResult.notice}
        </div>
      )}

      {/* ── Topology canvas (top, ~60%) ── */}
      <div ref={containerRef} className="overflow-auto" style={{ flex: '3 1 0%', minHeight: 0 }}>
        <svg width={svgW} height={svgH} className="block mx-auto">
          <defs>
            <filter id="glow-blue" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="glow-green" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* ── TIER 0: Internet cloud ── */}
          <CloudIcon x={centerX} y={tierCloud} />

          {/* Cloud → Gateway link */}
          {gateway && (
            <line x1={centerX} y1={tierCloud + 26} x2={centerX} y2={tierGw - 32}
              stroke="#4b5563" strokeWidth={2} strokeDasharray="8 4" />
          )}

          {/* ── TIER 1: Gateway / Router ── */}
          {gateway && (
            <g style={{ cursor: 'pointer' }} {...handleMouse(gateway)}>
              <RouterIcon x={centerX} y={tierGw} size={30} />
              {hovered === gateway.ip && (
                <rect x={centerX - 32} y={tierGw - 32} width={64} height={64} rx={8}
                  fill="none" stroke="#3b82f6" strokeWidth={2} opacity={0.5}
                  filter="url(#glow-blue)" />
              )}
              <text x={centerX} y={tierGw + 42} textAnchor="middle"
                fontSize={13} fontWeight={600} fill="#60a5fa"
                style={{ userSelect: 'none', pointerEvents: 'none' }}>
                {gateway.hostname ? truncate(gateway.hostname, 24) : gateway.ip}
              </text>
              <text x={centerX} y={tierGw + 56} textAnchor="middle"
                fontSize={11} fill="#4b5563" fontFamily="monospace"
                style={{ userSelect: 'none', pointerEvents: 'none' }}>
                {gateway.ip}{gateway.vendor ? ` \u00b7 ${gateway.vendor}` : ''}
              </text>
              {/* Role label */}
              <rect x={centerX - 30} y={tierGw - 44} width={60} height={16} rx={4}
                fill="#3b82f620" stroke="#3b82f640" strokeWidth={0.5} />
              <text x={centerX} y={tierGw - 31} textAnchor="middle"
                fontSize={10} fontWeight={700} fill="#60a5fa" letterSpacing={0.8}
                style={{ userSelect: 'none', pointerEvents: 'none' }}>
                ROUTER
              </text>
            </g>
          )}

          {/* Gateway → VPN link (if VPN present) */}
          {gateway && hasVpn && (
            <line x1={centerX} y1={tierGw + 30} x2={centerX} y2={tierVpn - 24}
              stroke="#f59e0b" strokeWidth={2} opacity={0.5} />
          )}

          {/* ── TIER 1.5: VPN / Tunnel (optional) ── */}
          {hasVpn && vpnInterfaces.map((v, vi) => {
            const vx = centerX + (vi - (vpnInterfaces.length - 1) / 2) * 130
            return (
              <g key={v.name + v.ip}>
                <VpnShieldIcon x={vx} y={tierVpn} />
                <text x={vx} y={tierVpn + 28} textAnchor="middle"
                  fontSize={11} fontWeight={600} fill="#f59e0b"
                  style={{ userSelect: 'none', pointerEvents: 'none' }}>
                  {v.type === 'warp' ? 'WARP' : 'VPN'}
                </text>
                <text x={vx} y={tierVpn + 42} textAnchor="middle"
                  fontSize={10} fill="#6b6b78" fontFamily="monospace"
                  style={{ userSelect: 'none', pointerEvents: 'none' }}>
                  {v.ip}
                </text>
              </g>
            )
          })}

          {/* VPN → Switch link or Gateway → Switch link */}
          <line x1={centerX} y1={(hasVpn ? tierVpn : tierGw) + (hasVpn ? 44 : 30)}
            x2={centerX} y2={tierSwitch - 16}
            stroke="#059669" strokeWidth={2} opacity={0.4} />

          {/* ── TIER 2: Switch / Hub bar ── */}
          <SwitchIcon x={centerX} y={tierSwitch} w={switchW} h={30} />

          {/* "This device" label on switch if self exists */}
          {self && (
            <g style={{ cursor: 'pointer' }} {...handleMouse(self)}>
              {/* Self indicator attached to the switch */}
              <circle cx={centerX + switchW / 2 + 32} cy={tierSwitch} r={14}
                fill="#0f2a1f" stroke="#34d399" strokeWidth={2} />
              {hovered === self.ip && (
                <circle cx={centerX + switchW / 2 + 32} cy={tierSwitch} r={20}
                  fill="none" stroke="#34d399" strokeWidth={1.5} opacity={0.4}
                  filter="url(#glow-green)" />
              )}
              <text x={centerX + switchW / 2 + 32} y={tierSwitch + 4} textAnchor="middle"
                fontSize={9} fontWeight={800} fill="#34d399"
                style={{ userSelect: 'none', pointerEvents: 'none' }}>
                YOU
              </text>
              <line x1={centerX + switchW / 2} y1={tierSwitch} x2={centerX + switchW / 2 + 18} y2={tierSwitch}
                stroke="#34d399" strokeWidth={2} opacity={0.5} />
              <text x={centerX + switchW / 2 + 32} y={tierSwitch + 26} textAnchor="middle"
                fontSize={11} fill="#34d399" fontWeight={600}
                style={{ userSelect: 'none', pointerEvents: 'none' }}>
                {self.hostname ? truncate(self.hostname, 20) : self.ip}
              </text>
              <text x={centerX + switchW / 2 + 32} y={tierSwitch + 39} textAnchor="middle"
                fontSize={10} fill="#4b5563" fontFamily="monospace"
                style={{ userSelect: 'none', pointerEvents: 'none' }}>
                {self.ip}
              </text>
            </g>
          )}

          {/* Switch label */}
          <rect x={centerX - 28} y={tierSwitch - 24} width={56} height={16} rx={4}
            fill="#059669" opacity={0.15} />
          <text x={centerX} y={tierSwitch - 12} textAnchor="middle"
            fontSize={10} fontWeight={700} fill="#34d399" letterSpacing={0.8}
            style={{ userSelect: 'none', pointerEvents: 'none' }}>
            SWITCH
          </text>

          {/* ── TIER 3: Device connections & nodes ── */}
          {devicePositions.map(({ device, x, y }) => {
            const isHov = hovered === device.ip
            return (
              <g key={device.ip}>
                {/* Connection from switch to device */}
                <ConnectionPath
                  x1={centerX} y1={tierSwitch + 16}
                  x2={x} y2={y - 20}
                  color={isHov ? '#7c3aed' : '#3f3f4a'}
                  dash={!isHov}
                />
              </g>
            )
          })}

          {devicePositions.map(({ device, x, y }) => {
            const isHov = hovered === device.ip
            return (
              <g key={'dev-' + device.ip} style={{ cursor: 'pointer' }} {...handleMouse(device)}>
                {/* Hover highlight */}
                {isHov && (
                  <circle cx={x} cy={y} r={30} fill="#7c3aed" opacity={0.08} />
                )}

                <DeviceIcon x={x} y={y} size={18} deviceType={device.deviceType} />

                {/* Device label */}
                <text x={x} y={y + 28} textAnchor="middle"
                  fontSize={12} fill={isHov ? '#e2e2e8' : '#8b8b98'} fontWeight={isHov ? 600 : 400}
                  style={{ userSelect: 'none', pointerEvents: 'none', transition: 'fill 0.15s' }}>
                  {device.hostname ? truncate(device.hostname, 18) : device.ip}
                </text>

                {/* IP below hostname */}
                {device.hostname && (
                  <text x={x} y={y + 42} textAnchor="middle"
                    fontSize={10} fill="#4b5563" fontFamily="monospace"
                    style={{ userSelect: 'none', pointerEvents: 'none' }}>
                    {device.ip}
                  </text>
                )}

                {/* Vendor tag */}
                {device.vendor && (
                  <text x={x} y={y + (device.hostname ? 54 : 42)} textAnchor="middle"
                    fontSize={10} fill="#6b6b78"
                    style={{ userSelect: 'none', pointerEvents: 'none' }}>
                    {device.vendor}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* ── Device list (bottom panel, ~40%) ── */}
      <div className="border-t border-border-default bg-canvas-inset flex flex-col"
        style={{ flex: '2 1 0%', minHeight: 120 }}>
        {/* Panel header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-default flex-shrink-0">
          <span className="text-xs font-semibold text-fg-muted tracking-wide uppercase">
            Devices ({scanResult.devices.length})
          </span>
          <button onClick={handleScan} disabled={scanning}
            className="px-2.5 py-1 text-[11px] font-medium rounded border border-border-default text-fg-muted hover:text-fg-default hover:bg-canvas-hover transition-colors">
            Rescan
          </button>
        </div>

        {/* Device table */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-canvas-inset z-10">
              <tr className="text-fg-subtle text-left border-b border-border-muted">
                <th className="px-4 py-1.5 font-semibold w-6">#</th>
                <th className="px-4 py-1.5 font-semibold">Hostname / IP</th>
                <th className="px-4 py-1.5 font-semibold">Type</th>
                <th className="px-4 py-1.5 font-semibold">MAC Address</th>
                <th className="px-4 py-1.5 font-semibold">Vendor</th>
                <th className="px-4 py-1.5 font-semibold">Role</th>
                <th className="px-4 py-1.5 font-semibold w-20"></th>
              </tr>
            </thead>
            <tbody>
              {scanResult.devices.map((d, i) => {
                const isHov = hovered === d.ip
                const dtColor = deviceTypeColor(d.deviceType)
                return (
                  <tr key={d.ip}
                    className={`border-b border-border-muted/50 transition-colors ${isHov ? 'bg-canvas-hover' : 'hover:bg-canvas-hover/50'}`}
                    onMouseEnter={(e) => { setHovered(d.ip); setTooltip({ device: d, x: e.clientX, y: e.clientY }) }}
                    onMouseLeave={() => { setHovered(null); setTooltip(null) }}
                    style={{ cursor: 'default' }}>
                    <td className="px-4 py-1.5 text-fg-subtle font-mono">{i + 1}</td>
                    <td className="px-4 py-1.5">
                      <span className="text-fg-default">{d.hostname ?? d.ip}</span>
                      {d.hostname && (
                        <span className="ml-2 text-fg-subtle font-mono">{d.ip}</span>
                      )}
                    </td>
                    <td className="px-4 py-1.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: dtColor.stroke }} />
                        <span className="text-[10px] font-semibold" style={{ color: dtColor.text }}>
                          {deviceTypeLabel(d.deviceType)}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-fg-subtle font-mono">
                      {d.mac ?? '\u2014'}
                      {d.isRandomizedMac && (
                        <span className="ml-1.5 text-[9px] font-sans" style={{ color: '#f59e0b' }}>rand</span>
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-fg-muted">{d.vendor ?? '\u2014'}</td>
                    <td className="px-4 py-1.5">
                      {d.isGateway && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
                          style={{ color: '#60a5fa', background: '#3b82f620' }}>Gateway</span>
                      )}
                      {d.isSelf && !d.isGateway && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
                          style={{ color: '#34d399', background: '#34d39920' }}>This PC</span>
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <button
                        onClick={() => scanPortsFor(d.ip)}
                        title={`Scan ports on ${d.ip}`}
                        className="px-2 py-0.5 text-[10px] font-medium rounded border border-border-default text-fg-muted hover:text-accent-blue hover:border-accent-blue/50 transition-colors">
                        Scan ports
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && <DeviceTooltip {...tooltip} />}
    </div>
  )
}
