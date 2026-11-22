import { app, BrowserWindow, powerMonitor, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'

const isDev = !app.isPackaged

type Host = ReturnType<typeof registerIpc>
let host: Host | null = null

function createWindow(agentHost: Host): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Cairnode',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    backgroundColor: '#faf9f6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  win.on('ready-to-show', () => win.show())

  // A detached Bash group must not outlive the window that started it.
  win.on('closed', () => agentHost.abortAll('window_closed'))

  // Never let the app navigate itself away from the local renderer.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  // External links open in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

void app.whenReady().then(() => {
  host = registerIpc()

  // A suspended machine stops network reads; end the turn instead of letting
  // it look alive until the socket eventually times out.
  powerMonitor.on('suspend', () => host?.abortAll('suspend'))

  createWindow(host)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && host) createWindow(host)
  })
})

app.on('before-quit', () => host?.abortAll('quit'))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
