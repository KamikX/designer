import { bindMainLanguage } from './i18n'
import { app, shell, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { patchConfig, readConfig } from './config'
import { closeDb } from './db'
import { cleanupSeededProviders } from './db/repo/provider'
import { markStaleStreamingAsError } from './db/repo/message'
import {
  registerAppSchemes,
  registerAssetHandler,
  registerPreviewHandler
} from './preview/protocol'
import { startSyncEngine } from './sync/engine'
import { resolveAppNavigation } from './navigation'

// Privileged schemes must be registered before app readiness; keep this at module scope.
bindMainLanguage(() => readConfig().lang)
registerAppSchemes()

// Allow CDP automation for smoke tests with DESIGNER_DEBUG_PORT=9223 pnpm dev.
// Remote debugging stays disabled unless the variable is set.
if (process.env.DESIGNER_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DESIGNER_DEBUG_PORT)
}
import { registerIpc } from './ipc'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

function createWindow(): void {
  // Read settings synchronously before window creation to avoid a flash of default
  // dimensions or theme before the renderer applies the saved preferences.
  const config = readConfig()
  nativeTheme.themeSource = config.dark ? 'dark' : 'light'

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    show: false,
    autoHideMenuBar: true,
    // Use native translucency: vibrancy on macOS and acrylic on Windows 11.
    // macOS requires a fully transparent background so it does not cover the vibrancy.
    ...(isMac
      ? {
          backgroundColor: '#00000000',
          vibrancy: 'under-window' as const,
          // Keep vibrancy active because the default turns gray when focus is lost.
          visualEffectState: 'active' as const
        }
      : {}),
    ...(isWindows ? { backgroundMaterial: 'acrylic' as const } : {}),
    // Hide the native title bar while keeping macOS traffic lights on the sidebar rail.
    // Windows / Linux use native control overlays to avoid drawing custom buttons.
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#00000000', symbolColor: '#8c8c8c', height: 28 } }
      : // The three buttons span about 58px, with system-controlled sizing and spacing.
        // At x=6, their right edge is at 64px, leaving 4px within the 68px sidebar rail.
        { trafficLightPosition: { x: 6, y: 12 } }),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Persist dimensions on close to avoid writing on every frequent resize event.
  mainWindow.on('close', () => {
    const [width, height] = mainWindow.getSize()
    patchConfig({ window: { width, height } })
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const navigation = resolveAppNavigation(url, mainWindow.webContents.getURL())
    if (navigation.kind === 'internal') return
    event.preventDefault()
    if (navigation.kind === 'external' && navigation.url) {
      void shell.openExternal(navigation.url)
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const navigation = resolveAppNavigation(url, mainWindow.webContents.getURL())
    if (navigation.kind === 'external' && navigation.url) {
      void shell.openExternal(navigation.url)
    }
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Packaged apps get their Dock icon from the .app bundle; development uses
  // Electron's shell and needs an explicit icon to replace the default.
  if (isMac && is.dev) app.dock?.setIcon(icon)

  // The toolkit forces undocked DevTools, so development shortcuts need a docked handler.
  app.on('browser-window-created', (_, window) => {
    if (!is.dev) {
      optimizer.watchWindowShortcuts(window)
      return
    }

    const { webContents } = window
    webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (
        input.code === 'F12' ||
        (input.code === 'KeyI' && ((input.alt && input.meta) || (input.control && input.shift)))
      ) {
        event.preventDefault()
        if (webContents.isDevToolsOpened()) webContents.closeDevTools()
        else webContents.openDevTools({ mode: 'bottom' })
      }
      if (
        (input.control || input.meta) &&
        (input.code === 'Minus' || (input.code === 'Equal' && input.shift))
      ) {
        event.preventDefault()
      }
    })
  })

  // The first database access also runs migrations; remove presets seeded by older versions.
  cleanupSeededProviders()
  // Mark interrupted streams as errors so a previous crash does not leave them running.
  markStaleStreamingAsError()

  registerIpc()
  registerPreviewHandler()
  registerAssetHandler()
  // Local mode (the default) is a no-op; self-hosted database mode needs the sync engine.
  startSyncEngine()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Close the connection cleanly so WAL data is checkpointed into the main database.
app.on('will-quit', () => {
  closeDb()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
