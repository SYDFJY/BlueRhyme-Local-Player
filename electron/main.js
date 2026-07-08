/**
 * 蓝韵音乐 - Electron 主进程
 * 当通过 electron . 运行时，内置 electron 模块可用
 */

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, Tray, nativeImage, globalShortcut, protocol, net } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')
const { readdir, stat, readFile, writeFile, mkdir } = require('fs/promises')
const os = require('os')

// ========== 元数据降级解析 ==========
const COVER_NAMES = ['cover.jpg','cover.png','folder.jpg','folder.png','Cover.jpg','Cover.png','Front.jpg','front.png']

function findCoverInDir(filePath) {
  const dir = path.dirname(filePath)
  for (const name of COVER_NAMES) {
    const fp = path.join(dir, name)
    try { if (fs.existsSync(fp)) return `file:///${fp.replace(/\\/g, '/')}` } catch {}
  }
  try {
    const files = fs.readdirSync(dir)
    for (const f of files) {
      const lower = f.toLowerCase()
      if (lower.endsWith('.jpg')||lower.endsWith('.jpeg')||lower.endsWith('.png')) {
        try {
          const full = path.join(dir, f), picData = fs.readFileSync(full)
          const mime = path.extname(f).toLowerCase().replace('.','') === 'png' ? 'image/png' : 'image/jpeg'
          return `data:${mime};base64,${picData.toString('base64')}`
        } catch {}
      }
    }
  } catch {}
  return null
}

/**
 * 读取音频文件时长（秒）
 * 策略：music-metadata 读文件自带元数据 → ffprobe 兜底
 * 音乐文件内部都存储了精确时长，不需要自己估算
 */
async function getAudioDuration(filePath) {
  // 方案1: music-metadata — 直接读文件元数据中的时长
  if (parseFile) {
    try {
      const m = await parseFile(filePath, { duration: true, skipCovers: true })
      if (m.format.duration && m.format.duration > 0) return Math.round(m.format.duration)
    } catch {}
  }
  // 方案2: ffprobe
  if (ffprobePath) {
    const dur = await getFFprobeDuration(filePath)
    if (dur > 0) return dur
  }
  return 0
}

// ========== 存储 ==========
let storageData = {}
let storagePath

function initStorage() {
  try { storagePath = path.join(app.getPath('userData'), 'bluerhythm-data.json') } catch (_) { storagePath = path.join(__dirname, '../data.json') }
  try { if (fs.existsSync(storagePath)) storageData = JSON.parse(fs.readFileSync(storagePath, 'utf8')) } catch (_) {}
}

function saveStorage() {
  try { fs.writeFileSync(storagePath, JSON.stringify(storageData, null, 2)) } catch (e) { console.error(e) }
}

// ========== ffprobe 时长获取 (最准确, 优先使用) ==========
const { execFile } = require('child_process')
let ffprobePath = null

;(function detectFFprobe() {
  const diagLines = []
  const candidates = []
  try {
    const exeDir = path.dirname(process.execPath)
    candidates.push(path.join(exeDir, 'ffprobe.exe'))
  } catch {}
  try {
    // 应用安装目录
    candidates.push(path.join(app.getAppPath(), '..', '..', 'ffprobe.exe'))
    // resources 同级
    candidates.push(path.join(app.getAppPath(), '..', 'ffprobe.exe'))
    // userData
    candidates.push(path.join(app.getPath('userData'), 'ffprobe.exe'))
    // 当前目录
    candidates.push(path.join(__dirname, '..', 'ffprobe.exe'))
    // ffmpeg 附加包常见路径
    const localAppData = process.env.LOCALAPPDATA || ''
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-8.1.1-full_build', 'bin', 'ffprobe.exe'))
    }
  } catch {}

  for (const candidate of candidates) {
    try {
      diagLines.push(`ffprobe 检测: "${candidate}" exists=${fs.existsSync(candidate)}`)
      if (fs.existsSync(candidate)) {
        ffprobePath = candidate
        diagLines.push('ffprobe 已就绪 ✓')
        break
      }
    } catch (e) { diagLines.push('ffprobe 检测异常: ' + e.message) }
  }

  if (!ffprobePath) {
    // 最后尝试 PATH 环境变量
    try {
      const { execFileSync } = require('child_process')
      execFileSync('ffprobe', ['-version'], { timeout: 3000, windowsHide: true })
      ffprobePath = 'ffprobe' // 在 PATH 中
      diagLines.push('ffprobe 在 PATH 中可用 ✓')
    } catch {}
  }

  try {
    const diagDir = path.join(app.getPath('userData'))
    fs.mkdirSync(diagDir, { recursive: true })
    fs.writeFileSync(path.join(diagDir, 'scan_diag.log'), '[' + new Date().toISOString() + '] ' + diagLines.join('\n[' + new Date().toISOString() + '] ') + '\n')
  } catch (_) {}
})()

