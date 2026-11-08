// ─── Core enums ──────────────────────────────────────────────────────────────

export type Protocol = 'icmp' | 'udp' | 'tcp'
export type SessionStatus = 'idle' | 'running' | 'paused' | 'stopped'
export type ExportFormat = 'text' | 'csv' | 'html' | 'json'
export type Theme = 'dark' | 'light' | 'system'

// ─── Probe / engine types ─────────────────────────────────────────────────────

export interface TraceConfig {
  target: string
  protocol: Protocol
  port?: number // UDP/TCP only, default 80 for TCP
  intervalMs: number // default 1000
  packetSize: number // bytes, default 64
  maxHops: number // default 30
  useIPv6: boolean
  resolveHostnames: boolean
}

export interface ProbeOptions {
  protocol: Protocol
  port?: number
  packetSize: number
  timeoutMs: number
  useIPv6: boolean
}

export interface ProbeResult {
  fromIP: string // IP that replied (TTL-exceeded or echo-reply)
  rttMs: number // round-trip time in milliseconds
  isFinalHop: boolean // true = destination reached
  hopIndex: number // 1-based TTL used
}

// ─── Enrichment ───────────────────────────────────────────────────────────────

export interface EnrichmentData {
  asn: string | null // "AS15169"
  isp: string | null // "Google LLC"
  country: string | null // "US"
  countryCode: string | null // "US"
  city: string | null
  lat: number | null
  lng: number | null
}

// ─── Per-hop statistics ───────────────────────────────────────────────────────

export interface HopStats {
  hopIndex: number // 1-based TTL
  ip: string | null // null = no response (* * *)
  hostname: string | null
  enrichment: EnrichmentData | null
  loss: number // 0.0–100.0 percent
  sent: number
  recv: number
  last: number | null // ms
  avg: number | null // ms
  best: number | null // ms
  worst: number | null // ms
  jitter: number | null // mean deviation ms (RFC 3550)
  sparkline: (number | null)[] // 60-point rolling ring buffer, newest at tail
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface TraceSession {
  id: string
  config: TraceConfig
  status: SessionStatus
  hops: HopStats[]
  startedAt: number // Date.now()
  elapsedMs: number
  totalSent: number
  isPlayback: boolean
  engineMode: 'pingus' | 'native' // which engine is active
  routeEvents: RouteChangeEvent[]  // IP changes detected during this session
  rttHistory: (number | null)[]   // final-hop RTT per probe round, newest at tail (max 300)
}

// ─── App settings ─────────────────────────────────────────────────────────────

/** A user-managed DNS resolver entry shown in the DNS Resolver view dropdown. */
export interface DnsResolverPreset {
  label: string
  value: string // resolver IP address
}

export interface AppSettings {
  theme: Theme
  defaultProtocol: Protocol
  defaultPort: number
  defaultIntervalMs: number
  defaultPacketSize: number
  defaultUseIPv6: boolean
  maxHops: number
  resolveHostnames: boolean
  minimizeToTray: boolean
  // App lifecycle
  checkUpdatesOnStartup: boolean   // auto-check GitHub Releases shortly after launch
  launchAtLogin: boolean           // register the app as a login item (OS startup)
  alertsEnabled: boolean
  alertLossPct: number
  alertRttMs: number
  alertCooldownSec: number
  // Speed Test TURN relay (for packet-loss measurement). Empty = packet loss disabled.
  turnServerUri: string
  turnServerUser: string
  turnServerPass: string
  // DNS Resolver view — user-managed list of resolver presets (seeded with public ones).
  dnsResolvers: DnsResolverPreset[]
}

/** Default DNS resolver presets shown in the DNS Resolver view. */
export const DEFAULT_DNS_RESOLVERS: DnsResolverPreset[] = [
  { label: 'Cloudflare (1.1.1.1)', value: '1.1.1.1' },
  { label: 'Google (8.8.8.8)', value: '8.8.8.8' },
  { label: 'Quad9 (9.9.9.9)', value: '9.9.9.9' }
]

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  defaultProtocol: 'icmp',
  defaultPort: 80,
  defaultIntervalMs: 500,
  defaultPacketSize: 64,
  defaultUseIPv6: false,
  maxHops: 30,
  resolveHostnames: true,
  minimizeToTray: true,
  checkUpdatesOnStartup: true,
  launchAtLogin: false,
  alertsEnabled: false,
  alertLossPct: 20,
  alertRttMs: 200,
  alertCooldownSec: 30,
  turnServerUri: '',
  turnServerUser: '',
  turnServerPass: '',
  dnsResolvers: DEFAULT_DNS_RESOLVERS
}

