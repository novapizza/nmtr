/**
 * Monitor engine — scheduled, background health checks.
 *
 * Each enabled monitor runs on its own self-rescheduling timer (so a slow check
 * never overlaps its next run). A check produces a MonitorResult which is
 * persisted via MonitorStore and pushed to the renderer; status transitions
 * open/close incidents and emit a state-change event the renderer turns into a
 * desktop notification.
 *
 * All checks are dependency-free and local: HTTP(S) via Node's http/https, TCP
 * via net, DNS via dns, certificate expiry via tls, and ping via the system
 * `ping` (no admin needed). Nothing is sent to a third-party service.
 */
import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import * as tls from 'tls'
import dns from 'dns'
import { isIP } from 'net'
import { spawn } from 'child_process'
import type { BrowserWindow } from 'electron'
import { IPC } from '../ipc/channels'
import { MonitorStore } from '../store/MonitorStore'
import type {
  MonitorConfig,
  MonitorResult,
  MonitorStatus,
  MonitorResultEvent,
  MonitorStateChangeEvent
} from '../../shared/types'

const CHECK_TIMEOUT_MS = 10_000
const MIN_INTERVAL_SEC = 10

// ── Defaults for optional thresholds ──────────────────────────────────────────

function httpStatusRange(c: MonitorConfig): [number, number] {
  return [c.expectStatusMin ?? 200, c.expectStatusMax ?? 399]
}

// ── Individual check implementations ──────────────────────────────────────────
//
// Every check resolves to a partial result (status/latency/message/value); the
// engine stamps monitorId + checkedAt around it. Checks never throw.

interface CheckOutcome {
  status: MonitorStatus
  latencyMs: number | null
  message: string | null
  value: number | null
}

function checkHttp(c: MonitorConfig): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    let url: URL
    try {
      url = new URL(/^https?:\/\//i.test(c.target) ? c.target : `https://${c.target}`)
    } catch {
      return resolve({ status: 'down', latencyMs: null, message: 'Invalid URL', value: null })
    }
    const lib = url.protocol === 'http:' ? http : https
    const [min, max] = httpStatusRange(c)
    const started = Date.now()
    let settled = false
    const done = (o: CheckOutcome): void => { if (!settled) { settled = true; resolve(o) } }

    const req = lib.request(
      url,
      { method: 'GET', timeout: CHECK_TIMEOUT_MS, rejectUnauthorized: false,
        headers: { 'User-Agent': 'nmtr-monitor', Accept: '*/*', Connection: 'close' } },
      (res) => {
        const latencyMs = Date.now() - started
        const code = res.statusCode ?? 0
        res.resume() // drain
        const inRange = code >= min && code <= max
        if (!inRange) {
          done({ status: 'down', latencyMs, message: `HTTP ${code} (expected ${min}–${max})`, value: code })
        } else if (c.latencyWarnMs !== null && latencyMs > c.latencyWarnMs) {
          done({ status: 'degraded', latencyMs, message: `HTTP ${code} · slow (${latencyMs} ms)`, value: code })
        } else {
          done({ status: 'up', latencyMs, message: `HTTP ${code}`, value: code })
        }
      }
    )
    req.on('error', (e: Error) => done({ status: 'down', latencyMs: null, message: e.message, value: null }))
    req.on('timeout', () => { req.destroy(); done({ status: 'down', latencyMs: null, message: 'Request timed out', value: null }) })
    req.end()
  })
}

function checkTcp(c: MonitorConfig): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const port = c.port ?? 0
    if (!port) return resolve({ status: 'down', latencyMs: null, message: 'No port configured', value: null })
    const started = Date.now()
    let settled = false
    const done = (o: CheckOutcome): void => { if (!settled) { settled = true; try { socket.destroy() } catch { /* */ } resolve(o) } }
    const socket = net.connect({ host: c.target, port })
    socket.setTimeout(CHECK_TIMEOUT_MS)
    socket.on('connect', () => {
      const latencyMs = Date.now() - started
      if (c.latencyWarnMs !== null && latencyMs > c.latencyWarnMs) {
        done({ status: 'degraded', latencyMs, message: `Connected · slow (${latencyMs} ms)`, value: latencyMs })
      } else {
        done({ status: 'up', latencyMs, message: `Connected in ${latencyMs} ms`, value: latencyMs })
      }
    })
    socket.on('timeout', () => done({ status: 'down', latencyMs: null, message: 'Connection timed out', value: null }))
    socket.on('error', (e: Error) => done({ status: 'down', latencyMs: null, message: e.message, value: null }))
  })
}