function getFFprobeDuration(filePath) {
  return new Promise((resolve) => {
    if (!ffprobePath) return resolve(0)
    execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], {
      timeout: 15000, windowsHide: true, encoding: 'utf8'
    }, (err, stdout) => {
      if (err) return resolve(0)
      const dur = parseFloat((stdout || '').trim())
      resolve(Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 0)
    })
  })
}

// ========== music-metadata (可选) ==========
let parseFile = null
async function ensureParseFile() {
  if (parseFile) return
  try {
    const mm = await import('music-metadata')
    parseFile = mm.parseFile
    console.log('[main] music-metadata 加载成功')
  } catch (e) {
    console.error('[main] music-metadata 加载失败:', e.message)
  }
}

const AUDIO_EXTS = new Set(['.mp3','.flac','.wav','.ape','.m4a','.ogg','.wma','.aac','.aiff','.alac','.opus','.wv'])

// ========== 文件名解析 ==========
const FILENAME_SEPARATORS = [' -- ', ' - ', ' – ', ' — ', ' ~ ', ' · ', '--', '-', '–', '—', '~', '·']
function parseFilename(filename) {
  const lastDot = filename.lastIndexOf('.')
  const name = lastDot > 0 ? filename.substring(0, lastDot) : filename
  for (const sep of FILENAME_SEPARATORS) {
    const idx = name.indexOf(sep)
    if (idx > 0) {
      return {
        title: name.substring(0, idx).trim() || name.trim(),
        artist: name.substring(idx + sep.length).trim() || '未知艺术家'
      }
    }
  }
  return { title: name.trim(), artist: '未知艺术家' }
}