// ─── Recording / Playback ─────────────────────────────────────────────────────

export interface RecordingMeta {
  type: 'meta'
  version: string // app version
  target: string
  startedAt: number
  protocol: Protocol
  intervalMs: number
}

export interface RecordingFrame {
  type: 'frame'
  t: number // ms since startedAt
  hops: HopStats[]
}

export interface RecordingRouteChange {
  type: 'routechange'
  t: number        // ms since session startedAt
  hopIndex: number
  oldIP: string
  newIP: string
}

export type RecordingLine = RecordingMeta | RecordingFrame | RecordingRouteChange

// ─── Route change ─────────────────────────────────────────────────────────────

export interface RouteChangeEvent {
  sessionId: string
  hopIndex: number  // 1-based TTL
  oldIP: string
  newIP: string
  timestamp: number // Date.now()
}

// ─── IPC payload types ────────────────────────────────────────────────────────

export interface TraceStartPayload {
  config: TraceConfig
}
export interface TraceStartResult {
  sessionId: string
  engineMode: 'pingus' | 'native'
}

export interface TraceStopPayload {
  sessionId: string
}
export interface TracePausePayload {
  sessionId: string
}
export interface TraceResumePayload {
  sessionId: string
}
export interface TraceResetPayload {
  sessionId: string
}

export interface ExportPayload {
  sessionId: string
  format: ExportFormat
}
export interface ExportResult {
  content: string
  mimeType: string
  suggestedFilename: string
}

export interface WhoisPayload {
  ip: string
}
export interface WhoisResult {
  raw: string
}

export interface RecordingStartPayload {
  sessionId: string
  filePath: string
}
export interface RecordingStopPayload {
  sessionId: string
}
export interface RecordingStopResult {
  filePath: string
}

export interface PlaybackOpenResult {
  sessionId: string
  filePath: string
  meta: RecordingMeta
  durationMs: number
  frameCount: number
}
export interface PlaybackStartPayload {
  sessionId: string
  filePath: string
  speed: number
}
export interface PlaybackSeekPayload {
  sessionId: string
  timestampMs: number
}
export interface PlaybackStopPayload {
  sessionId: string
}

// ─── Trace history ────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string
  target: string
  protocol: Protocol
  startedAt: number   // Date.now()
  durationMs: number
  hopCount: number    // number of hops with IPs
  avgLoss: number     // average loss% across all hops (0–100)
  avgRtt: number | null  // average RTT of final hop, ms
  engineMode: string
}

// ─── LAN Network ─────────────────────────────────────────────────────────────

export type DeviceType = 'router' | 'ap' | 'laptop' | 'desktop' | 'phone' | 'tablet'
  | 'camera' | 'iot' | 'printer' | 'media' | 'server' | 'unknown'

export interface NetworkInterface {
  name: string          // e.g. "Ethernet", "Wi-Fi"
  ip: string            // local IP
  mac: string           // MAC address
  netmask: string       // e.g. "255.255.255.0"
  gateway: string | null
  type: 'ethernet' | 'wifi' | 'vpn' | 'warp' | 'loopback' | 'other'
  cidr: string          // e.g. "192.168.1.0/24"
}

export interface LanDevice {
  ip: string
  mac: string | null
  hostname: string | null
  vendor: string | null       // OUI vendor from MAC
  deviceType: DeviceType
  isRandomizedMac: boolean    // true if MAC is locally administered (randomized)
  responseTimeMs: number | null
  isGateway: boolean
  isSelf: boolean
}

export interface LanScanResult {
  interfaces: NetworkInterface[]
  devices: LanDevice[]
  vpnDetected: boolean
  vpnInterfaces: NetworkInterface[]  // subset of interfaces with type vpn/warp
  scanDurationMs: number
  notice?: string | null             // non-fatal caveat (e.g. macOS Local Network permission missing)
}

export type LanScanPayload = Record<string, never>  // no params needed

// ─── Tracert discovery result ─────────────────────────────────────────────────

export interface TracertResultEvent {
  sessionId: string
  target: string
  rawOutput: string          // full stdout+stderr from tracert
  hops: { ttl: number; ip: string }[]  // successfully parsed hops
  error: string | null       // spawn error message, or null on success
}

