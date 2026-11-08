/**
 * Port Scanner — thin wrapper around the system `nmap` binary.
 *
 * Detects an installed nmap, spawns it with XML output (`-oX`), streams
 * progress to the renderer by parsing verbose stdout while it runs, and
 * parses the final XML for structured per-port results (service + banner).
 *
 * Large scans (the full 65535-port range, or big custom ranges) are split
 * across several nmap worker processes covering disjoint port ranges and run
 * concurrently — each worker keeps its own timing/congestion window, so far
 * more probes stay in flight than a single process would allow. The workers'
 * results are merged into one PortScanResult.
 *
 * Uses a TCP connect scan (`-sT`) by default so it works without admin
 * rights. Nothing is bundled — if nmap isn't installed the UI surfaces a
 * download prompt.
 */
import { spawn, execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import { tmpdir, cpus } from 'os'
import { join } from 'path'
import { readFile, unlink } from 'fs/promises'
import type { BrowserWindow } from 'electron'
import { IPC } from '../ipc/channels'
import { PortScanStore } from '../store/PortScanStore'
import type {
  PortScanConfig,
  PortScanResult,
  PortInfo,
  PortState,
  NmapCheckResult,
  PortScanProgressEvent,
  PortScanDoneEvent
} from '../../shared/types'

// ── nmap binary detection ──────────────────────────────────────────────────

const WIN_NMAP_PATHS = [
  'C:\\Program Files (x86)\\Nmap\\nmap.exe',
  'C:\\Program Files\\Nmap\\nmap.exe'
]

const MAC_NMAP_PATHS = [
  '/opt/homebrew/bin/nmap', // Homebrew, Apple silicon
  '/usr/local/bin/nmap',    // Homebrew Intel / official nmap.org installer
  '/opt/local/bin/nmap'     // MacPorts
]

let cachedNmap: NmapCheckResult | null = null

function probeNmap(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      // First line: "Nmap version 7.94 ( https://nmap.org )"
      const match = /Nmap version\s+(\S+)/i.exec(stdout)
      resolve(match?.[1] ?? 'unknown')
    })
  })
}

/** Locate an nmap binary: PATH first, then known per-OS install dirs. Cached. */
export async function checkNmap(force = false): Promise<NmapCheckResult> {
  if (cachedNmap && !force) return cachedNmap

  // Try PATH
  let version = await probeNmap('nmap')
  if (version) {
    cachedNmap = { available: true, version, path: 'nmap' }
    return cachedNmap
  }

  // Try known install locations — GUI apps don't inherit the shell PATH, so on
  // macOS Homebrew/MacPorts installs are invisible to a bare `nmap` lookup.
  const knownPaths =
    process.platform === 'win32' ? WIN_NMAP_PATHS
    : process.platform === 'darwin' ? MAC_NMAP_PATHS
    : []
  for (const p of knownPaths) {
    version = await probeNmap(p)
    if (version) {
      cachedNmap = { available: true, version, path: p }
      return cachedNmap
    }
  }

  cachedNmap = { available: false, version: null, path: null }
  return cachedNmap
}

// ── Input validation (defence against argument injection) ────────────────────

// Hostnames, IPv4/IPv6, and CIDR/range notation. Must not begin with '-' so it
// can never be parsed as an nmap flag.
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
// nmap -p value: digits, commas, hyphens, and proto prefixes like "T:" / "U:".
const PORTS_RE = /^[0-9,\-TUtu: ]+$/

function validateTarget(target: string): string {
  const t = target.trim()
  if (!t || !TARGET_RE.test(t)) {
    throw new Error('Invalid target. Use a hostname, IP address, or CIDR range.')
  }
  return t
}

function validatePorts(ports: string): string {
  const p = ports.trim()
  if (!p || !PORTS_RE.test(p)) {
    throw new Error('Invalid port list. Use values like "22,80,443" or "1-1000".')
  }
  return p
}

// ── Parallel work planning ───────────────────────────────────────────────────

const MAX_PORT = 65535
// Only split ranges at least this large; below it a single nmap process is
// already fast and extra processes would just add per-process overhead.
const PARALLEL_THRESHOLD = 2000

