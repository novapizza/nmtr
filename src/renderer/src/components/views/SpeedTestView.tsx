import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import SpeedTest from '@cloudflare/speedtest'
import { Activity, Download, Upload, Play, Square, RefreshCw, AlertCircle, Info, BarChart3, X } from 'lucide-react'
import { SpeedTestMeasurements } from './SpeedTestMeasurements'
import { useSettingsStore } from '../../store/useSettingsStore'

export function SpeedTestView(): React.JSX.Element {
  const { settings } = useSettingsStore()

  // Prefer TURN config from Settings → TURN tab; fall back to build-time env vars.
  // The library prepends "turn:" and appends "?transport=udp", so strip any scheme here.
  const turnServerUri = (settings.turnServerUri || import.meta.env.VITE_TURN_SERVER_URI || '').replace(/^turns?:/i, '')
  const turnServerUser = settings.turnServerUser || import.meta.env.VITE_TURN_SERVER_USER || ''
  const turnServerPass = settings.turnServerPass || import.meta.env.VITE_TURN_SERVER_PASS || ''
  const hasTurnConfig = !!(turnServerUri && turnServerUser && turnServerPass)

  const [isRunning, setIsRunning] = useState(false)
  const [isFinished, setIsFinished] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [results, setResults] = useState<any>({
    ping: undefined,
    jitter: undefined,
    download: undefined,
    upload: undefined,
    packetLoss: undefined
  })
  const [error, setError] = useState<string | null>(null)
  const [currentTest, setCurrentTest] = useState<string>('Idle')
  const speedtestRef = useRef<any>(null)

  const startTest = (): void => {
    if (speedtestRef.current) {
      // Disconnect callbacks before pausing so stale async events
      // from the old engine don't overwrite new engine state.
      speedtestRef.current.onRunningChange = null
      speedtestRef.current.onResultsChange = null
      speedtestRef.current.onFinish = null
      speedtestRef.current.onError = null
      speedtestRef.current.pause()
    }

    setIsRunning(true)
    setResults({
      ping: undefined,
      jitter: undefined,
      download: undefined,
      upload: undefined,
      packetLoss: undefined
    })
    setIsFinished(false)
    setError(null)
    setCurrentTest('Connecting...')

    const engine = new SpeedTest({
      autoStart: true,
      ...(hasTurnConfig && {
        turnServerUri,
        turnServerUser,
        turnServerPass
      }),
      measurements: [
        { type: 'latency', numPackets: 1 },
        { type: 'download', bytes: 1e5, count: 1, bypassMinDuration: true },
        { type: 'latency', numPackets: 20 },
        // Packet loss requires a TURN server; skip if none is configured.
        ...(hasTurnConfig ? [{ type: 'packetLoss', numPackets: 1e3, batchSize: 10, batchWaitTime: 10, responsesWaitTime: 3000 } as const] : []),
        { type: 'download', bytes: 1e5, count: 9 },
        { type: 'download', bytes: 1e6, count: 8 },
        { type: 'upload', bytes: 1e5, count: 8 },
        { type: 'upload', bytes: 1e6, count: 6 },
        { type: 'download', bytes: 1e7, count: 6 },
        { type: 'upload', bytes: 1e7, count: 4 },
        { type: 'download', bytes: 2.5e7, count: 4 },
        { type: 'upload', bytes: 2.5e7, count: 4 },
        // speed.cloudflare.com/__down now answers 403 (without CORS headers, so it
        // surfaces as a "CORS"/connection error) for bytes >= 1e8. Fast links reach
        // these steps (the engine only escalates while requests finish < ~1 s), so
        // keep every download below that cap.
        { type: 'download', bytes: 5e7, count: 4 },
        { type: 'upload', bytes: 5e7, count: 3 },
        { type: 'download', bytes: 9e7, count: 2 }
      ]
    })
    speedtestRef.current = engine

    engine.onRunningChange = (running: boolean): void => {
      setIsRunning(running)
      if (!running && !engine.isFinished) {
        setCurrentTest('Paused')
      }
    }

    engine.onResultsChange = ({ type }: { type: string }): void => {
      setCurrentTest(`Testing ${type}...`)
      setResults({
        ping: engine.results.getUnloadedLatency(),
        jitter: engine.results.getUnloadedJitter(),
        download: engine.results.getDownloadBandwidth(),
        upload: engine.results.getUploadBandwidth(),
        packetLoss: engine.results.getPacketLoss(),
        downLoadedLatency: engine.results.getDownLoadedLatency(),
        downLoadedJitter: engine.results.getDownLoadedJitter(),
        upLoadedLatency: engine.results.getUpLoadedLatency(),
        upLoadedJitter: engine.results.getUpLoadedJitter(),
        raw: {
          download: engine.results.getDownloadBandwidthPoints(),
          upload: engine.results.getUploadBandwidthPoints(),
          latency: engine.results.getUnloadedLatencyPoints(),
          downLoadedLatency: engine.results.getDownLoadedLatencyPoints(),
          upLoadedLatency: engine.results.getUpLoadedLatencyPoints(),
          packetLoss: engine.results.getPacketLossDetails()
        }
      })
    }

    engine.onFinish = (finalResults: any): void => {
      setIsFinished(true)
      setIsRunning(false)
      setCurrentTest('Finished')
      setResults({
        ping: finalResults.getUnloadedLatency(),
        jitter: finalResults.getUnloadedJitter(),
        download: finalResults.getDownloadBandwidth(),
        upload: finalResults.getUploadBandwidth(),
        packetLoss: finalResults.getPacketLoss(),
        downLoadedLatency: finalResults.getDownLoadedLatency(),
        downLoadedJitter: finalResults.getDownLoadedJitter(),
        upLoadedLatency: finalResults.getUpLoadedLatency(),
        upLoadedJitter: finalResults.getUpLoadedJitter(),
        scores: finalResults.getScores(),
        raw: {
          download: finalResults.getDownloadBandwidthPoints(),
          upload: finalResults.getUploadBandwidthPoints(),
          latency: finalResults.getUnloadedLatencyPoints(),
          downLoadedLatency: finalResults.getDownLoadedLatencyPoints(),
          upLoadedLatency: finalResults.getUpLoadedLatencyPoints(),
          packetLoss: finalResults.getPacketLossDetails()
        }
      })
    }

    engine.onError = (err: string): void => {
      setIsRunning(false)
      // If we already have meaningful results and only the ICE/TURN relay
      // timed out, surface a warning but keep the partial results visible.
      const isIceTimeout = typeof err === 'string' && err.toLowerCase().includes('ice connection timeout')
      const hasPartialResults =
        engine.results.getDownloadBandwidth() != null ||
        engine.results.getUploadBandwidth() != null ||
        engine.results.getUnloadedLatency() != null

      if (isIceTimeout && hasPartialResults) {
        setCurrentTest('Partial results (ICE timeout)')
        setError('Packet loss measurement failed due to an ICE connection timeout. Other results are still available.')
        setIsFinished(true)
      } else {
        setError(err)
        setCurrentTest('Error')
      }
    }
  }

  const stopTest = (): void => {
    if (speedtestRef.current) {
      speedtestRef.current.pause()
      setIsRunning(false)
      setCurrentTest('Stopped')
    }
  }

  useEffect(() => {
    return () => {
      if (speedtestRef.current) {
        speedtestRef.current.pause()
      }
    }
  }, [])

  // Close the details modal on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShowDetails(false)
    }
    if (showDetails) window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showDetails])

  const formatMbps = (bps: number | undefined | null): string => {
    if (bps === undefined || bps === null || isNaN(bps)) return '--'
    return (bps / 1000000).toFixed(2)
  }

  const formatMs = (ms: number | undefined | null): string => {
    if (ms === undefined || ms === null || isNaN(ms)) return '--'
    return ms.toFixed(1)
  }

  const formatPercent = (val: number | undefined | null): string => {
    if (val === undefined || val === null || isNaN(val)) return '--'
    return (val * 100).toFixed(1)
  }

  const hasResults = !!results.raw

  return (
    <div className="flex-1 overflow-hidden p-6 flex flex-col">
      <div className="w-full max-w-5xl mx-auto flex flex-col min-h-0">
        {/* Main Dashboard */}
        <div className="bg-canvas-subtle rounded-xl shadow-2xl p-6 border border-border-default">
          {/* Status Bar */}
          <div className="flex items-center justify-between mb-6 pb-5 border-b border-border-default">
            <div className="flex items-center gap-3">
              <div
                className={`w-3 h-3 rounded-full ${
                  isRunning
                    ? 'bg-accent-green animate-pulse'
                    : isFinished
                      ? 'bg-accent-blue'
                      : 'bg-fg-subtle'
                }`}
              />
              <span className="text-sm font-mono text-fg-muted uppercase tracking-wider">
                {currentTest}
              </span>
            </div>

            <div className="flex gap-3">
              {hasResults && (
                <button
                  onClick={() => setShowDetails(true)}
                  className="flex items-center gap-2 bg-canvas-hover hover:bg-canvas-overlay text-fg-default px-4 py-2.5 rounded font-bold transition-all active:scale-95 border border-border-default"
                >
                  <BarChart3 className="w-4 h-4" />
                  View details
                </button>
              )}
              {!isRunning ? (
                <button
                  onClick={startTest}
                  className="flex items-center gap-2 bg-accent-green hover:bg-accent-green/90 text-canvas-inset px-6 py-2.5 rounded font-bold transition-all active:scale-95"
                >
                  {isFinished || results.ping !== undefined ? (
                    <RefreshCw className="w-4 h-4" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  {isFinished || results.ping !== undefined ? 'Restart' : 'Start Test'}
                </button>
              ) : (
                <button
                  onClick={stopTest}
                  className="flex items-center gap-2 bg-canvas-hover hover:bg-canvas-overlay text-fg-default px-6 py-2.5 rounded font-bold transition-all active:scale-95 border border-border-default"
                >
                  <Square className="w-4 h-4" />
                  Stop
                </button>
              )}
            </div>
          </div>

          {/* TURN not configured notice */}
          {!hasTurnConfig && (
            <div className="mb-6 p-3 bg-canvas-inset border border-border-default rounded-lg flex items-center gap-3 text-fg-muted">
              <Info className="w-4 h-4 shrink-0 text-accent-blue" />
              <p className="text-xs font-mono">
                <span className="font-bold text-fg-default">Packet loss test disabled</span>
                {' '}— add a TURN server in <span className="text-accent-green">Settings → TURN</span> to enable it.
              </p>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-accent-red/10 border border-accent-red/30 rounded flex items-start gap-3 text-accent-red">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold mb-1">Test Failed</h3>
                <p className="text-sm font-mono opacity-90">{error}</p>
              </div>
            </div>
          )}

          {/* Metrics Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Ping */}
            <div className="bg-canvas-inset border border-border-default rounded-xl p-6 flex flex-col">
              <div className="flex items-center gap-3 text-fg-muted mb-4">
                <Activity className="w-5 h-5 text-accent-blue" />
                <span className="font-medium">Ping</span>
              </div>
              <div className="flex items-baseline gap-2 mt-auto">
                <span className="text-4xl font-bold text-fg-default tracking-tight">
                  {formatMs(results.ping)}
                </span>
                <span className="text-fg-muted font-medium">ms</span>
              </div>
              <div className="mt-2 text-xs text-fg-muted font-mono flex flex-col gap-1">
                {results.jitter !== undefined && !isNaN(results.jitter) && (
                  <div>Jitter: {formatMs(results.jitter)} ms</div>
                )}
                {results.downLoadedLatency !== undefined && !isNaN(results.downLoadedLatency) && (
                  <div>Loaded (DL): {formatMs(results.downLoadedLatency)} ms</div>
                )}
                {results.upLoadedLatency !== undefined && !isNaN(results.upLoadedLatency) && (
                  <div>Loaded (UL): {formatMs(results.upLoadedLatency)} ms</div>
                )}
              </div>
            </div>

            {/* Download */}
            <div className="bg-canvas-inset border border-border-default rounded-xl p-6 flex flex-col">
              <div className="flex items-center gap-3 text-fg-muted mb-4">
                <Download className="w-5 h-5 text-accent-green" />
                <span className="font-medium">Download</span>
              </div>
              <div className="flex items-baseline gap-2 mt-auto">
                <span className="text-4xl font-bold text-fg-default tracking-tight">
                  {formatMbps(results.download)}
                </span>
                <span className="text-fg-muted font-medium">Mbps</span>
              </div>
            </div>

            {/* Upload */}
            <div className="bg-canvas-inset border border-border-default rounded-xl p-6 flex flex-col">
              <div className="flex items-center gap-3 text-fg-muted mb-4">
                <Upload className="w-5 h-5 text-purple-400" />
                <span className="font-medium">Upload</span>
              </div>
              <div className="flex items-baseline gap-2 mt-auto">
                <span className="text-4xl font-bold text-fg-default tracking-tight">
                  {formatMbps(results.upload)}
                </span>
                <span className="text-fg-muted font-medium">Mbps</span>
              </div>
            </div>
          </div>

          {/* Scores & Packet Loss */}
          {isFinished && results.scores && (
            <div className="mt-6 pt-6 border-t border-border-default grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="flex flex-col">
                <span className="text-sm text-fg-muted font-mono mb-1">Packet Loss</span>
                <span className="text-lg font-medium text-fg-default">
                  {results.packetLoss !== undefined && results.packetLoss !== null
                    ? `${formatPercent(results.packetLoss)}%`
                    : '--%'}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-sm text-fg-muted font-mono mb-1">Streaming Score</span>
                <span className="text-lg font-medium text-fg-default capitalize">
                  {results.scores.streaming?.classificationName || '--'}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-sm text-fg-muted font-mono mb-1">Gaming Score</span>
                <span className="text-lg font-medium text-fg-default capitalize">
                  {results.scores.gaming?.classificationName || '--'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Detailed Measurements — modal so the page itself never scrolls */}
      {showDetails && hasResults && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:p-6"
          onClick={() => setShowDetails(false)}
        >
          <div
            className="w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowDetails(false)}
              className="self-end mb-2 p-2 text-fg-muted hover:text-fg-default bg-canvas-subtle border border-border-default rounded transition-colors"
              aria-label="Close details"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="overflow-y-auto">
              <SpeedTestMeasurements rawData={results.raw} />
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