// ─── Port scan (nmap) ─────────────────────────────────────────────────────────

export type PortScanProtocol = 'tcp' | 'udp'
export type PortScanPreset = 'top100' | 'top1000' | 'all' | 'custom'
export type PortState = 'open' | 'closed' | 'filtered' | 'open|filtered' | 'unfiltered'

export interface PortScanConfig {
  target: string                 // host, IP, or CIDR
  protocol: PortScanProtocol
  preset: PortScanPreset
  customPorts: string            // nmap -p value when preset === 'custom', e.g. "22,80,443,8000-8100"
  serviceDetection: boolean      // -sV (service + version/banner)
}

export interface PortInfo {
  port: number
  protocol: string               // "tcp" | "udp"
  state: PortState
  service: string | null         // e.g. "https"
  product: string | null         // banner product, e.g. "nginx"
  version: string | null         // banner version, e.g. "1.24.0"
  extraInfo: string | null       // e.g. "Ubuntu"
}

/** Open ports that changed since the previous scan of the same target+protocol. */
export interface PortScanDiff {
  previousScanAt: number | null  // when the compared prior scan ran; null = no prior scan
  newlyOpened: number[]          // ports open now but not in the prior scan
  newlyClosed: { port: number; protocol: string; service: string | null }[] // open before, gone now
}

export interface PortScanResult {
  scanId: string
  target: string
  protocol: PortScanProtocol
  resolvedIp: string | null
  hostUp: boolean
  ports: PortInfo[]
  closedCount: number            // ports nmap grouped as closed (extraports)
  filteredCount: number          // ports nmap grouped as filtered (extraports)
  startedAt: number              // Date.now()
  durationMs: number
  nmapVersion: string | null
  diff: PortScanDiff | null      // change vs previous scan of this target (null if none)
  error: string | null           // null on success
}

/** Persisted summary of a completed scan (for history + diffing). */
export interface PortScanRecord {
  id: string
  target: string
  protocol: PortScanProtocol
  scannedAt: number
  openPorts: { port: number; protocol: string; service: string | null }[]
  openCount: number
}

export type PortScanExportFormat = 'csv' | 'html' | 'json' | 'text'
export interface PortScanExportPayload {
  result: PortScanResult
  format: PortScanExportFormat
}
export interface OpenExternalPayload {
  url: string
}

export interface PortScanStartPayload {
  config: PortScanConfig
}
export interface PortScanStartResult {
  scanId: string
}
export interface PortScanCancelPayload {
  scanId: string
}
export interface NmapCheckResult {
  available: boolean
  version: string | null
  path: string | null
}

// Main → renderer push events
export interface PortScanProgressEvent {
  scanId: string
  percent: number | null         // 0–100, null if unknown
  message: string | null         // status line, e.g. "Service scan"
  openPort: { port: number; protocol: string } | null  // newly discovered open port
}
export interface PortScanDoneEvent {
  scanId: string
  result: PortScanResult
}

// ─── DNS resolve ───────────────────────────────────────────────────────────────

/** The record types resolved in a single DNS scan, in display order. */
export type DnsRecordType =
  | 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'PTR'
  | 'SRV' | 'SOA' | 'TXT' | 'CAA' | 'DS' | 'DNSKEY'

export const DNS_RECORD_TYPES: DnsRecordType[] = [
  'A', 'AAAA', 'CNAME', 'MX', 'NS', 'PTR', 'SRV', 'SOA', 'TXT', 'CAA', 'DS', 'DNSKEY'
]

/** A single resource record returned for a given type. */
export interface DnsRecord {
  name: string                  // owner name the record belongs to
  ttl: number                   // seconds
  value: string                 // human-readable formatted value
  fields: Record<string, string | number> // structured per-type fields (e.g. SOA serial, MX preference)
}

/** All records of one type, plus the per-type query outcome. */
export interface DnsRecordSet {
  type: DnsRecordType
  records: DnsRecord[]
  rcode: string | null          // DNS response code name, e.g. "NOERROR", "NXDOMAIN"
  error: string | null          // transport/parse error for this type, null on success
}

export interface DnsLookupConfig {
  target: string                // hostname or IP (IP → reverse lookup for PTR)
  resolver: string              // resolver IP, or '' for system default
  authoritative?: boolean       // query the zone's authoritative NS instead of a recursive resolver
  skipHistory?: boolean         // don't persist this lookup (e.g. watch-mode ticks)
}

