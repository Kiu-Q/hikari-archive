import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if we're in development mode
const isDev = process.env.NODE_ENV === 'development' || 
              !existsSync(path.join(__dirname, '../dist/index.html'));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 900,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !isDev,
      backgroundThrottling: false
    }
  });

  // Load the app
  if (isDev) {
    // In development, load from Vite dev server
    mainWindow.loadURL('http://localhost:5174/electron/index.html');
    mainWindow.webContents.openDevTools();
  } else {
    // In production, load from built files
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// IPC handlers for window positioning
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

// App lifecycle
app.whenReady().then(() => {
  // Override the Origin header for WebSocket connections so the OpenClaw gateway
  // doesn't reject the connection as an unauthorized origin.
  // The Electron renderer's origin is the dev server URL (e.g. http://localhost:5174)
  // in dev, or the file:// protocol in production — neither of which is on the gateway's
  // allowed-origins list by default.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      // Set Origin to match the WebSocket server's host, which the gateway accepts
      if (details.requestHeaders) {
        try {
          const url = new URL(details.url);
          details.requestHeaders['Origin'] = `${url.protocol}//${url.host}`;
        } catch (e) {
          // ignore malformed URLs
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});