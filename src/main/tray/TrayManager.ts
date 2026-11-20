import { Tray, Menu, app } from 'electron'
import type { BrowserWindow } from 'electron'
import { createLogoIcon } from '../utils/logoIcon'

export class TrayManager {
  private tray: Tray | null = null
  private window: BrowserWindow

  constructor(window: BrowserWindow) {
    this.window = window
    this.create()
  }

  private create(): void {
    const icon = createLogoIcon('tray')
    this.tray = new Tray(icon)
    this.tray.setToolTip('nmtr — Network Diagnostic Tool')
    this.updateMenu()

    this.tray.on('double-click', () => {
      this.window.show()
      this.window.focus()
    })
  }

  updateMenu(activeSessions: Array<{ id: string; target: string; status: string }> = []): void {
    if (!this.tray) return

    const sessionItems: Electron.MenuItemConstructorOptions[] = activeSessions.map((s) => ({
      label: `${s.target} — ${s.status}`,
      enabled: false
    }))

    const menu = Menu.buildFromTemplate([
      { label: 'nmtr', enabled: false },
      { type: 'separator' },
      ...(sessionItems.length > 0
        ? [...sessionItems, { type: 'separator' as const }]
        : []),
      {
        label: 'Show nmtr',
        click: () => {
          this.window.show()
          this.window.focus()
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          this.tray?.destroy()
          app.exit(0)
        }
      }
    ])

    this.tray.setContextMenu(menu)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
