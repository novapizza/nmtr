import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../main/ipc/channels'
import type {
  TraceStartPayload,
  TraceStartResult,
  TracePausePayload,
  TraceResumePayload,
  TraceStopPayload,
  TraceResetPayload,
  ExportPayload,
  ExportResult,
  WhoisPayload,
  WhoisResult,
  AppSettings,
  HistoryEntry,
  RecordingStartPayload,
  RecordingStopPayload,
  RecordingStopResult,
  PlaybackOpenResult,
  PlaybackStartPayload,
  PlaybackSeekPayload,
  PlaybackStopPayload,
  LanScanResult,
  PortScanStartPayload,
  PortScanStartResult,
  PortScanCancelPayload,
  PortScanExportPayload,
  PortScanRecord,
  NmapCheckResult,
  PortScanProgressEvent,
  PortScanDoneEvent,
  DnsLookupPayload,
  DnsLookupResult,
  DnsExportPayload,
  DnsHistoryRecord,
  DnsPropagationPayload,
  DnsPropagationResult,
  DnsEmailPayload,
  DnsEmailSecurity,
  DnsFcrdnsPayload,
  DnsFcrdnsResult,
  DnsDelegationPayload,
  DnsDelegationResult,
  SslResolvePayload,
  SslResolveResult,
  SslScanStartPayload,
  SslScanStartResult,
  SslScanCancelPayload,
  SslExportPayload,
  SslScanRecord,
  SslWatchEntry,
  SslWatchAddPayload,
  SslScanProgressEvent,
  SslScanDoneEvent,
  PubScanStartPayload,
  PubScanStartResult,
  PubScanCancelPayload,
  PubScanExportPayload,
  PubScanRecord,
  PubScanProgressEvent,
  PubScanDoneEvent,
  WifiScanResult,
  MonitorConfig,
  MonitorView,
  MonitorIncident,
  MonitorAddPayload,
  MonitorUpdatePayload,
  MonitorResultEvent,
  MonitorStateChangeEvent,
  OpenExternalPayload,
  HopUpdateEvent,
  HopsBatchEvent,
  HopNewEvent,
  DnsResolvedEvent,
  HopEnrichedEvent,
  SessionStatusEvent,
  PlaybackFrameEvent,
  RouteChangeEvent,
  TracertResultEvent
} from '../shared/types'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const handler = (_: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const nmtrAPI = {
  /** Host OS — lets the renderer adapt chrome (e.g. macOS traffic lights vs. Windows buttons). */
  platform: process.platform,

  // ── Trace control ──────────────────────────────────────────────────────────
  traceStart: (payload: TraceStartPayload): Promise<TraceStartResult> =>
    ipcRenderer.invoke(IPC.TRACE_START, payload),
  tracePause: (payload: TracePausePayload): Promise<void> =>
    ipcRenderer.invoke(IPC.TRACE_PAUSE, payload),
  traceResume: (payload: TraceResumePayload): Promise<void> =>
    ipcRenderer.invoke(IPC.TRACE_RESUME, payload),
  traceStop: (payload: TraceStopPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.TRACE_STOP, payload),
  traceReset: (payload: TraceResetPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.TRACE_RESET, payload),
  traceExport: (payload: ExportPayload): Promise<ExportResult> =>
    ipcRenderer.invoke(IPC.TRACE_EXPORT, payload),

  // ── Enrichment ─────────────────────────────────────────────────────────────
  whoisFetch: (payload: WhoisPayload): Promise<WhoisResult> =>
    ipcRenderer.invoke(IPC.WHOIS_FETCH, payload),

  // ── Settings ───────────────────────────────────────────────────────────────
  settingsGet: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  settingsSet: (settings: Partial<AppSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC.SETTINGS_SET, settings),

  // ── Recording ──────────────────────────────────────────────────────────────
  recordingStart: (payload: RecordingStartPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.RECORDING_START, payload),
  recordingStop: (payload: RecordingStopPayload): Promise<RecordingStopResult> =>
    ipcRenderer.invoke(IPC.RECORDING_STOP, payload),

  // ── Playback ───────────────────────────────────────────────────────────────
  playbackOpen: (): Promise<PlaybackOpenResult | null> =>
    ipcRenderer.invoke(IPC.PLAYBACK_OPEN),
  playbackStart: (payload: PlaybackStartPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.PLAYBACK_START, payload),
  playbackSeek: (payload: PlaybackSeekPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.PLAYBACK_SEEK, payload),
  playbackStop: (payload: PlaybackStopPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.PLAYBACK_STOP, payload),

  // ── LAN Network ────────────────────────────────────────────────────────────
  lanScan: (): Promise<LanScanResult> =>
    ipcRenderer.invoke(IPC.LAN_SCAN),

  // ── Port scan (nmap) ─────────────────────────────────────────────────────────
  portScanCheck: (): Promise<NmapCheckResult> =>
    ipcRenderer.invoke(IPC.PORTSCAN_CHECK),
  portScanStart: (payload: PortScanStartPayload): Promise<PortScanStartResult> =>
    ipcRenderer.invoke(IPC.PORTSCAN_START, payload),
  portScanCancel: (payload: PortScanCancelPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.PORTSCAN_CANCEL, payload),
  portScanExport: (payload: PortScanExportPayload): Promise<ExportResult> =>
    ipcRenderer.invoke(IPC.PORTSCAN_EXPORT, payload),
  portScanHistoryGet: (): Promise<PortScanRecord[]> =>
    ipcRenderer.invoke(IPC.PORTSCAN_HISTORY_GET),
  portScanHistoryClear: (): Promise<void> =>
    ipcRenderer.invoke(IPC.PORTSCAN_HISTORY_CLEAR),
  onPortScanProgress: (cb: (e: PortScanProgressEvent) => void): Unsubscribe =>
    on(IPC.PORTSCAN_PROGRESS, cb),
  onPortScanDone: (cb: (e: PortScanDoneEvent) => void): Unsubscribe =>
    on(IPC.PORTSCAN_DONE, cb),

  // ── DNS resolve ──────────────────────────────────────────────────────────────
  dnsLookup: (payload: DnsLookupPayload): Promise<DnsLookupResult> =>
    ipcRenderer.invoke(IPC.DNS_LOOKUP, payload),
  dnsExport: (payload: DnsExportPayload): Promise<ExportResult> =>
    ipcRenderer.invoke(IPC.DNS_EXPORT, payload),
  dnsHistoryGet: (): Promise<DnsHistoryRecord[]> =>
    ipcRenderer.invoke(IPC.DNS_HISTORY_GET),
  dnsHistoryClear: (): Promise<void> =>
    ipcRenderer.invoke(IPC.DNS_HISTORY_CLEAR),
  dnsHistoryRemove: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.DNS_HISTORY_REMOVE, id),
  dnsPropagation: (payload: DnsPropagationPayload): Promise<DnsPropagationResult> =>
    ipcRenderer.invoke(IPC.DNS_PROPAGATION, payload),
  dnsEmail: (payload: DnsEmailPayload): Promise<DnsEmailSecurity> =>
    ipcRenderer.invoke(IPC.DNS_EMAIL, payload),
  dnsFcrdns: (payload: DnsFcrdnsPayload): Promise<DnsFcrdnsResult> =>
    ipcRenderer.invoke(IPC.DNS_FCRDNS, payload),
  dnsDelegation: (payload: DnsDelegationPayload): Promise<DnsDelegationResult> =>
    ipcRenderer.invoke(IPC.DNS_DELEGATION, payload),

  // ── SSL scan ──────────────────────────────────────────────────────────────────
  sslResolve: (payload: SslResolvePayload): Promise<SslResolveResult> =>
    ipcRenderer.invoke(IPC.SSL_RESOLVE, payload),
  sslScanStart: (payload: SslScanStartPayload): Promise<SslScanStartResult> =>
    ipcRenderer.invoke(IPC.SSL_SCAN_START, payload),
  sslScanCancel: (payload: SslScanCancelPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.SSL_SCAN_CANCEL, payload),
  sslExport: (payload: SslExportPayload): Promise<ExportResult> =>
    ipcRenderer.invoke(IPC.SSL_EXPORT, payload),
  sslHistoryGet: (): Promise<SslScanRecord[]> =>
    ipcRenderer.invoke(IPC.SSL_HISTORY_GET),
  sslHistoryClear: (): Promise<void> =>
    ipcRenderer.invoke(IPC.SSL_HISTORY_CLEAR),
  sslHistoryRemove: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.SSL_HISTORY_REMOVE, id),
  sslWatchGet: (): Promise<SslWatchEntry[]> =>
    ipcRenderer.invoke(IPC.SSL_WATCH_GET),
  sslWatchAdd: (payload: SslWatchAddPayload): Promise<SslWatchEntry[]> =>
    ipcRenderer.invoke(IPC.SSL_WATCH_ADD, payload),
  sslWatchRemove: (id: string): Promise<SslWatchEntry[]> =>
    ipcRenderer.invoke(IPC.SSL_WATCH_REMOVE, id),
  onSslProgress: (cb: (e: SslScanProgressEvent) => void): Unsubscribe =>
    on(IPC.SSL_PROGRESS, cb),
  onSslDone: (cb: (e: SslScanDoneEvent) => void): Unsubscribe =>
    on(IPC.SSL_DONE, cb),

  // ── Public Scan / web security test ───────────────────────────────────────────
  pubScanStart: (payload: PubScanStartPayload): Promise<PubScanStartResult> =>
    ipcRenderer.invoke(IPC.PUBSCAN_START, payload),
  pubScanCancel: (payload: PubScanCancelPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.PUBSCAN_CANCEL, payload),
  pubScanExport: (payload: PubScanExportPayload): Promise<ExportResult> =>
    ipcRenderer.invoke(IPC.PUBSCAN_EXPORT, payload),
  pubScanHistoryGet: (): Promise<PubScanRecord[]> =>
    ipcRenderer.invoke(IPC.PUBSCAN_HISTORY_GET),
  pubScanHistoryClear: (): Promise<void> =>
    ipcRenderer.invoke(IPC.PUBSCAN_HISTORY_CLEAR),
  pubScanHistoryRemove: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.PUBSCAN_HISTORY_REMOVE, id),
  onPubScanProgress: (cb: (e: PubScanProgressEvent) => void): Unsubscribe =>
    on(IPC.PUBSCAN_PROGRESS, cb),
  onPubScanDone: (cb: (e: PubScanDoneEvent) => void): Unsubscribe =>
    on(IPC.PUBSCAN_DONE, cb),

  // ── Wi-Fi analyzer ─────────────────────────────────────────────────────────────
  wifiScan: (): Promise<WifiScanResult> =>
    ipcRenderer.invoke(IPC.WIFI_SCAN),

  // ── Monitors / scheduled health checks ──────────────────────────────────────────
  monitorList: (): Promise<MonitorView[]> =>
    ipcRenderer.invoke(IPC.MONITOR_LIST),
  monitorAdd: (payload: MonitorAddPayload): Promise<MonitorConfig> =>
    ipcRenderer.invoke(IPC.MONITOR_ADD, payload),
  monitorUpdate: (payload: MonitorUpdatePayload): Promise<MonitorConfig | undefined> =>
    ipcRenderer.invoke(IPC.MONITOR_UPDATE, payload),
  monitorRemove: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.MONITOR_REMOVE, id),
  monitorRunNow: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.MONITOR_RUN_NOW, id),
  monitorIncidents: (): Promise<MonitorIncident[]> =>
    ipcRenderer.invoke(IPC.MONITOR_INCIDENTS),
  monitorClearHistory: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.MONITOR_CLEAR_HISTORY, id),
  onMonitorResult: (cb: (e: MonitorResultEvent) => void): Unsubscribe =>
    on(IPC.MONITOR_RESULT, cb),
  onMonitorStateChange: (cb: (e: MonitorStateChangeEvent) => void): Unsubscribe =>
    on(IPC.MONITOR_STATE_CHANGE, cb),

  // ── Shell ────────────────────────────────────────────────────────────────────
  openExternal: (payload: OpenExternalPayload): Promise<void> =>
    ipcRenderer.invoke(IPC.OPEN_EXTERNAL, payload),

  // ── Window controls ────────────────────────────────────────────────────────
  windowMinimize: (): void => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  windowMaximize: (): void => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
  windowClose: (): void => ipcRenderer.send(IPC.WINDOW_CLOSE),

  // ── Push event subscriptions (main → renderer) ────────────────────────────
  onHopUpdate: (cb: (e: HopUpdateEvent) => void): Unsubscribe =>
    on(IPC.HOP_UPDATE, cb),
  onHopsBatch: (cb: (e: HopsBatchEvent) => void): Unsubscribe =>
    on(IPC.HOPS_BATCH, cb),
  onHopNew: (cb: (e: HopNewEvent) => void): Unsubscribe =>
    on(IPC.HOP_NEW, cb),
  onDnsResolved: (cb: (e: DnsResolvedEvent) => void): Unsubscribe =>
    on(IPC.DNS_RESOLVED, cb),
  onHopEnriched: (cb: (e: HopEnrichedEvent) => void): Unsubscribe =>
    on(IPC.HOP_ENRICHED, cb),
  onSessionStatus: (cb: (e: SessionStatusEvent) => void): Unsubscribe =>
    on(IPC.SESSION_STATUS, cb),
  onPlaybackFrame: (cb: (e: PlaybackFrameEvent) => void): Unsubscribe =>
    on(IPC.PLAYBACK_FRAME, cb),
  onHopRouteChanged: (cb: (e: RouteChangeEvent) => void): Unsubscribe =>
    on(IPC.HOP_ROUTE_CHANGED, cb),
  onSessionReset: (cb: (e: { sessionId: string }) => void): Unsubscribe =>
    on(IPC.SESSION_RESET, cb),
  onTracertResult: (cb: (e: TracertResultEvent) => void): Unsubscribe =>
    on(IPC.TRACERT_RESULT, cb),

  // ── History ────────────────────────────────────────────────────────────────
  historyGet: (): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.HISTORY_GET),
  historyClear: (): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_CLEAR),
  historyRemove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.HISTORY_REMOVE, id),
  onHistoryEntryAdded: (cb: (entry: HistoryEntry) => void): Unsubscribe =>
    on(IPC.HISTORY_ENTRY_ADDED, cb),

  // ── Auto-update ────────────────────────────────────────────────────────────
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
  onUpdateChecking: (cb: (e: { manual: boolean }) => void): Unsubscribe =>
    on(IPC.UPDATE_CHECKING, cb),
  onUpdateAvailable: (cb: (e: { version: string; manual: boolean }) => void): Unsubscribe =>
    on(IPC.UPDATE_AVAILABLE, cb),
  onUpdateNotAvailable: (cb: (e: { version: string; manual: boolean }) => void): Unsubscribe =>
    on(IPC.UPDATE_NOT_AVAILABLE, cb),
  onUpdateDownloading: (cb: (e: { percent: number }) => void): Unsubscribe =>
    on(IPC.UPDATE_DOWNLOADING, cb),
  onUpdateDownloaded: (cb: (e: { version: string }) => void): Unsubscribe =>
    on(IPC.UPDATE_DOWNLOADED, cb),
  onUpdateError: (cb: (e: { message: string; manual: boolean }) => void): Unsubscribe =>
    on(IPC.UPDATE_ERROR, cb)
}

contextBridge.exposeInMainWorld('nmtrAPI', nmtrAPI)

export type NmtrAPI = typeof nmtrAPI