// ========== 菜单 ==========
const menuTemplate = [
  {
    label: '文件',
    submenu: [
      {
        label: '添加文件夹',
        accelerator: 'CmdOrCtrl+O',
        click: async () => {
          const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择音乐文件夹' })
          if (!r.canceled && r.filePaths[0] && mainWindow) {
            mainWindow.webContents.send('menu-add-folder', r.filePaths[0])
          }
        }
      },
      { type: 'separator' },
      {
        label: '添加文件',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: async () => {
          const r = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile', 'multiSelections'],
            title: '选择音乐文件',
            filters: [{ name: '音频文件', extensions: ['mp3','flac','wav','ape','m4a','ogg','wma','aac','aiff','alac','opus','wv'] }]
          })
          if (!r.canceled && r.filePaths.length > 0 && mainWindow) {
            mainWindow.webContents.send('menu-add-files', r.filePaths)
          }
        }
      },
      { type: 'separator' },
      { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
    ]
  },
  {
    label: '编辑',
    submenu: [
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
      { label: '重做', accelerator: 'Shift+CmdOrCtrl+Z', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
      { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
      { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
      { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
    ]
  },
  {
    label: '视图',
    submenu: [
      { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
      { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
      { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
      { type: 'separator' },
      { label: '放大', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
      { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
      { label: '重置缩放', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
      { type: 'separator' },
      { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' }
    ]
  },
  {
    label: '帮助',
    submenu: [
      {
        label: '关于蓝韵音乐',
        click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: '关于蓝韵音乐',
            message: '蓝韵音乐',
            detail: '版本 1.0.0\n一款简洁优雅的本地音乐播放器\n\n技术栈：Electron + Vue 3 + TypeScript'
          })
        }
      }
    ]
  }
]

// macOS 需要在最前面加上应用名菜单
if (process.platform === 'darwin') {
  menuTemplate.unshift({
    label: app.getName(),
    submenu: [
      { label: '关于蓝韵音乐', role: 'about' },
      { type: 'separator' },
      { label: '服务', role: 'services' },
      { type: 'separator' },
      { label: '隐藏', role: 'hide' },
      { label: '隐藏其他', role: 'hideOthers' },
      { label: '全部显示', role: 'unhide' },
      { type: 'separator' },
      { label: '退出', role: 'quit' }
    ]
  })
}

// ========== 窗口 ==========
let mainWindow = null

function createWindow() {
  // 设置中文菜单
  const menu = Menu.buildFromTemplate(menuTemplate)
  Menu.setApplicationMenu(menu)

  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 900, minHeight: 600,
    title: '蓝韵音乐',
    backgroundColor: '#f5f7fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false  // 防止最小化时 SMTC / MediaSession 被节流
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })


  // 修复最小化后任务栏预览渲染不全
  // Electron + DWM 问题：最小化后 Chromium 停止渲染，DWM 快照不完整
  // 方案：最小化后闪烁窗口 opacity，强制 DWM 刷新快照
  let _snapshotTimer = null
  mainWindow.on('minimize', () => {
    clearTimeout(_snapshotTimer)
    // 延迟确保窗口已完全最小化
    _snapshotTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      // 关键：通过修改透明度触发 DWM 重新捕获画面
      mainWindow.setOpacity(0.97)
      mainWindow.webContents.invalidate()
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setOpacity(1.0)
          mainWindow.webContents.invalidate()
        }
      }, 80)
      // 第二次确保（部分系统 DWM 缓存策略不同）
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized()) {
          mainWindow.setOpacity(0.98)
          mainWindow.webContents.invalidate()
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.setOpacity(1.0)
            }
          }, 50)
        }
      }, 300)
    }, 150)
  })

  // 恢复窗口
  mainWindow.on('restore', () => {
    clearTimeout(_snapshotTimer)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(1.0)
      mainWindow.webContents.invalidate()
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    // 使用 app:// 自定义安全协议而非 file://，以便 Chromium SMTC 注册
    mainWindow.loadURL('app://index.html')
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

let tray = null

// ========== 任务栏缩略图按钮（Thumbar） ==========
function updateThumbarButtons(state) {
  if (!mainWindow) return
  const btnPlayPause = {
    icon: nativeImage.createFromDataURL(
      state === 'playing'
        ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANklEQVQ4T2NkYPj/n4EBBJgYKAQMVAXUp+IfdYF+MQN1AdUDCADFQCj+B1IKxQLqBgDdPilZZHyFkwAAAABJRU5ErkJggg=='
        : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBBJgYKAQMVAXUp+IfdYF+MQN1AdUDCADFQCj+B1IKxQLqBgDdPilZZHyFkwAAAABJRU5ErkJggg=='
    ).resize({ width: 16, height: 16 }),
    click: () => mainWindow.webContents.send('smtc:thumbar-command', 'toggle-play'),
    tooltip: state === 'playing' ? '暂停' : '播放',
    flags: 0
  }
  const btnPrev = {
    icon: nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBBJgYKAQMVAXUp+IfdYF+MQN1AdUDCADFQCj+B1IKxQLqBgDdPilZZHyFkwAAAABJRU5ErkJggg=='
    ).resize({ width: 16, height: 16 }),
    click: () => mainWindow.webContents.send('smtc:thumbar-command', 'prev'),
    tooltip: '上一首',
    flags: 0
  }
  const btnNext = {
    icon: nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2RkYPj/n4EBBJgYKAQMVAXUp+IfdYF+MQN1AdUDCADFQCj+B1IKxQLqBgDdPilZZHyFkwAAAABJRU5ErkJggg=='
    ).resize({ width: 16, height: 16 }),
    click: () => mainWindow.webContents.send('smtc:thumbar-command', 'next'),
    tooltip: '下一首',
    flags: 0
  }
  try { mainWindow.setThumbarButtons([btnPrev, btnPlayPause, btnNext]) } catch {}
}

