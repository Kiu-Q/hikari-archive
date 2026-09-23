import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { DesktopAwarenessService } from './desktop-awareness-main.js';
import { awarenessConfig } from './awareness-config.js';
import { createLocalTtsService } from './local-tts-main.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if we're in development mode
const isDev = process.env.NODE_ENV === 'development' || 
              !existsSync(path.join(__dirname, '../dist/index.html'));

let mainWindow = null;
let awarenessService = null;
let localTtsService = null;

function getLocalTtsService() {
  if (!localTtsService) {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'companion-tts')]
      : [path.join(app.getAppPath(), 'tools/companion-tts'),
         path.resolve(__dirname, '../tools/companion-tts'),
         path.resolve(__dirname, '../../tools/companion-tts')];
    const toolDir = process.env.HIKARI_TTS_TOOL_DIR || candidates.find(
      directory => existsSync(path.join(directory, 'tts.py'))
    ) || candidates[0];
    localTtsService = createLocalTtsService({ toolDir });
  }
  return localTtsService;
}

function isMainRenderer(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function createAwarenessService() {
  if (awarenessService) return awarenessService;
  awarenessService = new DesktopAwarenessService({
    getHikariBounds: () => (
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null
    ),
    emitCandidate: (candidate) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('awareness:candidate', candidate);
      }
    }
  });
  return awarenessService;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 900,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    webPreferences: {
      preload: existsSync(path.join(__dirname, 'preload.js'))
        ? path.join(__dirname, 'preload.js')
        : path.resolve(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !isDev,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  // Load the app
  if (isDev) {
    // In development, load from Vite dev server
    mainWindow.loadURL('http://localhost:5174/electron/index.html');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // In production, load from built files
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.once('closed', () => {
    awarenessService?.stop();
    localTtsService?.dispose();
    localTtsService = null;
    mainWindow = null;
  });
}

// IPC handlers for window positioning
ipcMain.handle('tts:synthesize', async (event, input) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid voice request');
  return getLocalTtsService().synthesize(input);
});

ipcMain.handle('get-window-position', () => {
  if (!mainWindow) return { x: 0, y: 0 };
  const position = mainWindow.getPosition();
  return { x: position[0], y: position[1] };
});

ipcMain.handle('set-window-position', (event, x, y) => {
  if (!mainWindow) return false;
  // Use setPosition to preserve current window size (which may differ from 600x900 due to zoom)
  mainWindow.setPosition(Math.round(x), Math.round(y));
  return true;
});

ipcMain.handle('get-window-bounds', () => {
  if (!mainWindow) return { width: 0, height: 0, x: 0, y: 0 };
  const bounds = mainWindow.getBounds();
  return bounds;
});

ipcMain.handle('set-window-bounds', (event, x, y, width, height) => {
  if (!mainWindow) return false;
  mainWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(200, Math.round(width)),
    height: Math.max(300, Math.round(height))
  });
  return true;
});

// IPC handler for dynamic click-through (transparent areas let clicks pass through)
ipcMain.handle('set-ignore-mouse-events', (event, ignore, forward) => {
  if (!mainWindow) return false;
  mainWindow.setIgnoreMouseEvents(ignore, { forward: forward !== false });
  return true;
});

ipcMain.handle('awareness:set-enabled', async (event, enabled) => {
  if (!isMainRenderer(event) || typeof enabled !== 'boolean') {
    throw new TypeError('Invalid desktop-awareness request');
  }
  return createAwarenessService().setEnabled(enabled);
});

ipcMain.handle('awareness:get-status', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  const service = createAwarenessService();
  return service.refreshPermissionStatus();
});

ipcMain.handle('awareness:refresh-status', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  const service = createAwarenessService();
  return service.refreshPermissionStatus();
});

ipcMain.handle('awareness:request-screen-capture', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  return createAwarenessService().requestScreenCapturePermission();
});

ipcMain.handle('awareness:request-input-monitoring', async (event) => {
  if (!isMainRenderer(event)) throw new TypeError('Invalid desktop-awareness request');
  return createAwarenessService().requestInputMonitoringPermission();
});

ipcMain.handle('awareness:request-snapshot', (event, candidateId) => {
  if (!isMainRenderer(event) || typeof candidateId !== 'string' || !candidateId.trim()) {
    throw new TypeError('Invalid desktop-awareness snapshot request');
  }
  return createAwarenessService().requestSnapshot(candidateId);
});

ipcMain.on('awareness:direct-interaction', (event) => {
  if (isMainRenderer(event)) createAwarenessService().noteDirectInteraction();
});

// App lifecycle
app.whenReady().then(() => {
  createAwarenessService();
  createWindow();

  if (awarenessConfig.enabledByDefault) {
    awarenessService.start();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  awarenessService?.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  awarenessService?.stop();
  localTtsService?.dispose();
});