// ── DNSSEC validation (feature 1) ──
export type DnssecStatus = 'secure' | 'insecure' | 'bogus' | 'indeterminate'
export interface DnssecInfo {
  status: DnssecStatus
  adFlag: boolean               // resolver set the Authenticated Data bit
  hasDnskey: boolean
  hasDs: boolean
  detail: string                // human-readable explanation
}

// ── Diff vs previous lookup (feature 7) ──
export interface DnsTypeDiff {
  type: DnsRecordType
  added: string[]               // values present now, absent before
  removed: string[]             // values present before, gone now
}
export interface DnsDiff {
  previousAt: number | null     // when the compared prior lookup ran; null = none
  changes: DnsTypeDiff[]        // only types that changed
}

export interface DnsLookupResult {
  target: string
  queriedName: string           // name actually queried (reverse name when target is an IP)
  resolver: string              // resolver IP actually used
  authoritative: boolean        // whether the answer came from an authoritative NS (AA flag)
  sets: DnsRecordSet[]          // one per record type, in DNS_RECORD_TYPES order
  dnssec: DnssecInfo            // DNSSEC validation summary
  diff: DnsDiff | null          // change vs previous lookup of this target+resolver
  durationMs: number
  error: string | null          // fatal error (invalid target / no resolver), null otherwise
}

// ── Propagation across resolvers (feature 2) ──
export interface DnsPropagationEntry {
  resolver: string
  label: string
  values: string[]
  rcode: string | null
  error: string | null
  rttMs: number
}
export interface DnsPropagationResult {
  name: string
  type: DnsRecordType
  entries: DnsPropagationEntry[]
  consistent: boolean           // all non-error resolvers returned the same value set
}
export interface DnsPropagationPayload {
  name: string
  type: DnsRecordType
}

// ── Email security (feature 4) ──
export type DnsCheckStatus = 'pass' | 'warn' | 'fail' | 'none'
export interface DnsEmailCheck {
  present: boolean
  value: string | null
  status: DnsCheckStatus
  note: string
}
export interface DnsEmailSecurity {
  domain: string
  spf: DnsEmailCheck
  dmarc: DnsEmailCheck
  mtaSts: DnsEmailCheck
  bimi: DnsEmailCheck
  dkim: { selector: string; value: string }[]   // DKIM selectors that resolved
  dkimChecked: string[]                          // selectors probed
  error: string | null
}
export interface DnsEmailPayload {
  domain: string
  resolver: string
}

// ── Forward-confirmed reverse DNS / FCrDNS (feature 5) ──
export interface DnsFcrdnsEntry {
  ip: string
  ptr: string | null            // PTR name for the IP
  forwardIps: string[]          // IPs the PTR name forward-resolves to
  confirmed: boolean            // original IP appears in forwardIps
}
export interface DnsFcrdnsResult {
  entries: DnsFcrdnsEntry[]
  error: string | null
}
export interface DnsFcrdnsPayload {
  ips: string[]
  resolver: string
}

// ── Delegation trace / dig +trace (feature 6) ──
export interface DnsDelegationStep {
  zone: string                  // the zone being resolved at this step
  serverQueried: string         // IP queried
  serverName: string | null     // name of that server, if known
  nsRecords: string[]           // NS records returned (referral or authoritative)
  authoritative: boolean        // AA flag set (reached the authoritative servers)
  rttMs: number
  error: string | null
}
export interface DnsDelegationResult {
  name: string
  steps: DnsDelegationStep[]
  error: string | null
}
export interface DnsDelegationPayload {
  name: string
}

/** Persisted record of a completed DNS lookup (for the history table). */
export interface DnsHistoryRecord {
  id: string
  target: string
  queriedName: string
  resolver: string
  scannedAt: number             // Date.now()
  totalRecords: number
  typeCounts: { type: DnsRecordType; count: number }[] // non-empty types only
  durationMs: number
  result: DnsLookupResult        // full result, so a history click restores it without re-resolving
}

export interface DnsLookupPayload {
  config: DnsLookupConfig
}

export type DnsExportFormat = 'csv' | 'html' | 'json' | 'text'
export interface DnsExportPayload {
  result: DnsLookupResult
  format: DnsExportFormat
}

// ─── IPC push event payloads (main → renderer) ───────────────────────────────