function createTray() {
  // Create a simple 16x16 tray icon
  const iconSize = 16
  const icon = nativeImage.createEmpty()
  try {
    // Try loading a custom icon, fall back to empty
    const iconPath = path.join(__dirname, '../dist/favicon.ico')
    if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath)
    }
  } catch {}
  if (!tray) {
    // Create with empty data URL icon
    tray = new Tray(nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBBJgYKAQMVAXUp+IfdYF+MQN1AdUDCADFQCj+B1IKxQLqBgDdPilZZHyFkwAAAABJRU5ErkJggg=='
    ))
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) mainWindow.show() } },
    { type: 'separator' },
    { label: '播放/暂停', click: () => { if (mainWindow) mainWindow.webContents.send('tray-command', 'toggle-play') } },
    { label: '上一曲', click: () => { if (mainWindow) mainWindow.webContents.send('tray-command', 'prev') } },
    { label: '下一曲', click: () => { if (mainWindow) mainWindow.webContents.send('tray-command', 'next') } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit() } }
  ])

  tray.setToolTip('蓝韵音乐')
  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
    }
  })
}

/**
 * 媒体键策略：纯 SMTC 原生路径
 *
 * 不注册 globalShortcut 的原因：
 *   Electron globalShortcut 会抢占 Windows SMTC 事件管道，
 *   导致系统媒体控件（Win+G、锁屏、音量浮层）无法检测到播放器，
 *   歌曲信息和封面也不显示。
 *
 * 防跳应用方案：
 *   1. 播放时每 2 秒更新 setPositionState → 保持活跃
 *   2. AudioContext 占位 → 暂停时不丢失 SMTC 注册
 *   3. metadata + playbackState 始终同步 → Windows 优先选择活跃会话
 *
 * 如果还是跳到抖音：
 *   在 Windows 设置 → 蓝牙和其他设备 → 媒体键
 *   关闭"允许应用控制此设备"可彻底解决多应用竞争
 */

// ========== 全局快捷键（不干扰 SMTC） ==========
// 避免注册 MediaPlayPause / MediaNextTrack / MediaPreviousTrack
// 这些留给 Chromium SMTC 原生处理，注册它们会干掉系统媒体控件
const GLOBAL_KEYS = {
  'Ctrl+Alt+Left':  'prev',
  'Ctrl+Alt+Right': 'next',
  'Ctrl+Alt+Space': 'toggle-play',
  'Ctrl+Alt+Up':    'volume-up',
  'Ctrl+Alt+Down':  'volume-down',
}

let globalShortcutsRegistered = false

function registerGlobalShortcuts() {
  if (globalShortcutsRegistered) return
  try {
    for (const [key, cmd] of Object.entries(GLOBAL_KEYS)) {
      globalShortcut.register(key, () => {
        if (mainWindow) {
          mainWindow.webContents.send('global-hotkey', cmd)
        }
      })
    }
    globalShortcutsRegistered = true
    console.log('[main] 全局快捷键已注册:', Object.keys(GLOBAL_KEYS).join(', '))
  } catch (e) {
    console.warn('[main] 全局快捷键注册失败:', e.message)
  }
}

function unregisterGlobalShortcuts() {
  if (globalShortcutsRegistered) {
    globalShortcut.unregisterAll()
    globalShortcutsRegistered = false
  }
}

// ========== 桌面悬浮歌词窗口 ==========
let lyricWindow = null

function createLyricWindow() {
  if (lyricWindow && !lyricWindow.isDestroyed()) { lyricWindow.show(); return }
  lyricWindow = new BrowserWindow({
    width: 400, height: 300,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    }
  })
  lyricWindow.loadFile(path.join(__dirname, 'lyric-window.html'))
  lyricWindow.on('closed', () => { lyricWindow = null })
}

ipcMain.on('lyric:toggle', () => {
  if (lyricWindow && !lyricWindow.isDestroyed() && lyricWindow.isVisible()) {
    lyricWindow.hide()
  } else {
    createLyricWindow()
  }
})

ipcMain.on('lyric:update', (_e, data) => {
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.webContents.send('lyric:update', data)
  }
})

ipcMain.on('lyric:index', (_e, idx) => {
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.webContents.send('lyric:index', idx)
  }
})