const PING_TIME_RE = /[<=]\s*(\d+(?:\.\d+)?)\s*ms/i

function checkPing(c: MonitorConfig): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    // -W units differ: Windows -w and macOS -W take milliseconds, Linux -W takes seconds.
    const args =
      process.platform === 'win32' ? ['-n', '1', '-w', String(CHECK_TIMEOUT_MS), c.target]
      : process.platform === 'darwin' ? ['-n', '-c', '1', '-W', String(CHECK_TIMEOUT_MS), c.target]
      : ['-c', '1', '-W', String(Math.ceil(CHECK_TIMEOUT_MS / 1000)), c.target]
    let out = ''
    let settled = false
    const done = (o: CheckOutcome): void => { if (!settled) { settled = true; resolve(o) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('ping', args, { windowsHide: true, timeout: CHECK_TIMEOUT_MS + 1000 })
    } catch (err) {
      return done({ status: 'down', latencyMs: null, message: err instanceof Error ? err.message : 'ping failed', value: null })
    }
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.on('error', (e: Error) => done({ status: 'down', latencyMs: null, message: e.message, value: null }))
    child.on('close', () => {
      const m = out.match(PING_TIME_RE)
      // A reply line with a time means the host answered. No match → timeout/unreachable.
      if (m && /TTL=|ttl=|bytes from/i.test(out)) {
        const latencyMs = Math.round(parseFloat(m[1]))
        if (c.latencyWarnMs !== null && latencyMs > c.latencyWarnMs) {
          done({ status: 'degraded', latencyMs, message: `Reply · slow (${latencyMs} ms)`, value: latencyMs })
        } else {
          done({ status: 'up', latencyMs, message: `Reply in ${latencyMs} ms`, value: latencyMs })
        }
      } else {
        done({ status: 'down', latencyMs: null, message: 'No reply (timeout/unreachable)', value: null })
      }
    })
  })
}

function checkDns(c: MonitorConfig): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const type = (c.dnsRecordType ?? 'A').toUpperCase()
    const started = Date.now()
    let settled = false
    const done = (o: CheckOutcome): void => { if (!settled) { settled = true; resolve(o) } }
    const timer = setTimeout(
      () => done({ status: 'down', latencyMs: null, message: 'DNS query timed out', value: null }),
      CHECK_TIMEOUT_MS
    )
    dns.resolve(c.target, type, (err, records) => {
      clearTimeout(timer)
      const latencyMs = Date.now() - started
      if (err) {
        return done({ status: 'down', latencyMs, message: `${err.code ?? 'NXDOMAIN'}`, value: null })
      }
      const count = Array.isArray(records) ? records.length : 0
      if (count === 0) return done({ status: 'down', latencyMs, message: `No ${type} records`, value: 0 })
      done({ status: 'up', latencyMs, message: `${count} ${type} record(s)`, value: count })
    })
  })
}

function checkCert(c: MonitorConfig): Promise<CheckOutcome> {
  return new Promise((resolve) => {
    const port = c.port ?? 443
    const warnDays = c.expiryWarnDays ?? 14
    let settled = false
    const done = (o: CheckOutcome): void => { if (!settled) { settled = true; try { socket.destroy() } catch { /* */ } resolve(o) } }
    const socket = tls.connect({
      host: c.target, port,
      servername: isIP(c.target) ? undefined : c.target,
      rejectUnauthorized: false, timeout: CHECK_TIMEOUT_MS
    }, () => {
      const cert = socket.getPeerCertificate()
      if (!cert || !cert.valid_to) {
        return done({ status: 'down', latencyMs: null, message: 'No certificate presented', value: null })
      }
      const expiry = new Date(cert.valid_to).getTime()
      const days = Math.floor((expiry - Date.now()) / 86_400_000)
      if (days < 0) {
        done({ status: 'down', latencyMs: null, message: `Expired ${-days} day(s) ago`, value: days })
      } else if (days <= warnDays) {
        done({ status: 'degraded', latencyMs: null, message: `Expires in ${days} day(s)`, value: days })
      } else {
        done({ status: 'up', latencyMs: null, message: `Valid · ${days} day(s) left`, value: days })
      }
    })
    socket.setTimeout(CHECK_TIMEOUT_MS)
    socket.on('timeout', () => done({ status: 'down', latencyMs: null, message: 'TLS connection timed out', value: null }))
    socket.on('error', (e: Error) => done({ status: 'down', latencyMs: null, message: e.message, value: null }))
  })
}

