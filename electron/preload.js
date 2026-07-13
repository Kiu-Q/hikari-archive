const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Window positioning APIs
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.invoke('set-window-position', x, y),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  setWindowBounds: (x, y, width, height) => ipcRenderer.invoke('set-window-bounds', x, y, width, height),
  setIgnoreMouseEvents: (ignore, forward = true) => ipcRenderer.invoke('set-ignore-mouse-events', ignore, forward),
});
