// 诊断 Electron 运行时环境
console.log('=== Electron 运行时诊断 ===');
console.log('process.type:', process.type);
console.log('process.versions:', JSON.stringify(process.versions, null, 2));
console.log('process.versions.electron:', process.versions.electron);

// 尝试不同的 require 路径
const attempts = ['electron', 'electron/main', 'electron/common', 'electron/renderer', '@electron/remote'];
for (const name of attempts) {
  try {
    const m = require(name);
    console.log(`require('${name}'):`, typeof m, Object.keys(m).slice(0, 5));
  } catch (e) {
    console.log(`require('${name}'): FAILED -`, e.message);
  }
}

// 查看可用的内置模块
try {
  const builtins = require('module').builtinModules;
  const electronBuiltins = builtins.filter(b => b.includes('electron') || b.includes('_'));
  console.log('Electron-related builtins:', electronBuiltins);
} catch (e) {
  console.log('builtinModules error:', e.message);
}

// 检查 process 上的特殊方法
const specialKeys = Object.keys(process).filter(k => k.startsWith('_') || k.includes('electron'));
console.log('Special process keys:', specialKeys);
