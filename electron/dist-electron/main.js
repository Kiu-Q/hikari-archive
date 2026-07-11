import { ipcMain, app, session, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
const __filename$1 = fileURLToPath(import.meta.url);
const __dirname$1 = path.dirname(__filename$1);
const isDev = process.env.NODE_ENV === "development" || !existsSync(path.join(__dirname$1, "../dist/index.html"));
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
      preload: path.join(__dirname$1, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: !isDev,
      backgroundThrottling: false
    }
  });
  if (isDev) {
    mainWindow.loadURL("http://localhost:5174/electron/index.html");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname$1, "../dist/index.html"));
  }
}
ipcMain.handle("get-window-position", () => {
  if (!mainWindow) return { x: 0, y: 0 };
  const position = mainWindow.getPosition();
  return { x: position[0], y: position[1] };
});
ipcMain.handle("set-window-position", (event, x, y) => {
  if (!mainWindow) return false;
  mainWindow.setPosition(Math.round(x), Math.round(y));
  return true;
});
ipcMain.handle("get-window-bounds", () => {
  if (!mainWindow) return { width: 0, height: 0, x: 0, y: 0 };
  const bounds = mainWindow.getBounds();
  return bounds;
});
ipcMain.handle("set-window-bounds", (event, x, y, width, height) => {
  if (!mainWindow) return false;
  mainWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(200, Math.round(width)),
    height: Math.max(300, Math.round(height))
  });
  return true;
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["ws://*/*", "wss://*/*"] },
    (details, callback) => {
      if (details.requestHeaders) {
        try {
          const url = new URL(details.url);
          details.requestHeaders["Origin"] = `${url.protocol}//${url.host}`;
        } catch (e) {
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