export interface HopUpdateEvent {
  sessionId: string
  hopStats: HopStats
}
export interface HopsBatchEvent {
  sessionId: string
  hops: HopStats[]
}
export interface HopNewEvent {
  sessionId: string
  hopIndex: number
  ip: string
}
export interface DnsResolvedEvent {
  sessionId: string
  hopIndex: number
  hostname: string
}
export interface HopEnrichedEvent {
  sessionId: string
  hopIndex: number
  enrichment: EnrichmentData
}
export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
  elapsedMs: number
  totalSent: number
}
export interface PlaybackFrameEvent {
  sessionId: string
  frame: RecordingFrame
  totalDurationMs: number
  frameIndex: number
  frameCount: number
}

// ─── SSL scan ────────────────────────────────────────────────────────────────

/** One resolved IP endpoint for a host (the user picks which one to scan). */
export interface SslEndpoint {
  ip: string
  family: 4 | 6
}

export interface SslResolveConfig {
  host: string                   // hostname or IP literal from the input
}
export interface SslResolveResult {
  host: string                   // normalised host (hostname or IP)
  inputWasIp: boolean            // input was an IP literal → single endpoint, auto-scan
  endpoints: SslEndpoint[]
  error: string | null
}

export interface SslScanConfig {
  host: string                   // SNI / name used for cert hostname validation
  ip: string                     // the endpoint IP to connect to
  port: number                   // default 443
}

export type TlsProtocol = 'SSLv3' | 'TLSv1.0' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3'
/** `untested` = the local OpenSSL build can't even attempt this version (≠ server refusal). */
export type TlsProtocolSupport = 'enabled' | 'disabled' | 'untested'
export interface TlsProtocolResult {
  protocol: TlsProtocol
  support: TlsProtocolSupport
  note: string | null
}

export type CipherStrength = 'strong' | 'weak' | 'insecure'
export interface TlsCipher {
  name: string                   // IANA name, e.g. TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
  opensslName: string            // OpenSSL name used to probe
  protocol: TlsProtocol          // protocol it was negotiated under
  bits: number | null            // symmetric key size
  forwardSecrecy: boolean
  strength: CipherStrength
  note: string | null            // why weak/insecure
}

export interface SslCertificate {
  subject: string                // CN
  subjectAltNames: string[]
  issuer: string
  serialNumber: string
  validFrom: string              // ISO
  validTo: string                // ISO
  daysRemaining: number
  expired: boolean
  notYetValid: boolean
  keyType: string                // "RSA" | "EC" | …
  keyBits: number | null
  signatureAlgorithm: string
  sha256Fingerprint: string
  sha1Fingerprint: string
  isCa: boolean
  selfSigned: boolean
}

/** One link in the presented certificate chain. */
export interface SslChainCert {
  subject: string
  issuer: string
  keyType: string
  keyBits: number | null
  signatureAlgorithm: string
  validTo: string                // ISO
  expired: boolean
}

export type SslIssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export interface SslIssue {
  severity: SslIssueSeverity
  title: string
  detail: string
}

/** SSL Labs–style grade. `T` = trust problem, `M` = hostname mismatch. */
export type SslGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'T' | 'M'

/** HTTP-layer security headers read with a single HTTPS GET after the handshake. */
export interface SslHsts {
  present: boolean
  maxAge: number | null          // seconds
  includeSubDomains: boolean
  preload: boolean
  raw: string | null
}
export interface SslSecurityHeaders {
  fetched: boolean               // did we get an HTTP response at all?
  statusCode: number | null
  hsts: SslHsts
  contentSecurityPolicy: boolean
  xFrameOptions: string | null
  xContentTypeOptions: boolean
  referrerPolicy: string | null
  server: string | null
  error: string | null           // why the HTTP probe failed, when fetched=false
}

/** Certificate revocation status, learned from an OCSP response stapled to the handshake. */
export type OcspStatus = 'good' | 'revoked' | 'unknown' | 'not-stapled' | 'error'
export interface SslOcsp {
  stapled: boolean               // server stapled an OCSP response during the handshake
  status: OcspStatus
  revokedAt: string | null       // ISO, when status === 'revoked'
  producedAt: string | null      // ISO, when the responder signed the response
  detail: string | null
}