/** Number of concurrent nmap workers to use for a large scan. */
function workerCount(): number {
  return Math.max(2, Math.min(8, cpus().length || 2))
}

/** Split an inclusive port range [lo, hi] into `n` contiguous sub-ranges. */
function splitRange(lo: number, hi: number, n: number): string[] {
  const total = hi - lo + 1
  const per = Math.ceil(total / n)
  const ranges: string[] = []
  for (let start = lo; start <= hi; start += per) {
    const end = Math.min(start + per - 1, hi)
    ranges.push(start === end ? `${start}` : `${start}-${end}`)
  }
  return ranges
}

/**
 * Plan the per-worker port-selection argument fragments. Returns one entry per
 * nmap process to spawn — more than one means the scan runs in parallel.
 */
function planPortSelections(config: PortScanConfig): string[][] {
  switch (config.preset) {
    case 'top100':
      return [['--top-ports', '100']]
    case 'top1000':
      return [['--top-ports', '1000']]
    case 'all':
      return splitRange(1, MAX_PORT, workerCount()).map((r) => ['-p', r])
    case 'custom': {
      const ports = validatePorts(config.customPorts)
      // Split only a simple numeric "lo-hi" range; anything with commas or
      // proto prefixes is passed through to a single process to avoid
      // mis-splitting the syntax.
      const m = /^(\d+)-(\d+)$/.exec(ports)
      if (m) {
        const lo = parseInt(m[1], 10)
        const hi = parseInt(m[2], 10)
        if (hi >= lo && hi - lo + 1 >= PARALLEL_THRESHOLD) {
          return splitRange(lo, hi, workerCount()).map((r) => ['-p', r])
        }
      }
      return [['-p', ports]]
    }
  }
}

/** Common nmap flags shared by every worker (port selection + target appended per worker). */
function baseArgs(config: PortScanConfig, xmlPath: string): string[] {
  const args: string[] = ['-v', '--stats-every', '1s', '-T4', '-oX', xmlPath]
  // Scan technique — connect scan for TCP (no privileges needed).
  args.push(config.protocol === 'udp' ? '-sU' : '-sT')
  // Service / version + banner detection.
  if (config.serviceDetection) args.push('-sV')
  return args
}

// ── nmap XML parsing (dependency-free) ───────────────────────────────────────

