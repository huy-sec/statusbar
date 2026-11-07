const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bar', {
  onState: (cb) => {
    const handler = (_e, s) => cb(s);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  menu: () => ipcRenderer.send('menu'),
  signIn: () => ipcRenderer.send('claude:signin'),
  refreshClaude: () => ipcRenderer.send('claude:refresh'),
  open: (which) => ipcRenderer.send('open', which),
});