/** Change vs the previous scan of the same host+ip+port. */
export interface SslDiff {
  previousScanAt: number | null
  gradeChanged: { from: SslGrade; to: SslGrade } | null
  certChanged: boolean           // leaf SHA-256 fingerprint differs
  protocolChanges: string[]      // human-readable notes, e.g. "TLSv1.0 now disabled"
}

export interface SslScanResult {
  scanId: string
  host: string
  ip: string
  port: number
  grade: SslGrade
  hostnameMatch: boolean
  chainTrusted: boolean
  trustError: string | null      // authorizationError reason, null when trusted
  certificate: SslCertificate | null
  chain: SslChainCert[]
  protocols: TlsProtocolResult[]
  ciphers: TlsCipher[]
  negotiatedProtocol: TlsProtocol | null
  negotiatedCipher: string | null
  securityHeaders: SslSecurityHeaders | null  // HTTP-layer headers (HSTS etc.)
  ocsp: SslOcsp | null           // revocation status from stapled OCSP
  issues: SslIssue[]
  diff: SslDiff | null
  startedAt: number              // Date.now()
  durationMs: number
  error: string | null           // fatal error (couldn't connect at all), null otherwise
}

/** Persisted summary of a completed SSL scan (history + diffing). */
export interface SslScanRecord {
  id: string
  host: string
  ip: string
  port: number
  grade: SslGrade
  scannedAt: number
  durationMs: number
  certSubject: string | null
  certValidTo: string | null     // ISO
  result: SslScanResult          // full result, so a history click restores it without rescanning
}

/** An endpoint the user is watching for certificate expiry / config drift. */
export interface SslWatchEntry {
  id: string
  host: string
  ip: string
  port: number
  addedAt: number
  lastGrade: SslGrade | null
  lastScannedAt: number | null   // epoch ms of the most recent scan we recorded
  certValidTo: string | null     // ISO
  certSubject: string | null
}

export interface SslWatchAddPayload {
  host: string
  ip: string
  port: number
}

export interface SslResolvePayload {
  config: SslResolveConfig
}
export interface SslScanStartPayload {
  config: SslScanConfig
}
export interface SslScanStartResult {
  scanId: string
}
export interface SslScanCancelPayload {
  scanId: string
}

export type SslExportFormat = 'csv' | 'html' | 'json' | 'text'
export interface SslExportPayload {
  result: SslScanResult
  format: SslExportFormat
}

// Main → renderer push events
export interface SslScanProgressEvent {
  scanId: string
  percent: number | null         // 0–100, null if unknown
  message: string | null         // status line, e.g. "Enumerating TLS 1.2 ciphers"
}
export interface SslScanDoneEvent {
  scanId: string
  result: SslScanResult
}

// ─── Public Scan (ImmuniWeb-style web security test) ───────────────────────────

/** A→F web-security grade (no T/M states — those are TLS-specific). */
export type PubScanGrade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F'

export type PubFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** The audit category a check/finding belongs to. */
export type PubScanCategory = 'headers' | 'cookies' | 'csp' | 'tls' | 'dns' | 'software' | 'privacy'

/** One actionable finding, ranked by severity and tied to a category. */
export interface PubFinding {
  id: string                   // stable key (category:slug) — used for diffing across scans
  category: PubScanCategory
  severity: PubFindingSeverity
  title: string
  detail: string
  recommendation: string | null
}

/** Pass/warn/fail status used by header + email checks. */
export type PubCheckStatus = 'pass' | 'warn' | 'fail' | 'info'

/** A single HTTP response-header check. */
export interface PubHeaderCheck {
  name: string                 // canonical header name, e.g. "Strict-Transport-Security"
  present: boolean
  value: string | null
  status: PubCheckStatus
  note: string
}

/** A Set-Cookie cookie and its security flags. */
export interface PubCookie {
  name: string
  secure: boolean
  httpOnly: boolean
  sameSite: string | null      // "Strict" | "Lax" | "None" | null (unset)
}

/** Parsed Content-Security-Policy report. */
export interface PubCspReport {
  present: boolean
  raw: string | null
  directiveCount: number
  issues: string[]             // human-readable weaknesses (unsafe-inline, wildcards, …)
}

export type PubTechCategory = 'server' | 'language' | 'cms' | 'framework' | 'js-library' | 'analytics' | 'cdn' | 'other'

/** A detected software component (fingerprint only — no CVE lookup). */
export interface PubTech {
  name: string
  version: string | null
  category: PubTechCategory
  source: string               // where it was detected, e.g. "Server header"
}

