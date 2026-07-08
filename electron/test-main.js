const electron = require('electron');
console.log('Type:', typeof electron);
console.log('Has app:', typeof electron === 'object' && !!electron.app);
if (typeof electron === 'object' && electron.app) {
  const { app, BrowserWindow } = electron;
  console.log('SUCCESS! process.type:', process.type);
  app.whenReady().then(() => {
    console.log('App ready, creating window...');
    const win = new BrowserWindow({ width: 600, height: 400, title: 'Test' });
    win.loadURL('data:text/html,<h1 style="color:blue;text-align:center;padding:100px">OK!</h1>');
  });
}
