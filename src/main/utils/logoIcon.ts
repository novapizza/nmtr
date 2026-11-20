import { app, nativeImage } from 'electron'
import { join } from 'path'

/**
 * Loads the nmtr logo as a NativeImage.
 *
 * The PNGs are rendered from resources/logo.svg by build/generateIcon.js.
 * Packaged builds ship them via electron-builder `extraResources`
 * (process.resourcesPath); in dev they are read from <repo>/resources.
 * `tray-icon.png` has @2x / @3x siblings that Electron picks up on HiDPI.
 */
function resourcePath(file: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, file)
    : join(app.getAppPath(), 'resources', file)
}

export function createLogoIcon(kind: 'window' | 'tray'): Electron.NativeImage {
  return nativeImage.createFromPath(resourcePath(kind === 'tray' ? 'tray-icon.png' : 'icon.png'))
}