/** A distinct third-party origin referenced by the page. */
export interface PubThirdParty {
  host: string
  kinds: string[]              // "script" | "stylesheet" | "iframe" | "image" | "font"
  count: number
  tracker: boolean             // matches a known analytics/ads host
}

/** Lightweight TLS summary captured from the HTTPS connection used for the probe. */
export interface PubTlsSummary {
  https: boolean               // the final URL was reached over HTTPS
  protocol: string | null      // negotiated TLS version, e.g. "TLSv1.3"
  certIssuer: string | null
  certSubject: string | null
  validTo: string | null       // ISO
  daysRemaining: number | null
  trusted: boolean
  hostnameMatch: boolean
  error: string | null
}

/** CAA presence (best-effort DNS lookup). */
export interface PubCaa {
  present: boolean
  records: string[]
}

/** Roll-up of findings against one compliance framework. */
export interface PubComplianceItem {
  framework: string            // "GDPR" | "PCI DSS" | "NIST 800-53"
  status: PubCheckStatus
  notes: string[]              // short summary lines (always shown)
  details: string[]            // specific contributing findings (shown on click)
}

/** Per-category letter grade shown in the summary matrix. */
export interface PubCategoryGrade {
  category: PubScanCategory
  grade: PubScanGrade
}

/** Change vs the previous scan of the same domain. */
export interface PubScanDiff {
  previousScanAt: number | null
  gradeChanged: { from: PubScanGrade; to: PubScanGrade } | null
  newFindings: string[]        // titles introduced since last scan
  resolvedFindings: string[]   // titles no longer present
}

export interface PubScanConfig {
  url: string                  // raw user input (host, domain, or full URL)
}

export interface PubScanResult {
  scanId: string
  input: string                // the raw input
  domain: string               // registrable host
  url: string                  // normalised URL we started from
  finalUrl: string             // after following redirects
  ip: string | null
  statusCode: number | null
  redirects: string[]          // full redirect chain (origin → … → final)
  grade: PubScanGrade
  categoryGrades: PubCategoryGrade[]
  score: number                // 0–100
  headers: PubHeaderCheck[]
  cookies: PubCookie[]
  csp: PubCspReport
  tech: PubTech[]
  thirdParty: PubThirdParty[]
  tls: PubTlsSummary | null
  email: DnsEmailSecurity | null  // reuses the DNS email-security engine
  caa: PubCaa | null
  compliance: PubComplianceItem[]
  findings: PubFinding[]
  diff: PubScanDiff | null
  startedAt: number
  durationMs: number
  error: string | null         // fatal error (couldn't fetch at all)
}

/** Persisted summary of a completed public scan (history + diffing). */
export interface PubScanRecord {
  id: string
  domain: string
  url: string
  grade: PubScanGrade
  scannedAt: number
  durationMs: number
  findingCount: number
  result: PubScanResult        // full result, so a history click restores it without rescanning
}

export interface PubScanStartPayload {
  config: PubScanConfig
}
export interface PubScanStartResult {
  scanId: string
}
export interface PubScanCancelPayload {
  scanId: string
}

export type PubScanExportFormat = 'csv' | 'html' | 'json' | 'text'
export interface PubScanExportPayload {
  result: PubScanResult
  format: PubScanExportFormat
}

// Main → renderer push events
export interface PubScanProgressEvent {
  scanId: string
  percent: number | null
  message: string | null
}
export interface PubScanDoneEvent {
  scanId: string
  result: PubScanResult
}

// ─── Wi-Fi / Wireless analyzer ─────────────────────────────────────────────────

export type WifiBand = '2.4 GHz' | '5 GHz' | '6 GHz' | 'unknown'

/** Signal-quality bucket derived from the signal percentage / RSSI. */
export type WifiSignalLevel = 'excellent' | 'good' | 'fair' | 'weak'

/** The Wi-Fi adapter's currently-associated connection (from `netsh wlan show interfaces`). */
export interface WifiConnection {
  interfaceName: string        // adapter description, e.g. "Intel(R) Wi-Fi 6 AX201"
  state: string                // "connected" | "disconnected" | …
  ssid: string | null
  bssid: string | null         // AP MAC the client is associated with
  radioType: string | null     // "802.11ax" / "802.11ac" / …
  authentication: string | null // "WPA2-Personal" / "WPA3-SAE" / "Open" …
  cipher: string | null        // "CCMP" / "GCMP" …
  band: WifiBand
  channel: number | null
  signalPercent: number | null // 0–100 as reported by netsh
  rssiDbm: number | null       // estimated RSSI from signal % (netsh gives %, not dBm)
  rxRateMbps: number | null    // receive link rate
  txRateMbps: number | null    // transmit link rate
}