ipcMain.on('lyric:save-to-file', async (_e, content) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '保存歌词',
    defaultPath: 'lyrics.lrc',
    filters: [{ name: 'LRC 歌词文件', extensions: ['lrc'] }, { name: '文本文件', extensions: ['txt'] }]
  })
  if (!r.canceled && r.filePath) {
    try { await writeFile(r.filePath, content, 'utf-8') } catch {}
  }
})

ipcMain.on('lyric:seek', (_e, time) => {
  if (mainWindow) mainWindow.webContents.send('lyric:seek', time)
})

// 注册自定义 app:// 协议为安全上下文
// file:// 页面不会触发 Chromium SMTC 桥接（SystemMediaControlsWin），
// 必须用自定义 secure 协议才能让 Windows 识别媒体会话。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,           // Chromium 视为安全上下文 → SMTC 激活
      supportFetchAPI: true,  // Vue SPA fetch 请求
      bypassCSP: false
    }
  }
])

// 设置 Windows 通知栏 App ID（通知图标 + 分组用）
app.setAppUserModelId('com.bluerhythm.music')

// ========== MIME 类型映射 ==========
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
}

function getMime(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

app.whenReady().then(async () => {
  // 处理 app:// 协议 → 映射到 dist/ 目录文件
  // 使用 fs.readFileSync 替代 net.fetch：net.fetch 走 Chromium 网络栈，
  // 对 ASAR 存档内文件路径解析不可靠，可能导致 CSS/JS 加载失败。
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    let filePath = path.join(__dirname, '../dist', url.pathname === '/' ? 'index.html' : url.pathname)
    // SPA 路由 fallback：非文件路径或无扩展名 → 返回 index.html
    if (!fs.existsSync(filePath) || !path.extname(filePath)) {
      filePath = path.join(__dirname, '../dist', 'index.html')
    }
    try {
      const data = fs.readFileSync(filePath)
      return new Response(data, { headers: { 'content-type': getMime(filePath) } })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })

  initStorage(); await ensureParseFile(); createWindow(); createTray(); registerGlobalShortcuts()

  // 后台自动修复所有歌曲时长（不阻塞启动）
  setTimeout(async () => {
    const songs = storageData['library_songs']
    if (!Array.isArray(songs) || songs.length === 0) return
    let fixed = 0
    for (const song of songs) {
      if (!song.path || !fs.existsSync(song.path)) continue
      try {
        const newDur = await getAudioDuration(song.path)
        if (newDur > 0 && newDur !== song.duration) {
          song.duration = newDur
          fixed++
        }
      } catch {}
    }
    if (fixed > 0) {
      console.log(`[autoFix] 启动时修复了 ${fixed}/${songs.length} 首歌曲时长`)
      storageData['library_songs'] = songs
      saveStorage()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('durations-fixed', songs)
      }
    }
  }, 2000)
})
app.on('window-all-closed', () => {
  // Don't quit if tray exists (Windows)
  if (process.platform !== 'darwin' && tray) {
    // Keep running in tray
  } else {
    app.quit()
  }
})
app.on('activate', () => { if (!mainWindow) createWindow() })
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

// ========== IPC ==========

ipcMain.handle('select-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择音乐文件夹' })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('scan-folder', async (_e, dirPath, parseMeta = true) => {
  const songs = []
  const coverDir = path.join(app.getPath('userData'), 'covers')
  async function walk(dir) {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (!e.name.startsWith('.')) await walk(full) }
      else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!AUDIO_EXTS.has(ext)) continue
        try {
          const st = await stat(full)
          const parsed = parseFilename(e.name)
          let title = parsed.title, artist = parsed.artist, album = '未知专辑', duration = 0, hasCover = false, coverUrl = ''
          // 读文件自带元数据中的时长
          duration = await getAudioDuration(full)
          if (parseMeta && parseFile) {
            try {
              const m = await parseFile(full, { duration: false, skipCovers: false })
              title = m.common.title || title; artist = m.common.artist || artist
              album = m.common.album || album
              if (m.common.picture?.[0]) {
                hasCover = true
                const pic = m.common.picture[0]
                const fmt = (pic.format?.split('/')[1]) || 'jpg'
                await mkdir(coverDir, { recursive: true })
                const hash = Math.abs(full.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0))
                const dest = path.join(coverDir, `cover_${hash}.${fmt}`)
                await writeFile(dest, pic.data)
                const mime = fmt === 'png' ? 'image/png' : 'image/jpeg'
                coverUrl = `data:${mime};base64,${Buffer.from(pic.data).toString('base64')}`
              }
            } catch (e) {
              console.error('[main] 元数据解析失败:', full, e.message)
              // 降级：从目录找封面
              if (!coverUrl) {
                const found = findCoverInDir(full)
                if (found) { hasCover = true; coverUrl = found }
              }
            }
          } else {
            // 没有 music-metadata 时也尝试目录封面
            const found = findCoverInDir(full)
            if (found) { hasCover = true; coverUrl = found }
          }
          songs.push({ path: full, name: e.name, title, artist, album, duration, format: ext.replace('.','').toUpperCase(), size: st.size, hasCover, coverUrl: coverUrl || undefined })
        } catch (e) { console.error('[main] 文件扫描失败:', e.message) }
      }
    }
  }
  await walk(dirPath)
  storageData['last_folder'] = dirPath
  saveStorage()
  return songs
})

