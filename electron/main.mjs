/**
 * 蓝韵音乐 - Electron 主进程 (ESM 版本)
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ============ music-metadata (可选) ============
let parseFile = null;
try {
  const mm = require('music-metadata');
  parseFile = mm.parseFile;
} catch (e) {
  console.warn('music-metadata 未安装，使用基础文件名解析');
}

// ============ 简单的 JSON 存储 ============
const storagePath = path.join(app.getPath('userData'), 'bluerhythm-data.json');
let storageData = {};
try {
  if (fs.existsSync(storagePath)) {
    storageData = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  }
} catch (e) { storageData = {}; }

function saveStorage() {
  try {
    fs.writeFileSync(storagePath, JSON.stringify(storageData, null, 2));
  } catch (e) { console.error('存储失败:', e); }
}

// ============ Window 管理 ============
let mainWindow = null;
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.flac', '.wav', '.ape', '.m4a', '.ogg', '.wma', '.aac', '.aiff', '.alac'
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    title: '蓝韵音乐', backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

// ============ IPC ============

ipcMain.handle('select-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: '选择音乐文件夹'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('scan-folder', async (_e, folderPath, parseMeta = true) => {
  const songs = [];
  try { await scanDir(folderPath, songs, parseMeta); } catch (err) { console.error('扫描失败:', err); }
  return songs;
});

async function scanDir(dirPath, songs, parseMetaEnabled) {
  let entries;
  try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) await scanDir(fullPath, songs, parseMetaEnabled);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(ext)) {
        try {
          const fileStat = await stat(fullPath);
          let title = entry.name.replace(ext, '');
          let artist = '未知艺术家', album = '未知专辑', duration = 0, hasCover = false;
          if (parseMetaEnabled && parseFile) {
            try {
              const meta = await parseFile(fullPath, { duration: true, skipCovers: true });
              title = meta.common.title || title;
              artist = meta.common.artist || artist;
              album = meta.common.album || album;
              duration = meta.format.duration || 0;
              hasCover = !!(meta.common.picture && meta.common.picture.length > 0);
            } catch { }
          }
          songs.push({ path: fullPath, name: entry.name, title, artist, album, duration, format: ext.replace('.', '').toUpperCase(), size: fileStat.size, hasCover });
        } catch { }
      }
    }
  }
}

ipcMain.handle('parse-metadata', async (_e, filePath) => {
  if (!parseFile) return null;
  try {
    const meta = await parseFile(filePath, { duration: true, skipCovers: false });
    const common = meta.common;
    let coverBase64 = '';
    if (common.picture && common.picture.length > 0) {
      const pic = common.picture[0];
      coverBase64 = `data:${pic.format || 'image/jpeg'};base64,${Buffer.from(pic.data).toString('base64')}`;
    }
    return {
      title: common.title || '', artist: common.artist || '', album: common.album || '',
      year: common.year || '', genre: Array.isArray(common.genre) ? common.genre.join(', ') : (common.genre || ''),
      track: common.track?.no || 0, duration: meta.format.duration || 0,
      bitrate: meta.format.bitrate || 0, sampleRate: meta.format.sampleRate || 0, coverBase64
    };
  } catch { return null; }
});

ipcMain.handle('extract-cover', async (_e, filePath) => {
  if (!parseFile) return null;
  try {
    const meta = await parseFile(filePath, { skipCovers: false });
    if (meta.common.picture && meta.common.picture.length > 0) {
      const pic = meta.common.picture[0];
      const ext = (pic.format?.split('/')[1]) || 'jpg';
      const coverDir = path.join(app.getPath('userData'), 'covers');
      await mkdir(coverDir, { recursive: true });
      const hash = Math.abs(filePath.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0));
      const coverPath = path.join(coverDir, `cover_${hash}.${ext}`);
      await writeFile(coverPath, pic.data);
      return coverPath;
    }
    return null;
  } catch { return null; }
});

ipcMain.handle('read-file-buffer', async (_e, filePath) => {
  try {
    const buffer = await readFile(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } catch (err) { console.error('读取失败:', err); return null; }
});

ipcMain.handle('read-lyric-file', async (_e, audioPath) => {
  const lastSep = Math.max(audioPath.lastIndexOf('\\'), audioPath.lastIndexOf('/'));
  const dir = audioPath.substring(0, lastSep);
  const baseName = audioPath.substring(lastSep + 1, audioPath.lastIndexOf('.'));
  const lrcPath = path.join(dir, baseName + '.lrc');
  if (fs.existsSync(lrcPath)) {
    try { return await readFile(lrcPath, 'utf-8'); } catch { return null; }
  }
  return null;
});

ipcMain.handle('store-get', (_e, key) => storageData[key]);
ipcMain.handle('store-set', (_e, key, value) => { storageData[key] = value; saveStorage(); });
ipcMain.handle('store-delete', (_e, key) => { delete storageData[key]; saveStorage(); });
ipcMain.handle('get-app-path', () => app.getAppPath());
