import React from 'react'
import { SettingsDialog } from '../dialogs/SettingsDialog'
import { useUIStore } from '../../store/useUIStore'

// macOS draws native traffic lights over the left of the bar; Windows gets our own buttons.
const isMac = window.nmtrAPI.platform === 'darwin'

export function TitleBar(): React.JSX.Element {
  const { settingsOpen, closeSettings } = useUIStore()

  return (
    <div className="drag-region flex h-9 items-center justify-between bg-canvas-subtle border-b border-border-default flex-shrink-0 select-none">
      {/* Left: logo */}
      <div className={`flex items-center gap-2.5 pr-4 no-drag pointer-events-none ${isMac ? 'pl-[84px]' : 'pl-4'}`}>
        <span className="font-mono font-bold tracking-tight text-[21px] leading-none">
          <span className="text-fg-muted">{`{`}</span>
          <span className="text-accent-blue">NMTR</span>
          <span className="text-fg-muted">{`}`}</span>
        </span>
        <span className="text-fg-subtle text-[18px] font-medium tracking-wide uppercase">Network Diagnostic</span>
      </div>

      {/* Right: Windows-style window controls (macOS uses the native traffic lights) */}
      {!isMac && <div className="flex items-stretch h-full no-drag">
        <button
          className="w-11 flex items-center justify-center text-fg-muted hover:bg-canvas-hover hover:text-fg-default transition-colors"
          onClick={() => window.nmtrAPI.windowMinimize()}
          title="Minimize"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor">
            <rect width="10" height="1" />
          </svg>
        </button>
        <button
          className="w-11 flex items-center justify-center text-fg-muted hover:bg-canvas-hover hover:text-fg-default transition-colors"
          onClick={() => window.nmtrAPI.windowMaximize()}
          title="Maximize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        </button>
        <button
          className="w-11 flex items-center justify-center text-fg-muted hover:bg-accent-red hover:text-white transition-colors"
          onClick={() => window.nmtrAPI.windowClose()}
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
            <line x1="0" y1="0" x2="10" y2="10" />
            <line x1="10" y1="0" x2="0" y2="10" />
          </svg>
        </button>
      </div>}

      <SettingsDialog open={settingsOpen} onClose={closeSettings} />
    </div>
  )
}