ipcMain.handle('scan-files', async (_e, filePaths) => {
  const songs = []
  const coverDir = path.join(app.getPath('userData'), 'covers')
  for (const fp of filePaths) {
    const name = path.basename(fp)
    const ext = path.extname(name).toLowerCase()
    if (!AUDIO_EXTS.has(ext)) continue
    try {
      const st = await stat(fp)
      const parsed = parseFilename(name)
      let title = parsed.title, artist = parsed.artist, album = '未知专辑', duration = 0, hasCover = false, coverUrl = ''
      // 读文件自带元数据中的时长
      duration = await getAudioDuration(fp)
      if (parseFile) {
        try {
          const m = await parseFile(fp, { duration: false, skipCovers: false })
          title = m.common.title || title; artist = m.common.artist || artist
          album = m.common.album || album
          if (m.common.picture?.[0]) {
            hasCover = true
            const pic = m.common.picture[0]
            const fmt = (pic.format?.split('/')[1]) || 'jpg'
            await mkdir(coverDir, { recursive: true })
            const hash = Math.abs(fp.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0))
            const dest = path.join(coverDir, `cover_${hash}.${fmt}`)
            await writeFile(dest, pic.data)
            const mime = fmt === 'png' ? 'image/png' : 'image/jpeg'
            coverUrl = `data:${mime};base64,${Buffer.from(pic.data).toString('base64')}`
          }
        } catch (e) {
            console.error('[main] 元数据解析失败:', fp, e.message)
            if (!coverUrl) { const found = findCoverInDir(fp); if (found) { hasCover = true; coverUrl = found } }
          }
        } else {
          const found = findCoverInDir(fp); if (found) { hasCover = true; coverUrl = found }
        }
      songs.push({ path: fp, name, title, artist, album, duration, format: ext.replace('.','').toUpperCase(), size: st.size, hasCover, coverUrl: coverUrl || undefined })
    } catch (e) { console.error('[main] 文件扫描失败:', e.message) }
  }
  return songs
})

ipcMain.handle('parse-metadata', async (_e, filePath) => {
  try {
    const duration = await getAudioDuration(filePath)
    if (!parseFile) return { duration }
    const m = await parseFile(filePath, { duration: false, skipCovers: false })
    let cover = ''
    if (m.common.picture?.[0]) {
      cover = `data:${m.common.picture[0].format || 'image/jpeg'};base64,${Buffer.from(m.common.picture[0].data).toString('base64')}`
    }
    return { title: m.common.title || '', artist: m.common.artist || '', album: m.common.album || '', year: m.common.year || '', genre: [m.common.genre].flat().join(', '), track: m.common.track?.no || 0, duration, bitrate: m.format.bitrate || 0, sampleRate: m.format.sampleRate || 0, coverBase64: cover }
  } catch (e) { console.error('[main] parse-metadata 失败:', e.message); return null }
})

