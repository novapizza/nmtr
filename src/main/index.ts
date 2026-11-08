import { app, BrowserWindow, ipcMain, nativeTheme, session, protocol, net, shell } from 'electron'
import { join, normalize, sep } from 'path'
import { pathToFileURL } from 'url'
import { registerHandlers, setTrayManager, applyLaunchAtLogin } from './ipc/handlers'
import { ProberManager } from './prober/ProberManager'
import { MonitorEngine } from './monitor/MonitorEngine'
import { TrayManager } from './tray/TrayManager'
import { AppSettingsStore } from './store/AppSettings'
import { UpdateManager } from './updater/UpdateManager'
import { createLogoIcon } from './utils/logoIcon'

let mainWindow: BrowserWindow | null = null
let trayManager: TrayManager | null = null
// Set once a real quit starts (Cmd+Q, tray Quit, update install) so the
// close handler stops turning window closes into hides.
let isQuitting = false

const isMac = process.platform === 'darwin'

// Production renderer is served from app://nmtr/ instead of file://.
// A file:// page has an opaque origin, and Chromium then zeroes the detailed
// Resource Timing fields (requestStart/responseStart/transferSize) of every
// cross-origin request even when the server sends `Timing-Allow-Origin: *`.
// @cloudflare/speedtest computes ping and bandwidth from exactly those fields,
// so under file:// it reported ~0 ms ping and near-zero speeds.
const APP_SCHEME = 'app'
const APP_ORIGIN = `${APP_SCHEME}://nmtr`

protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "script-src 'self'; " +
  // Google Fonts: index.html / globals.css load the Inter font from there.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data: https://fonts.gstatic.com; " +
  // speed.cloudflare.com + aim.cloudflare.com: @cloudflare/speedtest runs in the
  // renderer (download/upload/latency, TURN creds, cdn-cgi/trace, AIM score log).
  "connect-src 'self' https://get.geojs.io https://api.macvendors.com https://api.github.com " +
  "https://speed.cloudflare.com https://aim.cloudflare.com; " +
  "object-src 'none'; " +
  "base-uri 'self'"

/** Serve out/renderer/** under app://nmtr/, with the CSP attached to every response. */
function registerAppProtocol(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url)
    const filePath = normalize(join(root, decodeURIComponent(pathname)))
    // Block path traversal out of the renderer directory.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      return new Response('Not found', { status: 404 })
    }
    const res = await net.fetch(pathToFileURL(filePath).toString())
    const headers = new Headers(res.headers)
    headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  })
}

function createWindow(): void {
  const settings = AppSettingsStore.get()
  const icon = createLogoIcon(32)

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 700,
    minWidth: 900,
    minHeight: 500,
    // Windows: frameless with our own min/max/close buttons in TitleBar.
    // macOS: keep the native traffic lights, inset into our 36px title bar.
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 12 } }
      : { frame: false, titleBarStyle: 'hidden' as const }),
    backgroundColor: '#1e1e24',
    icon,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, // required by electron-vite's externalizeDepsPlugin (preload needs require)
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Apply system theme preference
  if (settings.theme === 'system') {
    nativeTheme.themeSource = 'system'
  } else {
    nativeTheme.themeSource = settings.theme
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.maximize()
  })

  // Minimize to tray instead of closing. On macOS the window is always hidden
  // rather than destroyed (standard single-window Mac behaviour; the IPC
  // handlers, monitors and tray all hold this BrowserWindow). A real quit
  // (Cmd+Q / tray Quit) sets isQuitting first so it isn't swallowed here.
  mainWindow.on('close', (e) => {
    if (isQuitting) return
    const s = AppSettingsStore.get()
    if (isMac || (s.minimizeToTray && trayManager)) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // Never open child BrowserWindows: they would inherit our preload and expose
  // window.nmtrAPI to whatever site they load (e.g. the "Download nmap" link).
  // Send http(s) links to the system browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadURL(`${APP_ORIGIN}/index.html`)
  }
}

// Window control IPC (frameless window needs these)
ipcMain.on('window:minimize', () => mainWindow?.minimize())
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window:close', () => {
  const s = AppSettingsStore.get()
  if (s.minimizeToTray && trayManager) mainWindow?.hide()
  else mainWindow?.close()
})

app.whenReady().then(async () => {
  await ProberManager.initialize()

  // Production: serve the renderer from app://nmtr with a CSP (see APP_SCHEME).
  // Dev uses the Vite server, which needs inline scripts / websockets, so no CSP there.
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  if (!isDev) {
    registerAppProtocol()
    // Also attach the CSP to any http(s) document responses, as before.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CONTENT_SECURITY_POLICY]
        }
      })
    })
  }

  // Create window first so mainWindow is non-null when handlers are registered
  createWindow()

  const updater = new UpdateManager(mainWindow!)
  registerHandlers(mainWindow!, updater)
  void updater.init()

  const startupSettings = AppSettingsStore.get()

  // Sync the OS login-item registration with the saved preference.
  applyLaunchAtLogin(startupSettings.launchAtLogin)

  // Start scheduled monitors in the background (reads persisted configs).
  MonitorEngine.start(mainWindow!)

  trayManager = new TrayManager(mainWindow!)
  setTrayManager(trayManager)

  // macOS: clicking the Dock icon brings the (hidden) window back.
  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    ProberManager.destroyAll()
    MonitorEngine.stop()
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  ProberManager.destroyAll()
  MonitorEngine.stop()
})

export { mainWindow }
