const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  screenCapture: {
    capture: () => ipcRenderer.invoke('screen:capture'),
    openPermissionSettings: () => ipcRenderer.invoke('awareness:request-screen-capture'),
  },
  tts: {
    synthesize: (input) => ipcRenderer.invoke('tts:synthesize', input),
  },
  replyAudio: {
    begin: (options) => ipcRenderer.invoke('audio:begin-reply', options),
    end: (sessionId) => ipcRenderer.invoke('audio:end-reply', sessionId),
  },
  musicBeat: {
    setEnabled: enabled => ipcRenderer.invoke('music-beat:set-enabled', enabled),
    openPermissionSettings: () => ipcRenderer.invoke('music-beat:open-permission'),
    onSignal: callback => {
      if (typeof callback !== 'function') throw new TypeError('musicBeat.onSignal requires a callback');
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('music-beat:signal', listener);
      return () => ipcRenderer.removeListener('music-beat:signal', listener);
    },
    onStatus: callback => {
      if (typeof callback !== 'function') throw new TypeError('musicBeat.onStatus requires a callback');
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('music-beat:status', listener);
      return () => ipcRenderer.removeListener('music-beat:status', listener);
    },
  },
  worldState: {
    get: () => ipcRenderer.invoke('world-state:get'),
    onPatch: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('worldState.onPatch requires a callback');
      const listener = (_event, patch) => callback(patch);
      ipcRenderer.on('world-state:patch', listener);
      return () => ipcRenderer.removeListener('world-state:patch', listener);
    },
    patchHikari: (hikari) => ipcRenderer.invoke('world-state:renderer-patch', { hikari }),
    patchMicrophone: (voiceActive) => ipcRenderer.invoke('world-state:renderer-patch', { audio: { microphone: { voiceActive } } })
  },
  voice: {
    setEnabled: (enabled) => ipcRenderer.invoke('voice:set-enabled', enabled),
    transcribe: (samples) => ipcRenderer.invoke('voice:transcribe', samples)
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

    getGreetingContext: () => ipcRenderer.invoke('awareness:get-greeting-context'),

    refreshStatus: () => ipcRenderer.invoke('awareness:refresh-status'),

    requestScreenCapturePermission: () => ipcRenderer.invoke('awareness:request-screen-capture'),

    requestInputMonitoringPermission: () => ipcRenderer.invoke('awareness:request-input-monitoring'),

    requestSnapshot: (candidateId) => {
      if (typeof candidateId !== 'string' || candidateId.trim().length === 0) {
        throw new TypeError('awareness.requestSnapshot requires a non-empty candidate ID');
      }
      return ipcRenderer.invoke('awareness:request-snapshot', candidateId);
    },

    captureScreen: () => ipcRenderer.invoke('awareness:capture-screen'),

    noteDirectInteraction: () => {
      ipcRenderer.send('awareness:direct-interaction');
    },
  },
});