/** A nearby access point discovered by scanning (`netsh wlan show networks mode=bssid`). */
export interface WifiNetwork {
  ssid: string                 // "" for hidden networks
  bssid: string | null
  signalPercent: number | null
  rssiDbm: number | null
  band: WifiBand
  channel: number | null
  radioType: string | null
  authentication: string | null
  cipher: string | null
  isCurrent: boolean           // true if this BSSID is the one we're associated with
}

/** Per-channel occupancy summary for the congestion chart. */
export interface WifiChannelUsage {
  band: WifiBand
  channel: number
  networkCount: number
  strongestSignalPercent: number  // strongest AP seen on this channel
}

export interface WifiScanResult {
  available: boolean           // false when no WLAN service / adapter / unsupported OS
  reason: string | null        // why unavailable (shown to the user)
  notice?: string | null       // non-fatal caveat shown above the results (e.g. macOS SSID redaction)
  connection: WifiConnection | null
  networks: WifiNetwork[]
  channelUsage: WifiChannelUsage[]
  scanDurationMs: number
}

export type WifiScanPayload = Record<string, never>

// ─── Monitors / scheduled health checks ────────────────────────────────────────

export type MonitorType = 'http' | 'tcp' | 'ping' | 'dns' | 'cert'

/** Health state of a monitor after its most recent check. */
export type MonitorStatus = 'up' | 'down' | 'degraded' | 'unknown'

/** User-configurable monitor. `target` meaning depends on `type`:
 *  http → URL · tcp/ping/cert → host (port for tcp/cert) · dns → name. */
export interface MonitorConfig {
  id: string
  label: string
  type: MonitorType
  target: string
  port: number | null          // tcp / cert
  intervalSec: number          // how often to run the check
  enabled: boolean
  createdAt: number
  // Thresholds (all optional; defaults applied in the engine)
  expectStatusMin: number | null   // http: lowest acceptable status code (default 200)
  expectStatusMax: number | null   // http: highest acceptable status code (default 399)
  latencyWarnMs: number | null     // http/tcp/ping: degraded above this latency
  expiryWarnDays: number | null    // cert: degraded when fewer days remain
  dnsRecordType: string | null     // dns: record type to resolve (default 'A')
}

/** One recorded check outcome (kept in a bounded rolling log per monitor). */
export interface MonitorResult {
  monitorId: string
  checkedAt: number
  status: MonitorStatus
  latencyMs: number | null
  message: string | null       // human-readable detail (status code, error, cert days …)
  value: number | null         // type-specific numeric (status code, cert days remaining …)
}

/** An up→down / recovery transition, for the incident timeline. */
export interface MonitorIncident {
  id: string
  monitorId: string
  startedAt: number
  resolvedAt: number | null    // null while ongoing
  status: MonitorStatus        // the failing status that opened the incident
  reason: string | null
}

/** Rolling aggregates the renderer shows per monitor. */
export interface MonitorStats {
  status: MonitorStatus
  lastCheckedAt: number | null
  lastLatencyMs: number | null
  lastMessage: string | null
  uptime24hPct: number | null  // % of checks "up" in the last 24h (null if no data)
  avgLatency24hMs: number | null
  checks24h: number
  recent: MonitorResult[]      // newest-last, for the sparkline (bounded)
}

/** A monitor plus its live stats — the unit the renderer renders. */
export interface MonitorView {
  config: MonitorConfig
  stats: MonitorStats
}

// Renderer → main payloads
export interface MonitorAddPayload {
  config: Omit<MonitorConfig, 'id' | 'createdAt'>
}
export interface MonitorUpdatePayload {
  id: string
  patch: Partial<Omit<MonitorConfig, 'id' | 'createdAt'>>
}

// Main → renderer push events
export interface MonitorResultEvent {
  result: MonitorResult
  stats: MonitorStats
}
export interface MonitorStateChangeEvent {
  monitorId: string
  label: string
  from: MonitorStatus
  to: MonitorStatus
  reason: string | null
  at: number
}