function attr(block: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(block)
  return m ? decodeEntities(m[1]) : null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

interface ParsedXml {
  resolvedIp: string | null
  hostUp: boolean
  ports: PortInfo[]
  closedCount: number
  filteredCount: number
  nmapVersion: string | null
}

function parseNmapXml(xml: string): ParsedXml {
  const nmapVersion = attr(xml, 'version')

  const hostUp = /<status[^>]*\bstate="up"/.test(xml)

  // First address element (prefer ipv4, fall back to ipv6).
  let resolvedIp: string | null = null
  const addrRe = /<address\b[^>]*>/g
  let am: RegExpExecArray | null
  while ((am = addrRe.exec(xml)) !== null) {
    const type = attr(am[0], 'addrtype')
    if (type === 'ipv4') { resolvedIp = attr(am[0], 'addr'); break }
    if (type === 'ipv6' && !resolvedIp) resolvedIp = attr(am[0], 'addr')
  }

  // Individual interesting ports.
  const ports: PortInfo[] = []
  const portRe = /<port\b[^>]*>([\s\S]*?)<\/port>/g
  let pm: RegExpExecArray | null
  while ((pm = portRe.exec(xml)) !== null) {
    const head = pm[0].slice(0, pm[0].indexOf('>') + 1)
    const body = pm[1]
    const portid = attr(head, 'portid')
    if (!portid) continue
    const stateBlock = /<state\b[^>]*>/.exec(body)?.[0] ?? ''
    const serviceBlock = /<service\b[^>]*>/.exec(body)?.[0] ?? ''
    ports.push({
      port: parseInt(portid, 10),
      protocol: attr(head, 'protocol') ?? 'tcp',
      state: (attr(stateBlock, 'state') as PortState) ?? 'open',
      service: attr(serviceBlock, 'name'),
      product: attr(serviceBlock, 'product'),
      version: attr(serviceBlock, 'version'),
      extraInfo: attr(serviceBlock, 'extrainfo')
    })
  }
  ports.sort((a, b) => a.port - b.port)

  // Aggregated closed/filtered counts (<extraports state="closed" count="997"/>).
  let closedCount = 0
  let filteredCount = 0
  const extraRe = /<extraports\b[^>]*>/g
  let em: RegExpExecArray | null
  while ((em = extraRe.exec(xml)) !== null) {
    const state = attr(em[0], 'state')
    const count = parseInt(attr(em[0], 'count') ?? '0', 10) || 0
    if (state === 'closed') closedCount += count
    else if (state === 'filtered') filteredCount += count
  }

  return { resolvedIp, hostUp, ports, closedCount, filteredCount, nmapVersion }
}

/** Merge the per-worker parses into a single result set (worker ranges are disjoint). */
function mergeParsed(parts: ParsedXml[]): ParsedXml {
  const STATE_RANK: Record<string, number> = {
    open: 4, 'open|filtered': 3, unfiltered: 2, filtered: 1, closed: 0
  }
  const byKey = new Map<string, PortInfo>()
  let closedCount = 0
  let filteredCount = 0
  let hostUp = false
  let resolvedIp: string | null = null
  let nmapVersion: string | null = null

  for (const p of parts) {
    hostUp = hostUp || p.hostUp
    closedCount += p.closedCount
    filteredCount += p.filteredCount
    if (!resolvedIp) resolvedIp = p.resolvedIp
    if (!nmapVersion) nmapVersion = p.nmapVersion
    for (const port of p.ports) {
      const key = `${port.protocol}:${port.port}`
      const existing = byKey.get(key)
      if (!existing || (STATE_RANK[port.state] ?? 0) > (STATE_RANK[existing.state] ?? 0)) {
        byKey.set(key, port)
      }
    }
  }

  const ports = [...byKey.values()].sort((a, b) => a.port - b.port)
  return { resolvedIp, hostUp, ports, closedCount, filteredCount, nmapVersion }
}

// ── Active scan registry ─────────────────────────────────────────────────────

interface RunningScan {
  children: ChildProcess[]
  canceled: boolean
}

const activeScans = new Map<string, RunningScan>()

function emitProgress(win: BrowserWindow, payload: PortScanProgressEvent): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.PORTSCAN_PROGRESS, payload)
}
function emitDone(win: BrowserWindow, payload: PortScanDoneEvent): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.PORTSCAN_DONE, payload)
}

interface WorkerOutcome {
  parsed: ParsedXml | null
  error: string | null
}

/** Run a single nmap worker over one port-selection slice. */
function runWorker(
  bin: string,
  args: string[],
  xmlPath: string,
  scan: RunningScan,
  scanId: string,
  win: BrowserWindow,
  onPercent: (pct: number, message: string | null) => void
): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true })
    scan.children.push(child)
    let stderrTail = ''

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString()
      // Newly discovered open port: "Discovered open port 443/tcp on 1.2.3.4"
      const portRe = /Discovered open port (\d+)\/(tcp|udp)/gi
      let m: RegExpExecArray | null
      while ((m = portRe.exec(text)) !== null) {
        emitProgress(win, {
          scanId,
          percent: null,
          message: null,
          openPort: { port: parseInt(m[1], 10), protocol: m[2].toLowerCase() }
        })
      }
      // Progress: "About 24.50% done" or "SYN Stealth Scan Timing: About 50.00% done"
      const pct = /About ([\d.]+)% done/i.exec(text)
      if (pct) {
        const statusLine = /(\w[\w ]*?) Timing: About/i.exec(text)
        onPercent(Math.min(100, parseFloat(pct[1])), statusLine?.[1]?.trim() ?? null)
      }
    })

    child.stderr?.on('data', (buf: Buffer) => {
      stderrTail = (stderrTail + buf.toString()).slice(-2000)
    })

    child.on('error', (err) => {
      void unlink(xmlPath).catch(() => {})
      resolve({ parsed: null, error: `Failed to launch nmap: ${err.message}` })
    })

    child.on('close', async (code) => {
      onPercent(100, null)
      let xml = ''
      try {
        xml = await readFile(xmlPath, 'utf8')
      } catch {
        // no XML produced
      } finally {
        void unlink(xmlPath).catch(() => {})
      }
      if (!xml) {
        resolve({
          parsed: null,
          error: code === 0
            ? 'nmap produced no output.'
            : `nmap exited with code ${code}.${stderrTail ? ` ${stderrTail.trim()}` : ''}`
        })
        return
      }
      resolve({ parsed: parseNmapXml(xml), error: null })
    })
  })
}

