/**
 * 蓝韵音乐 - Electron 预加载脚本
 * 通过 contextBridge 安全暴露 API 给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron')

// 启动时同步预填 localStorage（消除"暂无歌曲"闪现）
;(function preloadFromDisk() {
  try {
    const _d = ipcRenderer.sendSync('get-preloaded-data')
    if (_d) {
      if (_d.songs && _d.songs.length) localStorage.setItem('bluerhythm_library', JSON.stringify(_d.songs))
      if (_d.theme) localStorage.setItem('bluerhythm_theme', _d.theme)
      if (_d.history && _d.history.length) localStorage.setItem('bluerhythm_history', JSON.stringify(_d.history))
      if (_d.playCounts && Object.keys(_d.playCounts).length > 0) localStorage.setItem('bluerhythm_play_counts', JSON.stringify(_d.playCounts))
      if (_d.lyricsCache && Object.keys(_d.lyricsCache).length > 0) localStorage.setItem('bluerhythm_lyrics_cache', JSON.stringify(_d.lyricsCache))
    }
  } catch (_) {}
})()

contextBridge.exposeInMainWorld('electronAPI', {
  // 文件扫描
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanFolder: (folderPath, parseMeta) => ipcRenderer.invoke('scan-folder', folderPath, parseMeta),
  scanFiles: (filePaths) => ipcRenderer.invoke('scan-files', filePaths),

  // 文件读取
  readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
  readLyricFile: (audioPath) => ipcRenderer.invoke('read-lyric-file', audioPath),

  // 元数据
  parseMetadata: (filePath) => ipcRenderer.invoke('parse-metadata', filePath),
  extractCover: (filePath) => ipcRenderer.invoke('extract-cover', filePath),

  // 存储
  storeGet: (key) => ipcRenderer.invoke('store-get', key),
  storeSet: (key, value) => ipcRenderer.invoke('store-set', key, value),
  storeDelete: (key) => ipcRenderer.invoke('store-delete', key),

  // 歌词
  selectLyricFile: () => ipcRenderer.invoke('select-lyric-file'),
  selectLyricFolder: () => ipcRenderer.invoke('select-lyric-folder'),
  scanLyricFolder: (folderPath) => ipcRenderer.invoke('scan-lyric-folder', folderPath),

  // 快速扫描
  getQuickScanPaths: () => ipcRenderer.invoke('get-quick-scan-paths'),
  getWindowsDrives: () => ipcRenderer.invoke('get-windows-drives'),

  // 开机自启
  setAutoLaunch: (enable) => ipcRenderer.invoke('set-auto-launch', enable),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),

  // 应用
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  openFileLocation: (filePath) => ipcRenderer.invoke('open-file-location', filePath),

  // 窗口控制
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // 歌单导入导出
  exportPlaylist: (name, data) => ipcRenderer.invoke('export-playlist', name, data),
  importPlaylist: () => ipcRenderer.invoke('import-playlist'),

  // 悬浮歌词
  toggleLyricWindow: () => ipcRenderer.send('lyric:toggle'),
  sendLyricUpdate: (data) => ipcRenderer.send('lyric:update', data),
  sendLyricIndex: (idx) => ipcRenderer.send('lyric:index', idx),

  // 数据同步（渲染进程主动保存到主进程磁盘）
  syncData: (data) => ipcRenderer.send('sync-data', data),

  // 修复歌曲时长
  fixDurations: (songs) => ipcRenderer.invoke('fix-durations', songs),

  // 事件监听（从主进程接收消息）
  // 渲染进程→主进程（单向）
  send: (channel, ...args) => {
    const validChannels = ['smtc:playback-state', 'sync-data', 'lyric:save-to-file', 'lyric:seek']
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, ...args)
    }
  },

  on: (channel, callback) => {
    const validChannels = ['menu-add-folder', 'menu-add-files', 'tray-command', 'smtc:thumbar-command', 'global-hotkey', 'durations-fixed']
    if (validChannels.includes(channel)) {
      const subscription = (_event, ...args) => callback(...args)
      ipcRenderer.on(channel, subscription)
      return () => ipcRenderer.removeListener(channel, subscription)
    }
  }
})
