import { ipcMain, app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
const __filename$1 = fileURLToPath(import.meta.url);
const __dirname$1 = path.dirname(__filename$1);
const isDev = process.env.NODE_ENV === "development" || !existsSync(path.join(__dirname$1, "../renderer/dist/index.html"));
let mainWindow = null;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 900,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
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
    mainWindow.loadFile(path.join(__dirname$1, "../renderer/dist/index.html"));
  }
}
ipcMain.handle("get-window-position", () => {
  if (!mainWindow) return { x: 0, y: 0 };
  const position = mainWindow.getPosition();
  return { x: position[0], y: position[1] };
});
ipcMain.handle("set-window-position", (event, x, y) => {
  if (!mainWindow) return false;
  mainWindow.setBounds({ x, y, width: 600, height: 900 });
  return true;
});
ipcMain.handle("get-window-bounds", () => {
  if (!mainWindow) return { width: 0, height: 0, x: 0, y: 0 };
  const bounds = mainWindow.getBounds();
  return bounds;
});
app.whenReady().then(() => {
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