/**
 * Start an nmap scan. Resolves once the workers have spawned; results and
 * progress are delivered asynchronously via PORTSCAN_PROGRESS / PORTSCAN_DONE.
 * Large port ranges are split across several concurrent worker processes.
 */
export async function startPortScan(
  scanId: string,
  config: PortScanConfig,
  win: BrowserWindow
): Promise<void> {
  const nmap = await checkNmap()
  const startedAt = Date.now()

  const fail = (error: string, nmapVersion: string | null = null): void => {
    const result: PortScanResult = {
      scanId,
      target: config.target,
      protocol: config.protocol,
      resolvedIp: null,
      hostUp: false,
      ports: [],
      closedCount: 0,
      filteredCount: 0,
      startedAt,
      durationMs: Date.now() - startedAt,
      nmapVersion,
      diff: null,
      error
    }
    emitDone(win, { scanId, result })
  }

  if (!nmap.available || !nmap.path) {
    fail('nmap is not installed or could not be found. Install it from https://nmap.org/download and try again.')
    return
  }

  // Plan the per-worker port slices and build each worker's argument vector.
  let workers: { args: string[]; xmlPath: string }[]
  try {
    const target = validateTarget(config.target)
    const selections = planPortSelections(config)
    workers = selections.map((sel, i) => {
      const xmlPath = join(tmpdir(), `nmtr-scan-${scanId}-${i}.xml`)
      return { args: [...baseArgs(config, xmlPath), ...sel, target], xmlPath }
    })
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), nmap.version)
    return
  }

  const scan: RunningScan = { children: [], canceled: false }
  activeScans.set(scanId, scan)

  // Aggregate progress across workers (mean of their reported percents).
  const pcts = new Array(workers.length).fill(0)
  let lastMsg: string | null = null
  const reportPercent = (idx: number) => (pct: number, message: string | null): void => {
    pcts[idx] = pct
    if (message) lastMsg = message
    const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length
    emitProgress(win, { scanId, percent: avg, message: lastMsg, openPort: null })
  }

  const outcomes = await Promise.all(
    workers.map((w, i) => runWorker(nmap.path!, w.args, w.xmlPath, scan, scanId, win, reportPercent(i)))
  )

  activeScans.delete(scanId)

  if (scan.canceled) {
    fail('Scan canceled.', nmap.version)
    return
  }

  const parsed = outcomes.map((o) => o.parsed).filter((p): p is ParsedXml => p !== null)
  if (parsed.length === 0) {
    fail(outcomes.find((o) => o.error)?.error ?? 'nmap produced no output.', nmap.version)
    return
  }

  const merged = mergeParsed(parsed)
  const result: PortScanResult = {
    scanId,
    target: config.target,
    protocol: config.protocol,
    resolvedIp: merged.resolvedIp,
    hostUp: merged.hostUp,
    ports: merged.ports,
    closedCount: merged.closedCount,
    filteredCount: merged.filteredCount,
    startedAt,
    durationMs: Date.now() - startedAt,
    nmapVersion: merged.nmapVersion ?? nmap.version,
    diff: null,
    error: null
  }

  // Diff against the previous scan of this target+protocol, then persist.
  try {
    result.diff = PortScanStore.commit(result, config.protocol)
  } catch {
    result.diff = null
  }

  emitProgress(win, { scanId, percent: 100, message: 'Done', openPort: null })
  emitDone(win, { scanId, result })
}

/** Cancel a running scan, killing all nmap worker processes. */
export function cancelPortScan(scanId: string): void {
  const scan = activeScans.get(scanId)
  if (!scan) return
  scan.canceled = true
  for (const child of scan.children) child.kill()
}
