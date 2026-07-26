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

// 特权 scheme 必须在 app ready 前注册,放模块顶层最不容易被挪错位置
registerAppSchemes()

// 冒烟测试/自动化联调用:DESIGNER_DEBUG_PORT=9223 pnpm dev 后可用 CDP 驱动。
// 不设该变量时完全无效果
if (process.env.DESIGNER_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DESIGNER_DEBUG_PORT)
}
import { registerIpc } from './ipc'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

function createWindow(): void {
  // 配置在主进程同步读得到，所以窗口尺寸和明暗在创建前就能定好，
  // 不会出现先按默认值画一帧再被渲染进程纠正的闪烁
  const config = readConfig()
  nativeTheme.themeSource = config.dark ? 'dark' : 'light'

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    show: false,
    autoHideMenuBar: true,
    // 毛玻璃。macOS 用 vibrancy，Windows 11 用 acrylic。
    // macOS 上窗口底色必须是全透明，否则不透明背景会把 vibrancy 整个盖住。
    ...(isMac
      ? {
          backgroundColor: '#00000000',
          vibrancy: 'under-window' as const,
          // 默认只在窗口激活时才有效果，失焦会变灰
          visualEffectState: 'active' as const
        }
      : {}),
    ...(isWindows ? { backgroundMaterial: 'acrylic' as const } : {}),
    // 去掉原生标题栏。macOS 保留左上角红绿灯，让它直接落在侧栏导轨上；
    // Windows / Linux 用系统自带的窗口控件覆盖层，两边都不用自己画按钮。
    titleBarStyle: 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#00000000', symbolColor: '#8c8c8c', height: 28 } }
      : // 三个按钮整体跨度约 58px（尺寸和间距由系统决定，改不了），
        // x=6 时右边缘到 64px，落在 68px 宽的导轨里还剩 4px 余量
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

  // 记住窗口尺寸。resize 触发很密，等窗口关闭时写一次就够
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

  // 打包后 Dock 图标来自 .app 包，但 dev 下跑的是 Electron 自己的壳，
  // 不显式设一下就一直是默认的 Electron 图标
  if (isMac && is.dev) app.dock?.setIcon(icon)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 首次调用会顺带初始化数据库并跑迁移；顺带清掉早期版本种下的预设行
  cleanupSeededProviders()
  // 上次异常退出遗留的 streaming 消息收尾成 error
  markStaleStreamingAsError()

  registerIpc()
  registerPreviewHandler()
  registerAssetHandler()
  // mode='local'(默认)时是 no-op;自建库同步引擎二期在这里点火
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

// WAL 模式下干净地关闭连接，才会把 -wal 文件合并回主库
app.on('before-quit', () => {
  closeDb()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
