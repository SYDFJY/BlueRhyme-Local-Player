# 🎵 蓝韵音乐 (BlueRhyme Music)

蓝韵本地音乐播放器 — 基于 Electron + Vue 3 构建的桌面音乐播放器。

## ✨ 功能特性

- 🎧 本地音乐文件播放（支持 MP3、FLAC、WAV 等格式）
- 📋 音乐库管理，支持文件夹导入
- 🎨 优雅的歌词显示窗口
- 🖼️ 自动匹配专辑封面
- ⏱️ 精确的音频时长检测（ffprobe + music-metadata 双重保障）
- 🖥️ 系统托盘支持

## 🛠️ 技术栈

- **前端**: Vue 3 + Vite + Pinia + Vue Router
- **桌面框架**: Electron
- **音频处理**: music-metadata、ffprobe

## 🚀 快速开始

### 环境要求

- Node.js 18+
- npm 或 yarn

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
# 启动 Vite 开发服务器 + Electron
npm run dev:electron
```

### 构建

```bash
# 构建前端
npm run build

# 构建 Electron 安装包
npm run build:electron
```

## 📁 项目结构

```
├── electron/          # Electron 主进程代码
│   ├── main.js        # 主进程入口
│   ├── preload.js     # 预加载脚本
│   ├── main.mjs       # 主进程模块
│   └── diag.js        # 诊断工具
├── dist/              # Vite 构建输出（需 npm run build 生成）
├── package.json       # 项目配置
└── vite.config.ts     # Vite 配置
```

## 📄 License

MIT License