function runCheck(c: MonitorConfig): Promise<CheckOutcome> {
  switch (c.type) {
    case 'http': return checkHttp(c)
    case 'tcp': return checkTcp(c)
    case 'ping': return checkPing(c)
    case 'dns': return checkDns(c)
    case 'cert': return checkCert(c)
    default: return Promise.resolve({ status: 'unknown', latencyMs: null, message: 'Unknown monitor type', value: null })
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────

class MonitorEngineImpl {
  private win: BrowserWindow | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private lastStatus = new Map<string, MonitorStatus>()
  private inFlight = new Set<string>()

  /** Load persisted configs and schedule every enabled monitor. */
  start(win: BrowserWindow): void {
    this.win = win
    // Seed last-known status so we don't fire a spurious notification on boot.
    for (const view of MonitorStore.listWithStats()) {
      this.lastStatus.set(view.config.id, view.stats.status)
    }
    for (const config of MonitorStore.getConfigs()) {
      if (config.enabled) this.schedule(config.id)
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** (Re)arm the timer for one monitor based on its current config. */
  schedule(id: string): void {
    this.clearTimer(id)
    const config = MonitorStore.getConfig(id)
    if (!config || !config.enabled) return
    const intervalMs = Math.max(MIN_INTERVAL_SEC, config.intervalSec) * 1000
    const tick = async (): Promise<void> => {
      await this.execute(id)
      // Reschedule only if still enabled (config may have changed mid-check).
      const cur = MonitorStore.getConfig(id)
      if (cur?.enabled) this.timers.set(id, setTimeout(tick, intervalMs))
    }
    // First run shortly after arming so the user sees data immediately.
    this.timers.set(id, setTimeout(tick, 600))
  }

  clearTimer(id: string): void {
    const t = this.timers.get(id)
    if (t) { clearTimeout(t); this.timers.delete(id) }
  }

  /** Run a single check now (used by "Run now" and by the scheduler). */
  async runNow(id: string): Promise<void> {
    await this.execute(id)
  }

  private async execute(id: string): Promise<void> {
    if (this.inFlight.has(id)) return
    const config = MonitorStore.getConfig(id)
    if (!config) return
    this.inFlight.add(id)
    try {
      const outcome = await runCheck(config)
      const result: MonitorResult = {
        monitorId: id,
        checkedAt: Date.now(),
        status: outcome.status,
        latencyMs: outcome.latencyMs,
        message: outcome.message,
        value: outcome.value
      }
      const stats = MonitorStore.addResult(result)
      this.handleTransition(config, result)
      this.emit(IPC.MONITOR_RESULT, { result, stats } as MonitorResultEvent)
    } finally {
      this.inFlight.delete(id)
    }
  }

  /** Open/close incidents and emit a state-change event when status changes. */
  private handleTransition(config: MonitorConfig, result: MonitorResult): void {
    const prev = this.lastStatus.get(config.id) ?? 'unknown'
    const next = result.status
    this.lastStatus.set(config.id, next)
    if (prev === next) return

    // Incident bookkeeping: an incident spans any contiguous "down" stretch.
    if (next === 'down' && prev !== 'down') {
      MonitorStore.openIncident(config.id, next, result.message)
    } else if (prev === 'down' && next !== 'down') {
      MonitorStore.resolveIncident(config.id)
    }

    // Notify on any meaningful transition (skip the first unknown→* settle).
    if (prev !== 'unknown' || next !== 'up') {
      this.emit(IPC.MONITOR_STATE_CHANGE, {
        monitorId: config.id,
        label: config.label,
        from: prev,
        to: next,
        reason: result.message,
        at: result.checkedAt
      } as MonitorStateChangeEvent)
    }
  }

  private emit(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  // ── Config mutations (proxied through here so timers stay in sync) ─────────

  add(partial: Omit<MonitorConfig, 'id' | 'createdAt'>): MonitorConfig {
    const config = MonitorStore.add(partial)
    this.lastStatus.set(config.id, 'unknown')
    if (config.enabled) this.schedule(config.id)
    return config
  }

  update(id: string, patch: Partial<Omit<MonitorConfig, 'id' | 'createdAt'>>): MonitorConfig | undefined {
    const config = MonitorStore.update(id, patch)
    if (!config) return undefined
    if (config.enabled) this.schedule(config.id)
    else this.clearTimer(id)
    return config
  }

  remove(id: string): void {
    this.clearTimer(id)
    this.lastStatus.delete(id)
    MonitorStore.remove(id)
  }
}

export const MonitorEngine = new MonitorEngineImpl()
