// 深度诊断：找到 Electron API
console.log('=== Electron API 发现 ===');

// 1. 查看 electron/js2c 内置模块
const builtins = require('module').builtinModules;
console.log('\n--- electron/js2c 内置模块 ---');
builtins.filter(b => b.startsWith('electron/')).forEach(b => console.log(' ', b));

// 2. 尝试加载 browser_init
console.log('\n--- 尝试加载内置模块 ---');
try {
  const browserInit = require('electron/js2c/browser_init');
  console.log('browser_init:', Object.keys(browserInit));
} catch (e) { console.log('browser_init failed:', e.message); }

try {
  const nodeInit = require('electron/js2c/node_init');
  console.log('node_init:', Object.keys(nodeInit));
} catch (e) { console.log('node_init failed:', e.message); }

// 3. 尝试 process._linkedBinding
console.log('\n--- _linkedBinding 尝试 ---');
['electron', 'electron_common', 'electron_browser', 'electron_renderer', 'app', 'browser'].forEach(name => {
  try {
    const binding = process._linkedBinding(name);
    console.log(`_linkedBinding('${name}'):`, typeof binding, Object.keys(binding || {}));
  } catch (e) { console.log(`_linkedBinding('${name}'): FAILED -`, e.message); }
});

// 4. 检查全局变量
console.log('\n--- 全局变量 ---');
['electron', 'Electron', 'BrowserWindow', 'app'].forEach(name => {
  if (globalThis[name]) console.log(`globalThis.${name}:`, typeof globalThis[name]);
  else console.log(`globalThis.${name}: not found`);
});

// 5. 尝试不同的 require 路径
console.log('\n--- 特殊 require 路径 ---');
['electron/js2c/browser_init', 'node:electron', 'electron:main'].forEach(name => {
  try {
    const m = require(name);
    console.log(`require('${name}'):`, typeof m, Object.keys(m));
  } catch (e) { console.log(`require('${name}'):`, e.message); }
});

// 6. 在删除 node_modules/electron 后测试
// 先重命名 index.js
const fs = require('fs');
const path = require('path');
const electronPkg = path.join(__dirname, '..', 'node_modules', 'electron');
console.log('\n--- node_modules/electron 状态 ---');
console.log('exists:', fs.existsSync(electronPkg));
if (fs.existsSync(electronPkg)) {
  console.log('index.js exists:', fs.existsSync(path.join(electronPkg, 'index.js')));
  console.log('package.json exists:', fs.existsSync(path.join(electronPkg, 'package.json')));
}