ipcMain.handle('extract-cover', async (_e, filePath) => {
  if (!parseFile) return null
  try {
    const m = await parseFile(filePath, { skipCovers: false })
    if (m.common.picture?.[0]) {
      const pic = m.common.picture[0]
      const fmt = (pic.format?.split('/')[1]) || 'jpg'
      const dir = path.join(app.getPath('userData'), 'covers')
      await mkdir(dir, { recursive: true })
      const hash = Math.abs(filePath.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0))
      const dest = path.join(dir, `cover_${hash}.${fmt}`)
      await writeFile(dest, pic.data)
      const mime = fmt === 'png' ? 'image/png' : 'image/jpeg'
      return `data:${mime};base64,${Buffer.from(pic.data).toString('base64')}`
    }
  } catch (e) { console.error('[main] extract-cover 失败:', e.message) }
  return null
})

ipcMain.handle('read-file-buffer', async (_e, filePath) => {
  try { const b = await readFile(filePath); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } catch { return null }
})

ipcMain.handle('read-lyric-file', async (_e, audioPath) => {
  const dir = path.dirname(audioPath)
  const base = path.basename(audioPath, path.extname(audioPath))
  try { return await readFile(path.join(dir, base + '.lrc'), 'utf-8') } catch { return null }
})

ipcMain.handle('store-get', (_e, key) => storageData[key])
ipcMain.handle('store-set', (_e, key, value) => { storageData[key] = value; saveStorage() })
ipcMain.handle('store-delete', (_e, key) => { delete storageData[key]; saveStorage() })
ipcMain.handle('get-app-path', () => app.getAppPath())

// Open file location in Explorer
ipcMain.handle('open-file-location', async (_e, filePath) => {
  try {
    shell.showItemInFolder(filePath)
    return true
  } catch { return false }
})

// ========== Playlist Import/Export ==========
ipcMain.handle('export-playlist', async (_e, playlistName, playlistData) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '导出歌单',
    defaultPath: `${playlistName}.json`,
    filters: [{ name: 'JSON 文件', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePath) return false
  try {
    await writeFile(r.filePath, playlistData, 'utf-8')
    return true
  } catch (e) {
    console.error('[main] 导出歌单失败:', e.message)
    return false
  }
})

ipcMain.handle('import-playlist', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '导入歌单',
    filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths[0]) return null
  try {
    const content = await readFile(r.filePaths[0], 'utf-8')
    return content
  } catch (e) {
    console.error('[main] 导入歌单失败:', e.message)
    return null
  }
})

// ========== SMTC Thumbar + 播放状态 IPC ==========
ipcMain.on('smtc:playback-state', (_e, state) => {
  updateThumbarButtons(state)
})

ipcMain.on('smtc:thumbar-command', (_e, cmd) => {
  // Thumbar 按钮点击直接转发到渲染进程，由 MediaSession handler 处理
  if (mainWindow) mainWindow.webContents.send('smtc:thumbar-command', cmd)
})

// ========== 快速扫描全盘 ==========
const COMMON_MUSIC_DIRS = ['Music', 'Desktop', 'Downloads', 'Documents', '音乐']

ipcMain.handle('get-quick-scan-paths', () => {
  const paths = []
  const home = os.homedir()
  // 常用用户目录
  for (const dir of COMMON_MUSIC_DIRS) {
    const p = path.join(home, dir)
    if (fs.existsSync(p)) paths.push(p)
  }
  // 所有根目录盘符（跳过系统保留分区）
  for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\'
    try {
      if (fs.existsSync(root)) {
        const info = fs.statSync(root)
        if (info.isDirectory()) paths.push(root)
      }
    } catch {}
  }
  return paths
})

ipcMain.handle('get-windows-drives', () => {
  const drives = []
  const home = os.homedir()
  // 先加常用目录
  for (const dir of ['Music', 'Desktop', 'Downloads', '音乐']) {
    const p = path.join(home, dir)
    if (fs.existsSync(p)) drives.push(p)
  }
  // 所有盘符
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\'
    try { if (fs.existsSync(root)) drives.push(root) } catch {}
  }
  return drives
})

// ========== 开机自启 ==========
ipcMain.handle('set-auto-launch', (_e, enable) => {
  app.setLoginItemSettings({
    openAtLogin: enable,
    path: app.getPath('exe'),
  })
})

ipcMain.handle('get-auto-launch', () => {
  return app.getLoginItemSettings().openAtLogin
})

