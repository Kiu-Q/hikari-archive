const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  tts: {
    synthesize: (input) => ipcRenderer.invoke('tts:synthesize', input),
  },
  // Window positioning APIs
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  setWindowPosition: (x, y) => ipcRenderer.invoke('set-window-position', x, y),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  setWindowBounds: (x, y, width, height) => ipcRenderer.invoke('set-window-bounds', x, y, width, height),
  setIgnoreMouseEvents: (ignore, forward = true) => ipcRenderer.invoke('set-ignore-mouse-events', ignore, forward),

  // Desktop awareness APIs. Keep native capabilities behind explicit, narrow IPC methods.
  awareness: {
    setEnabled: (enabled) => {
      if (typeof enabled !== 'boolean') {
        throw new TypeError('awareness.setEnabled requires a boolean');
      }
      return ipcRenderer.invoke('awareness:set-enabled', enabled);
    },

    onCandidate: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('awareness.onCandidate requires a callback function');
      }

      const listener = (_event, candidate) => callback(candidate);
      ipcRenderer.on('awareness:candidate', listener);

      return () => {
        ipcRenderer.removeListener('awareness:candidate', listener);
      };
    },

    getStatus: () => ipcRenderer.invoke('awareness:get-status'),

    refreshStatus: () => ipcRenderer.invoke('awareness:refresh-status'),

    requestScreenCapturePermission: () => ipcRenderer.invoke('awareness:request-screen-capture'),

    requestInputMonitoringPermission: () => ipcRenderer.invoke('awareness:request-input-monitoring'),

    requestSnapshot: (candidateId) => {
      if (typeof candidateId !== 'string' || candidateId.trim().length === 0) {
        throw new TypeError('awareness.requestSnapshot requires a non-empty candidate ID');
      }
      return ipcRenderer.invoke('awareness:request-snapshot', candidateId);
    },

    noteDirectInteraction: () => {
      ipcRenderer.send('awareness:direct-interaction');
    },
  },
});