// ========== 导入歌词 ==========
ipcMain.handle('select-lyric-file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择歌词文件',
    filters: [{ name: '歌词文件', extensions: ['lrc', 'txt'] }],
    properties: ['openFile']
  })
  if (r.canceled || !r.filePaths[0]) return null
  try {
    return await readFile(r.filePaths[0], 'utf-8')
  } catch { return null }
})

// ========== 选择歌词文件夹 ==========
ipcMain.handle('select-lyric-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择歌词文件夹'
  })
  if (r.canceled || !r.filePaths[0]) return null
  return r.filePaths[0]
})

// ========== 扫描歌词文件夹 ==========
// ========== 修复歌曲时长 ==========
ipcMain.handle('fix-durations', async (_e, songs) => {
  if (!Array.isArray(songs)) return songs
  let fixed = 0
  for (const song of songs) {
    if (!song.path) continue
    try {
      // 检查文件是否还存在
      if (!fs.existsSync(song.path)) continue
      const newDur = await getAudioDuration(song.path)
      if (newDur > 0 && Math.abs(newDur - (song.duration || 0)) > 1) {
        song.duration = newDur
        fixed++
      }
    } catch {}
  }
  // 保存修复后的歌曲列表到存储
  if (fixed > 0) {
    storageData['library_songs'] = songs
    saveStorage()
  }
  return { songs, fixed }
})

ipcMain.handle('scan-lyric-folder', async (_e, folderPath) => {
  // 如果没传路径，使用存储的路径
  const lyricDir = folderPath || storageData['lyric_folder']
  if (!lyricDir) return { lyrics: [], folderPath: null }

  const lyrics = []
  const LRC_EXTS = new Set(['.lrc', '.txt'])

  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') await walk(full)
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase()
        if (!LRC_EXTS.has(ext)) continue
        try {
          const content = await readFile(full, 'utf-8')
          // 简单验证是否包含 LRC 时间标签
          if (content && (content.match(/\[\d{1,2}:\d{2}/) || ext === '.txt')) {
            lyrics.push({ name: e.name, path: full, content })
          }
        } catch {}
      }
    }
  }

  await walk(lyricDir)

  // 保存歌词文件夹路径
  storageData['lyric_folder'] = lyricDir
  saveStorage()

  return { lyrics, folderPath: lyricDir }
})

// ========== 启动时预加载数据 ==========
ipcMain.on('get-preloaded-data', (event) => {
  const result = {
    songs: storageData['library_songs'] || [],
    theme: storageData['theme'] || '',
    history: storageData['play_history'] || [],
    playCounts: storageData['play_counts'] || {},
    lyricsCache: storageData['lyrics_cache'] || {},
    lyricFolder: storageData['lyric_folder'] || '',
    playlists: storageData['playlists'] || [],
    favorites: storageData['favorites'] || [],
    volume: storageData['volume'] ?? 1,
    playMode: storageData['play_mode'] || 'list',
    lastFolder: storageData['last_folder'] || '',
  }
  event.returnValue = result
})

// ========== 悬浮歌词窗口 IPC ==========
ipcMain.on('lyric:close', () => {
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.close()
  }
})

ipcMain.on('lyric:click-through', (_e, enable) => {
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.setIgnoreMouseEvents(enable, { forward: true })
  }
})

// ========== 数据同步（渲染进程主动保存） ==========
ipcMain.on('sync-data', (_e, data) => {
  if (data.songs) storageData['library_songs'] = data.songs
  if (data.history) storageData['play_history'] = data.history
  if (data.playCounts) storageData['play_counts'] = data.playCounts
  if (data.lyricsCache) storageData['lyrics_cache'] = data.lyricsCache
  if (data.playlists) storageData['playlists'] = data.playlists
  if (data.favorites) storageData['favorites'] = data.favorites
  if (data.theme) storageData['theme'] = data.theme
  if (data.volume !== undefined) storageData['volume'] = data.volume
  if (data.playMode) storageData['play_mode'] = data.playMode
  saveStorage()
})

// ========== Window Controls ==========
ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.minimize() })
ipcMain.handle('maximize-window', () => {
  if (mainWindow) {
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
  }
})
ipcMain.handle('close-window', () => {
  if (mainWindow) {
    // Minimize to tray instead of closing
    mainWindow.hide()
  }
})
